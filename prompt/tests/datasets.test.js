import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { LabData, saveJson } from "../data.js";
import {
  ExclusionStore,
  inputKey,
  datasetOverview,
  datasetRunView,
  comparisonProjection,
} from "../datasets.js";
import { compareRuns, METRIC_POLICY } from "../metrics.js";
import { LabRunner } from "../runner.js";
import { createLabServer } from "../server.js";
import { context, pipeOutput, usage } from "../../tests/extension/fixtures.js";

async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/dataset-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const db = new LabData(path.join(root, "data"));
  const ctx = await context();
  const sample = {
    id: randomUUID(),
    video: ctx.video,
    createdAt: "2026-10-02",
    baseline: null,
    transcript: { status: "ready", context: ctx },
    datasets: ["community-542", "legacy"],
    community: {
      status: "ok",
      segments: [{ segment: [10, 20], comparable: true, actionType: "skip", category: "sponsor" }],
    },
    review: null,
  };
  await db.save(sample);
  const store = new ExclusionStore(db.root);
  return { root, db, ctx, sample, store };
}

test("removal requires a reason and revision, is reversible, and preserves source samples", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.db.file(f.sample.id), "utf8");
  const initial = await f.store.read();
  await assert.rejects(
    f.store.change(f.sample, { excluded: true, reason: " ", revision: initial.revision }),
  );
  await assert.rejects(
    f.store.change(f.sample, { excluded: true, reason: "x", revision: "stale" }),
  );
  const removed = await f.store.change(f.sample, {
    excluded: true,
    reason: "社区把正文标成广告",
    revision: initial.revision,
  });
  assert.equal(removed.entries[inputKey(f.sample)].excluded, true);
  assert.equal(removed.events.length, 1);
  assert.equal(datasetOverview([f.sample], removed).find((s) => s.id === "community").active, 0);
  assert.equal(datasetOverview([f.sample], removed).find((s) => s.id === "legacy").removed, 1);
  await assert.rejects(
    f.store.change(f.sample, { excluded: false, reason: "restore", revision: initial.revision }),
  );
  const restored = await f.store.change(f.sample, {
    excluded: false,
    reason: "人工复核后恢复",
    revision: removed.revision,
  });
  assert.equal(restored.events.length, 2);
  assert.equal(restored.entries[inputKey(f.sample)].excluded, false);
  assert.equal(await readFile(f.db.file(f.sample.id), "utf8"), before);
  assert.deepEqual(await new ExclusionStore(f.db.root).read(), restored);
});

test("fixed community cohort keeps reserves separate and shares exclusion eligibility", async (t) => {
  const f = await fixture(t);
  f.sample.datasets.push("community-1000");
  const reserve = structuredClone(f.sample);
  reserve.id = randomUUID();
  reserve.datasets = ["community-expanded"];
  reserve.transcript.context.transcript_sha256 = "synthetic-reserve";
  const samples = [f.sample, reserve];
  const initial = await f.store.read();
  const before = datasetOverview(samples, initial);
  assert.equal(before.find((set) => set.id === "community").active, 2);
  assert.equal(before.find((set) => set.id === "community-1000").active, 1);
  assert.equal(before.find((set) => set.id === "community-expanded").active, 1);
  const ledger = await f.store.change(f.sample, {
    excluded: true,
    reason: "Synthetic cohort exclusion",
    revision: initial.revision,
  });
  const after = datasetOverview(samples, ledger);
  const cohort = after.find((set) => set.id === "community-1000");
  assert.equal(cohort.total, 1);
  assert.equal(cohort.active, 0);
  assert.equal(cohort.removed, 1);
  assert.equal(after.find((set) => set.id === "community").active, 1);
});

function runFor(samples, segments) {
  return {
    id: randomUUID(),
    status: "done",
    startedAt: "2026-10-02",
    repeats: 1,
    plannedCalls: samples.length,
    sampleIds: samples.map((s) => s.id),
    metricPolicy: METRIC_POLICY,
    settings: { model: "synthetic" },
    results: samples.map((s, i) => ({
      caseId: s.id,
      bvid: s.video.bvid,
      video: s.video,
      title: s.video.title,
      transcriptSha256: s.transcript.context.transcript_sha256,
      repeat: 1,
      status: "done",
      returnedModel: "synthetic",
      evaluationIdentity: `synthetic-${s.id}`,
      segments: segments[i],
      referenceSnapshot: {
        kind: "community",
        available: true,
        ranges: [{ start: 10, end: 20 }],
        preserve: [],
      },
    })),
  };
}

