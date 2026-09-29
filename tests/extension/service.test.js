import { test } from "node:test";
import assert from "node:assert/strict";
import { AnalysisService } from "../../extension/lib/service.js";
import { SharedClient } from "../../extension/lib/providers.js";
import { AppError, cacheKey } from "../../extension/lib/core.js";
import { context, labels, ref, defaults, database, deferred, json } from "./fixtures.js";

async function fixture(overrides = {}) {
  const ctx = await context();
  const db = database();
  const count = { model: 0, bili: 0, shared: 0 };
  const service = new AnalysisService({
    db,
    bili: {
      load: async () => {
        count.bili++;
        return ctx;
      },
    },
    model: {
      analyze: async () => {
        count.model++;
        return { labels: labels(ctx), usage: { promptTokens: 1000 }, elapsedMs: 123 };
      },
    },
    shared: {
      lookup: async () => {
        count.shared++;
        return null;
      },
    },
    settings: async () => ({ ...defaults }),
    ...overrides,
  });
  return { ctx, db, service, count };
}

async function uploadFixture(overrides = {}) {
  const settings = { ...defaults, sharedUpload: true, autoUpload: true };
  const requests = [];
  const shared = new SharedClient(
    async (url, init) => {
      requests.push({ url, init });
      return json({ schema_version: 1, status: "accepted", submission_id: "test-receipt" });
    },
    async () => true,
  );
  const f = await fixture({ shared, settings: async () => settings, ...overrides });
  return { ...f, settings, requests, shared };
}

test("new analysis automatically uploads once after local save and reuses its receipt", async () => {
  const f = await uploadFixture();
  f.service.notify = (_route, { job }) => {
    if (job?.stage === "upload") {
      assert.equal(job.status, "running");
    }
  };
  const originalUpload = f.shared.upload.bind(f.shared);
  f.shared.upload = async (candidate, settings) => {
    assert.ok(await f.db.get("records", candidate.recordKey), "local result is already persisted");
    return originalUpload(candidate, settings);
  };
  const result = await f.service.analyze(ref);
  assert.equal(result.job.status, "done");
  assert.equal(result.record.source, "deepseek");
  assert.match(result.notice, /已自动上传/);
  assert.equal(result.warning, "");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].init.method, "POST");
  assert.equal(f.requests[0].init.credentials, "omit");
  assert.equal(new URL(f.requests[0].url).pathname, "/v1/candidates");
  assert.equal(f.requests[0].init.body.includes(defaults.apiKey), false);
  const row = (await f.db.all("outbox"))[0];
  assert.equal(row.status, "sent");
  assert.equal(row.receipt.submission_id, "test-receipt");
  await f.service.prepare(ref);
  await f.service.analyze(ref);
  await f.service.upload(result.record.key);
  assert.equal(f.requests.length, 1, "cache hits and confirmed manual resubmits reuse state");
  assert.equal(f.count.model, 1);
});

test("automatic-upload opt-out keeps manual upload and the master opt-out gates both", async () => {
  const f = await uploadFixture();
  f.settings.autoUpload = false;
  const result = await f.service.analyze(ref);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.db.all("outbox")).length, 0);
  assert.equal(result.warning, "");
  await f.service.upload(result.record.key);
  assert.equal(f.requests.length, 1);

  const disabled = await uploadFixture();
  disabled.settings.sharedUpload = false;
  const local = await disabled.service.analyze(ref);
  assert.equal(disabled.requests.length, 0);
  await assert.rejects(disabled.service.upload(local.record.key), { code: "SHARED_DISABLED" });
});

test("cache-only analysis and page preparation keep automatic upload dormant", async () => {
  const f = await uploadFixture();
  f.settings.sharedRead = true;
  f.shared.lookup = async () => labels(f.ctx);
  assert.equal((await f.service.analyze(ref)).record.source, "shared");
  assert.equal((await f.service.prepare(ref)).record.source, "local-cache");
  assert.equal(f.requests.length, 0);
  assert.equal(f.count.model, 0);
  assert.equal((await f.db.all("outbox")).length, 0);
});

test("automatic upload includes a successfully validated zero-ad result", async () => {
  const f = await uploadFixture();
  f.service.model.analyze = async () => ({ labels: { ...labels(f.ctx), segments: [] } });
  const result = await f.service.analyze(ref);
  assert.equal(result.record.segments.length, 0);
  assert.deepEqual(JSON.parse(f.requests[0].init.body).segments, []);
});

