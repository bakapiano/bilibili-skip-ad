import { test } from "node:test";
import assert from "node:assert/strict";
import { AnalysisService } from "../../extension/lib/service.js";
import { SharedClient } from "../../extension/lib/providers.js";
import { AppError, cacheKey } from "../../extension/lib/core.js";
import { context, labels, ref, defaults, database, deferred } from "./fixtures.js";

async function fixture(overrides = {}) {
  const ctx = await context(), db = database(), count = { model: 0, bili: 0, shared: 0 };
  const service = new AnalysisService({ db, bili: { load: async () => { count.bili++; return ctx; } },
    model: { analyze: async () => { count.model++; return { labels: labels(ctx), usage: { promptTokens: 1000 }, elapsedMs: 123 }; } },
    shared: { lookup: async () => { count.shared++; return null; } }, settings: async () => ({ ...defaults }), ...overrides });
  return { ctx, db, service, count };
}
test("IndexedDB CRUD, interrupted job recovery and bounded event history", async () => {
  const db = database(); await db.put("jobs", { route: "route", status: "running", usage: { promptTokens: 99 } });
  await db.recoverJobs(); const job = await db.get("jobs", "route");
  assert.equal(job.status, "error"); assert.equal(job.stage, "interrupted"); assert.equal(job.usage.promptTokens, 99);
  for (let i = 0; i < 205; i++) await db.log({ type: i % 2 ? "cache-hit" : "api-call" });
  assert.equal((await db.all("events")).length, 200);
  await db.put("records", { key: "k" }); assert.equal((await db.stats()).records, 1);
  await db.remove("records", "k"); assert.equal((await db.stats()).records, 0);
  await db.put("outbox", { id: "x", status: "pending" }); assert.equal((await db.stats()).pendingUploads, 1);
  await db.clearRecords(); assert.equal((await db.stats()).pendingUploads, 0); assert.equal((await db.all("events")).length, 200);
});
test("first analysis persists result; reload and non-forced analysis use zero extra model calls", async () => {
  const { service, count, db } = await fixture();
  const first = await service.analyze(ref); assert.equal(first.record.source, "deepseek"); assert.equal(count.model, 1);
  const second = await service.prepare(ref); assert.equal(second.record.source, "local-cache");
  const third = await service.analyze(ref); assert.equal(third.job.stage, "cached");
  assert.equal(count.model, 1); assert.equal(count.shared, 0); assert.equal((await db.stats()).apiCalls, 1);
  assert.equal((await db.stats()).cacheHits, 2);
  assert.equal(count.bili, 2, "reload checks metadata and subtitles afresh");
  assert.deepEqual(first.metrics, { apiCalls: 1, cacheHits: 0 });
  assert.deepEqual(third.metrics, { apiCalls: 1, cacheHits: 2 });
  await db.log({ type: "api-call", route: "unrelated-video" });
  assert.equal((await service.prepare(ref)).metrics.apiCalls, 1);
});
test("same-video requests share one in-flight job and another video receives BUSY", async () => {
  const gate = deferred(), started = deferred(), ctx = await context(); let calls = 0;
  const { service } = await fixture({ model: { analyze: async () => { calls++; started.resolve(); await gate.promise; return { labels: labels(ctx) }; } } });
  const a = service.analyze(ref), b = service.analyze(ref); assert.equal(a, b);
  await started.promise;
  await assert.rejects(service.analyze({ ...ref, page: 2 }), { code: "BUSY" });
  gate.resolve(); await Promise.all([a, b]); assert.equal(calls, 1); assert.equal(service.busy, null);
});
test("context loads deduplicate independently", async () => {
  const gate = deferred(), ctx = await context(); let calls = 0;
  const { service } = await fixture({ bili: { load: async () => { calls++; await gate.promise; return ctx; } } });
  const a = service.load(ref), b = service.load(ref); gate.resolve(); await Promise.all([a, b]); assert.equal(calls, 1);
});
test("failed forced analysis retains old cache and records billed error usage", async () => {
  const { service, db, ctx } = await fixture(); await service.analyze(ref);
  const before = await db.get("records", cacheKey(ctx));
  service.model = { analyze: async () => { throw new AppError("OUTPUT", "合成错误", { usage: { promptTokens: 99 } }); } };
  await assert.rejects(service.analyze(ref, { force: true }), { code: "OUTPUT" });
  assert.deepEqual(await db.get("records", cacheKey(ctx)), before);
  const job = await db.get("jobs", service.route(ref)); assert.equal(job.status, "error"); assert.equal(job.usage.promptTokens, 99);
  assert.equal((await db.stats()).apiCalls, 2);
});
test("consent and automatic-analysis setting gate model access", async () => {
  for (const settings of [{ ...defaults, consent: false }, { ...defaults, apiKey: "" }, { ...defaults, autoAnalyze: false }]) {
    const { service, count, db } = await fixture({ settings: async () => settings });
    await assert.rejects(service.analyze(ref, { automatic: true })); assert.equal(count.model, 0); assert.equal((await db.stats()).apiCalls, 0);
  }
});
test("changed transcript cannot consume stale cache, and cached boundaries are rederived", async () => {
  const { service, db, ctx, count } = await fixture(); await service.analyze(ref);
  const record = await db.get("records", cacheKey(ctx)); record.segments[0].end = 90; record.video.duration = 1;
  await db.put("records", record);
  const cached = await service.prepare(ref); assert.equal(cached.record.segments[0].end, 20); assert.equal(cached.record.video.duration, 100);
  const other = { ...ctx, transcript_sha256: "a".repeat(64) };
  service.bili.load = async () => other;
  assert.equal((await service.prepare(ref)).record, null); assert.equal(count.model, 1);
});
test("shared hit becomes local cache and shared failure allows explicit local analysis", async () => {
  const ctx = await context();
  const hit = await fixture({ settings: async () => ({ ...defaults, sharedRead: true }), shared: { lookup: async () => labels(ctx) } });
  assert.equal((await hit.service.analyze(ref)).record.source, "shared"); assert.equal(hit.count.model, 0);
  assert.equal((await hit.service.prepare(ref)).record.source, "local-cache");
  const failed = await fixture({ settings: async () => ({ ...defaults, sharedRead: true }), shared: { lookup: async () => { throw new AppError("SHARED_NETWORK", "共享服务暂时不可用"); } } });
  assert.match((await failed.service.prepare(ref)).warning, /共享服务/);
  assert.equal((await failed.service.analyze(ref)).record.source, "deepseek"); assert.equal(failed.count.model, 1);
});
test("outbox retries keep idempotency and confirmed submissions are reused", async () => {
  const shared = new SharedClient(), { service, db } = await fixture({ shared, settings: async () => ({ ...defaults, sharedUpload: true, sharedBaseUrl: "https://cache.example.com" }) });
  const result = await service.analyze(ref); let calls = 0;
  shared.upload = async () => { calls++; if (calls === 1) throw new AppError("SHARED_NETWORK", "暂时不可用"); return { schema_version: 1, status: "pending", submission_id: "one" }; };
  await assert.rejects(service.upload(result.record.key));
  const failed = (await db.all("outbox"))[0]; assert.equal(failed.status, "error");
  assert.equal((await service.upload(result.record.key)).submission_id, "one");
  assert.equal((await db.all("outbox"))[0].id, failed.id);
  await service.upload(result.record.key); assert.equal(calls, 2);
});
test("changing shared servers keeps separate receipts and stable per-payload HTTP keys", async () => {
  const shared = new SharedClient(); let origin = "https://a.example.com";
  const { service, db } = await fixture({ shared, settings: async () => ({ ...defaults, sharedUpload: true, sharedBaseUrl: origin }) });
  const result = await service.analyze(ref), calls = [];
  shared.upload = async (candidate, settings) => {
    calls.push({ key: candidate.id, origin: settings.sharedBaseUrl });
    return { schema_version: 1, status: "pending", submission_id: settings.sharedBaseUrl };
  };
  assert.equal((await service.upload(result.record.key)).submission_id, "https://a.example.com");
  origin = "https://b.example.com";
  assert.equal((await service.upload(result.record.key)).submission_id, "https://b.example.com");
  assert.equal(calls.length, 2); assert.equal(calls[0].key, calls[1].key);
  assert.equal((await db.all("outbox")).length, 2);
  origin = "https://a.example.com";
  assert.equal((await service.upload(result.record.key)).submission_id, "https://a.example.com");
  assert.equal(calls.length, 2);
});