test("current-list projections remove identical rows from both prompts and leave raw runs intact", async (t) => {
  const f = await fixture(t);
  const other = structuredClone(f.sample);
  other.id = randomUUID();
  other.video = { ...other.video, cid: other.video.cid + 1 };
  other.transcript.context = {
    ...other.transcript.context,
    video: other.video,
    transcript_sha256: "other-hash",
  };
  const samples = [f.sample, other];
  const baseline = runFor(samples, [[{ start: 10, end: 20, confidence: 0.98 }], []]);
  const candidate = runFor(samples, [
    [{ start: 10, end: 20, confidence: 0.98 }],
    [{ start: 40, end: 50, confidence: 0.98 }],
  ]);
  const original = structuredClone(candidate);
  const ledger = await f.store.change(other, {
    excluded: true,
    reason: "测试参考错误",
    revision: (await f.store.read()).revision,
  });
  const view = datasetRunView(candidate, samples, ledger);
  assert.equal(view.results.length, 2);
  assert.equal(view.metrics.scored, 1);
  assert.equal(view.metrics.meanIou, 1);
  assert.equal(view.datasetView.removedResults, 1);
  assert.equal(view.originalMetrics.scored, 2);
  const before = datasetRunView(baseline, samples, ledger);
  const comparison = compareRuns(comparisonProjection(before), comparisonProjection(view));
  assert.equal(comparison.paired, 1);
  assert.equal(comparison.verdict, "pass");
  const failedElsewhere = structuredClone(candidate);
  failedElsewhere.status = "partial";
  failedElsewhere.results[1].status = "error";
  const sampleView = datasetRunView(failedElsewhere, samples, ledger, { caseId: f.sample.id });
  assert.equal(comparisonProjection(sampleView).status, "done");
  assert.equal(comparisonProjection(sampleView).parentStatus, "partial");
  const cancelledElsewhere = { ...failedElsewhere, status: "cancelled" };
  assert.equal(
    comparisonProjection(
      datasetRunView(cancelledElsewhere, samples, ledger, { caseId: f.sample.id }),
    ).status,
    "cancelled",
  );
  assert.equal(datasetRunView(candidate, samples, ledger, { original: true }).metrics.scored, 2);
  assert.deepEqual(candidate, original);
  const changedInput = structuredClone(candidate);
  changedInput.results[1].transcriptSha256 = "different";
  assert.equal(datasetRunView(changedInput, samples, ledger).datasetView.removedResults, 0);
  const missing = structuredClone(candidate);
  missing.results.shift();
  const missingView = datasetRunView(missing, samples, ledger);
  assert.equal(missingView.datasetView.missing, 1);
  assert.equal(
    compareRuns(comparisonProjection(before), comparisonProjection(missingView)).verdict,
    "incomplete",
  );
});

test("removed samples are rejected before paid requests and membership survives preparation", async (t) => {
  const f = await fixture(t);
  const ledger = await f.store.change(f.sample, {
    excluded: true,
    reason: "测试错误字幕",
    revision: (await f.store.read()).revision,
  });
  const runner = new LabRunner({
    db: f.db,
    runsRoot: path.join(f.root, "runs"),
    keyProvider: () => "synthetic-only-key",
    fetcher: () => assert.fail("No paid calls expected"),
  });
  await assert.rejects(
    runner.start({ ids: [f.sample.id], repeats: 1, prompt: "synthetic", consent: true }),
    /移除/,
  );
  await f.db.save(f.sample);
  assert.equal((await f.store.read()).revision, ledger.revision);
  await assert.rejects(
    runner.start({
      ids: [f.sample.id],
      repeats: 1,
      prompt: "synthetic",
      consent: true,
      datasetRevision: "stale",
    }),
    /已更新/,
  );
});