test("automatic-upload failures keep analysis successful with one attempt and a manual retry", async (t) => {
  for (const status of [429, 409, 503]) {
    await t.test(`HTTP ${status}`, async () => {
      const f = await uploadFixture();
      let attempts = 0;
      const sentKeys = [];
      f.shared.fetcher = async (_url, init) => {
        sentKeys.push(init.headers["Idempotency-Key"]);
        attempts++;
        return attempts === 1
          ? json({ error: "synthetic" }, { status })
          : json({ schema_version: 1, status: "accepted", submission_id: "retry-receipt" });
      };
      const result = await f.service.analyze(ref);
      assert.equal(result.job.status, "done");
      assert.equal(result.record.segments.length, 1);
      assert.match(result.warning, /已保存在本地.*自动上传暂未完成/);
      assert.equal(attempts, 1);
      assert.equal((await f.db.all("outbox"))[0].status, "error");
      assert.equal((await f.service.prepare(ref)).record.source, "local-cache");
      await f.service.upload(result.record.key);
      assert.equal(attempts, 2);
      assert.equal(sentKeys[0], sentKeys[1]);
      assert.equal((await f.db.all("outbox"))[0].status, "sent");
      assert.equal(f.count.model, 1);
      assert.equal(
        (await f.db.all("events")).some((row) => row.type === "analysis-error"),
        false,
      );
    });
  }
});

test("missing host permission preserves the local analysis and a safe upload warning", async () => {
  const f = await uploadFixture();
  f.shared.hasPermission = async () => false;
  const result = await f.service.analyze(ref);
  assert.equal(result.job.status, "done");
  assert.match(result.warning, /共享域名授权/);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.db.all("outbox"))[0].error.code, "SHARED_PERMISSION");
});

test("failed or invalid model output leaves automatic upload dormant", async () => {
  for (const invalid of [false, true]) {
    const f = await uploadFixture();
    f.service.model.analyze = async () => {
      if (invalid) {
        return { labels: { ...labels(f.ctx), transcript_sha256: "a".repeat(64) } };
      }
      throw new AppError("OUTPUT", "合成模型错误");
    };
    await assert.rejects(f.service.analyze(ref));
    assert.equal(f.requests.length, 0);
    assert.equal((await f.db.all("outbox")).length, 0);
  }
});

test("settings changed during analysis are rechecked before automatic upload", async () => {
  for (const key of ["autoUpload", "sharedUpload"]) {
    const f = await uploadFixture();
    const gate = deferred();
    const started = deferred();
    f.service.model.analyze = async () => {
      started.resolve();
      await gate.promise;
      return { labels: labels(f.ctx) };
    };
    const task = f.service.analyze(ref);
    assert.equal(f.service.analyze(ref), task);
    await started.promise;
    f.settings[key] = false;
    gate.resolve();
    assert.equal((await task).job.status, "done");
    assert.equal(f.requests.length, 0);
  }
  const f = await uploadFixture();
  f.service.notify = (_route, { job }) => {
    if (job?.stage === "upload") {
      f.settings.autoUpload = false;
    }
  };
  const result = await f.service.analyze(ref);
  assert.equal(result.job.status, "done");
  assert.equal(f.requests.length, 0);
  assert.equal(result.warning, "");
  assert.equal(result.notice.includes("已自动上传"), false);
});

test("explicit online refresh queries the server even with a local record and keeps identical undo identity", async () => {
  const ctx = await context();
  const settings = { ...defaults, sharedRead: true };
  let remote = null;
  let requests = 0;
  const f = await fixture({
    settings: async () => settings,
    shared: {
      lookup: async () => {
        requests++;
        return remote;
      },
    },
  });
  const first = await f.service.analyze(ref);
  remote = labels(ctx);
  const before = requests;
  assert.equal((await f.service.prepare(ref)).record.source, "local-cache");
  assert.equal(requests, before);
  const online = await f.service.prepare(ref, { preferShared: true });
  assert.equal(online.record.source, "shared");
  assert.equal(online.record.createdAt, first.record.createdAt);
  assert.equal(requests, before + 1);
  assert.equal(f.count.model, 1);
  assert.equal((await f.db.all("events")).filter((row) => row.type === "shared-hit").length, 1);
  settings.sharedRead = false;
  assert.equal((await f.service.prepare(ref, { preferShared: true })).record.source, "local-cache");
  assert.equal(requests, before + 1);
});