test("removal API enforces source, reason, key isolation, revision and batch freeze; re-score is read-only", async (t) => {
  const f = await fixture(t);
  const run = runFor([f.sample], [[{ start: 10, end: 20, confidence: 0.95 }]]);
  const runsRoot = path.join(f.root, "runs");
  await saveJson(path.join(runsRoot, `${run.id}.json`), run);
  const original = await readFile(path.join(runsRoot, `${run.id}.json`), "utf8");
  let calls = 0;
  const server = createLabServer({
    db: f.db,
    runsRoot,
    keyProvider: () => "synthetic-only-key",
    fetcher: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          model: "synthetic",
          choices: [{ finish_reason: "stop", message: { content: pipeOutput } }],
          usage,
        }),
      );
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const boot = await (await fetch(`${origin}/api/bootstrap`)).json();
  const headers = { Origin: origin, "x-lab-token": boot.csrf, "Content-Type": "application/json" };
  const post = (body, extra = {}) =>
    fetch(`${origin}/api/exclusion`, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  const initial = await (await fetch(`${origin}/api/cases`, { headers })).json();
  const options = {
    id: f.sample.id,
    excluded: true,
    reason: "社区标记有误",
    revision: initial.datasetRevision,
  };
  assert.equal((await post(options, { Origin: "https://foreign.example" })).status, 403);
  assert.equal((await post({ ...options, reason: " " })).status, 400);
  assert.equal((await post({ ...options, reason: "synthetic-only-key" })).status, 400);
  server.runner.active = { id: "synthetic-active-task" };
  assert.equal((await post(options)).status, 400);
  server.runner.active = null;
  const removedResponse = await post(options);
  assert.equal(removedResponse.status, 200);
  const removed = await removedResponse.json();
  assert.equal((await post(options)).status, 400);
  const current = await (
    await fetch(`${origin}/api/run/${run.id}?dataset=community`, { headers })
  ).json();
  assert.equal(current.metrics.scored, 0);
  assert.equal(current.datasetView.removedResults, 1);
  const originalView = await (
    await fetch(`${origin}/api/run/${run.id}?view=original`, { headers })
  ).json();
  assert.equal(originalView.metrics.scored, 1);
  const experiments = await (
    await fetch(`${origin}/api/case-runs/${f.sample.id}`, { headers })
  ).json();
  assert.equal(experiments.runs.length, 1);
  assert.equal(experiments.runs[0].results[0].excludedFromDataset, true);
  assert.equal(
    (
      await post({
        ...options,
        excluded: false,
        reason: "复核恢复",
        revision: removed.datasetRevision,
      })
    ).status,
    200,
  );
  assert.equal(await readFile(path.join(runsRoot, `${run.id}.json`), "utf8"), original);
  assert.equal(calls, 0);
});

test("configuration comparison API is explicit and preserves strict comparison as default", async (t) => {
  const f = await fixture(t);
  const baseline = runFor([f.sample], [[{ start: 10, end: 20, confidence: 0.95 }]]);
  const candidate = structuredClone(baseline);
  candidate.id = randomUUID();
  candidate.settings = {
    ...candidate.settings,
    max_tokens: 8192,
    experimentalProtocol: "partition-ad-only",
  };
  const runsRoot = path.join(f.root, "runs");
  await saveJson(path.join(runsRoot, `${baseline.id}.json`), baseline);
  await saveJson(path.join(runsRoot, `${candidate.id}.json`), candidate);
  const server = createLabServer({
    db: f.db,
    runsRoot,
    fetcher: async () => assert.fail("read-only comparison"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const boot = await (await fetch(origin + "/api/bootstrap")).json();
  const headers = { "x-lab-token": boot.csrf };
  const endpoint = `${origin}/api/compare?baseline=${baseline.id}&candidate=${candidate.id}&dataset=community`;
  assert.equal((await (await fetch(endpoint, { headers })).json()).paired, 0);
  const result = await (await fetch(endpoint + "&configuration=1", { headers })).json();
  assert.equal(result.kind, "configuration-comparison");
  assert.equal(result.paired, 1);
  assert.equal(result.settings.after.max_tokens, 8192);
  assert.equal(result.operational.count, 1);
  assert.equal(result.verdict, "pass");
});