test("online refresh keeps a valid local result on miss or service failure", async () => {
  const f = await fixture({ settings: async () => ({ ...defaults, sharedRead: true }) });
  const first = await f.service.analyze(ref);
  const miss = await f.service.prepare(ref, { preferShared: true });
  assert.equal(miss.record.createdAt, first.record.createdAt);
  assert.match(miss.warning, /线上暂无/);
  f.service.shared.lookup = async () => {
    throw new AppError("SHARED_NETWORK", "服务暂时不可用");
  };
  const failed = await f.service.prepare(ref, { preferShared: true });
  assert.equal(failed.record.source, "local-cache");
  assert.equal(failed.record.createdAt, first.record.createdAt);
  assert.match(failed.warning, /服务暂时不可用/);
  assert.equal(f.count.model, 1);
});
test("IndexedDB CRUD, interrupted job recovery and bounded event history", async () => {
  const db = database();
  await db.put("jobs", { route: "route", status: "running", usage: { promptTokens: 99 } });
  await db.recoverJobs();
  const job = await db.get("jobs", "route");
  assert.equal(job.status, "error");
  assert.equal(job.stage, "interrupted");
  assert.equal(job.usage.promptTokens, 99);
  for (let i = 0; i < 205; i++) {
    await db.log({ type: i % 2 ? "cache-hit" : "api-call" });
  }
  assert.equal((await db.all("events")).length, 200);
  await db.put("records", { key: "k" });
  assert.equal((await db.stats()).records, 1);
  await db.remove("records", "k");
  assert.equal((await db.stats()).records, 0);
  await db.put("outbox", { id: "x", status: "pending" });
  assert.equal((await db.stats()).pendingUploads, 1);
  await db.clearRecords();
  assert.equal((await db.stats()).pendingUploads, 0);
  assert.equal((await db.all("events")).length, 200);
});
test("first analysis persists result; reload and non-forced analysis use zero extra model calls", async () => {
  const { service, count, db } = await fixture();
  const first = await service.analyze(ref);
  assert.equal(first.record.source, "deepseek");
  assert.equal(count.model, 1);
  const second = await service.prepare(ref);
  assert.equal(second.record.source, "local-cache");
  const third = await service.analyze(ref);
  assert.equal(third.job.stage, "cached");
  assert.equal(count.model, 1);
  assert.equal(count.shared, 0);
  assert.equal((await db.stats()).apiCalls, 1);
  assert.equal((await db.stats()).cacheHits, 2);
  assert.equal(count.bili, 2, "reload checks metadata and subtitles afresh");
  assert.deepEqual(first.metrics, { apiCalls: 1, cacheHits: 0 });
  assert.deepEqual(third.metrics, { apiCalls: 1, cacheHits: 2 });
  await db.log({ type: "api-call", route: "unrelated-video" });
  assert.equal((await service.prepare(ref)).metrics.apiCalls, 1);
});
test("same-video requests share one in-flight job and another video receives BUSY", async () => {
  const gate = deferred();
  const started = deferred();
  const ctx = await context();
  let calls = 0;
  const { service } = await fixture({
    model: {
      analyze: async () => {
        calls++;
        started.resolve();
        await gate.promise;
        return { labels: labels(ctx) };
      },
    },
  });
  const a = service.analyze(ref);
  const b = service.analyze(ref);
  assert.equal(a, b);
  await started.promise;
  await assert.rejects(service.analyze({ ...ref, page: 2 }), { code: "BUSY" });
  gate.resolve();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(service.busy, null);
});
test("context loads deduplicate independently", async () => {
  const gate = deferred();
  const ctx = await context();
  let calls = 0;
  const { service } = await fixture({
    bili: {
      load: async () => {
        calls++;
        await gate.promise;
        return ctx;
      },
    },
  });
  const a = service.load(ref);
  const b = service.load(ref);
  gate.resolve();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
});
test("failed forced analysis retains old cache and records billed error usage", async () => {
  const { service, db, ctx } = await fixture();
  await service.analyze(ref);
  const before = await db.get("records", cacheKey(ctx));
  service.model = {
    analyze: async () => {
      throw new AppError("OUTPUT", "合成错误", { usage: { promptTokens: 99 } });
    },
  };
  await assert.rejects(service.analyze(ref, { force: true }), { code: "OUTPUT" });
  assert.deepEqual(await db.get("records", cacheKey(ctx)), before);
  const job = await db.get("jobs", service.route(ref));
  assert.equal(job.status, "error");
  assert.equal(job.usage.promptTokens, 99);
  assert.equal((await db.stats()).apiCalls, 2);
});
test("consent and automatic-analysis setting gate model access", async () => {
  for (const settings of [
    { ...defaults, consent: false },
    { ...defaults, apiKey: "" },
    { ...defaults, autoAnalyze: false },
  ]) {
    const { service, count, db } = await fixture({ settings: async () => settings });
    await assert.rejects(service.analyze(ref, { automatic: true }));
    assert.equal(count.model, 0);
    assert.equal((await db.stats()).apiCalls, 0);
  }
});
test("changed transcript cannot consume stale cache, and cached boundaries are rederived", async () => {
  const { service, db, ctx, count } = await fixture();
  await service.analyze(ref);
  const record = await db.get("records", cacheKey(ctx));
  record.segments[0].end = 90;
  record.video.duration = 1;
  await db.put("records", record);
  const cached = await service.prepare(ref);
  assert.equal(cached.record.segments[0].end, 20);
  assert.equal(cached.record.video.duration, 100);
  const other = { ...ctx, transcript_sha256: "a".repeat(64) };
  service.bili.load = async () => other;
  assert.equal((await service.prepare(ref)).record, null);
  assert.equal(count.model, 1);
});
test("shared hit becomes local cache and shared failure allows explicit local analysis", async () => {
  const ctx = await context();
  const hit = await fixture({
    settings: async () => ({ ...defaults, sharedRead: true }),
    shared: { lookup: async () => labels(ctx) },
  });
  assert.equal((await hit.service.analyze(ref)).record.source, "shared");
  assert.equal(hit.count.model, 0);
  assert.equal((await hit.service.prepare(ref)).record.source, "local-cache");
  const failed = await fixture({
    settings: async () => ({ ...defaults, sharedRead: true }),
    shared: {
      lookup: async () => {
        throw new AppError("SHARED_NETWORK", "共享服务暂时不可用");
      },
    },
  });
  assert.match((await failed.service.prepare(ref)).warning, /共享服务/);
  assert.equal((await failed.service.analyze(ref)).record.source, "deepseek");
  assert.equal(failed.count.model, 1);
});
test("outbox retries keep idempotency and confirmed submissions are reused", async () => {
  const shared = new SharedClient();
  const { service, db } = await fixture({
    shared,
    settings: async () => ({
      ...defaults,
      sharedUpload: true,
      sharedBaseUrl: "https://cache.example.com",
    }),
  });
  const result = await service.analyze(ref);
  let calls = 0;
  shared.upload = async () => {
    calls++;
    if (calls === 1) {
      throw new AppError("SHARED_NETWORK", "暂时不可用");
    }
    return { schema_version: 1, status: "pending", submission_id: "one" };
  };
  await assert.rejects(service.upload(result.record.key));
  const failed = (await db.all("outbox"))[0];
  assert.equal(failed.status, "error");
  assert.equal((await service.upload(result.record.key)).submission_id, "one");
  assert.equal((await db.all("outbox"))[0].id, failed.id);
  await service.upload(result.record.key);
  assert.equal(calls, 2);
});
test("changing shared servers keeps separate receipts and stable per-payload HTTP keys", async () => {
  const shared = new SharedClient();
  let origin = "https://a.example.com";
  const { service, db } = await fixture({
    shared,
    settings: async () => ({ ...defaults, sharedUpload: true, sharedBaseUrl: origin }),
  });
  const result = await service.analyze(ref);
  const calls = [];
  shared.upload = async (candidate, settings) => {
    calls.push({ key: candidate.id, origin: settings.sharedBaseUrl });
    return { schema_version: 1, status: "pending", submission_id: settings.sharedBaseUrl };
  };
  assert.equal((await service.upload(result.record.key)).submission_id, "https://a.example.com");
  origin = "https://b.example.com";
  assert.equal((await service.upload(result.record.key)).submission_id, "https://b.example.com");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].key, calls[1].key);
  assert.equal((await db.all("outbox")).length, 2);
  origin = "https://a.example.com";
  assert.equal((await service.upload(result.record.key)).submission_id, "https://a.example.com");
  assert.equal(calls.length, 2);
});
