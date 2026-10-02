import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import {
  LabData,
  importSnapshot,
  attachTranscript,
  intervalDiff,
  sampleSummary,
  packageDataset,
} from "../data.js";
import { parseCommunity, fetchCommunity, communityUrl } from "../community.js";
import { LabRunner, sampleInput, validateRunOptions } from "../runner.js";
import { prepareData } from "../prepare.js";
import { compareRuns } from "../metrics.js";
import { createLabServer } from "../server.js";
import { context, labels, usage, pipeOutput } from "../../tests/extension/fixtures.js";
import { validateLabels } from "../../extension/lib/core.js";
import { SharedClient } from "../../extension/lib/providers.js";
import { INSTRUCTIONS, MODEL, PROMPT_VERSION } from "../../extension/lib/constants.js";

async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/prompt-lab-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = await context();
  const output = labels(ctx);
  const candidate = await new SharedClient().candidate({
    key: "synthetic",
    video: ctx.video,
    transcript_sha256: ctx.transcript_sha256,
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    labels: output,
    ...validateLabels(ctx, output),
  });
  const id = "00000000-0000-4000-8000-000000000001";
  const row = {
    id,
    active: 1,
    created_at: Date.now(),
    request_hash: candidate.id,
    payload: candidate.payload,
  };
  const db = new LabData(root);
  await importSnapshot(db, {
    readOnly: true,
    capturedAt: new Date().toISOString(),
    records: [row],
  });
  const sample = await db.get(id);
  await attachTranscript(sample, ctx, { kind: "synthetic-test" });
  await db.save(sample);
  return { root, ctx, db, sample, id, row };
}
test("lab import validates model labels, separates weak labels and checks transcript identity", async (t) => {
  const f = await fixture(t);
  assert.equal(f.sample.source.reviewed, false);
  assert.equal(f.sample.transcript.status, "exact");
  assert.equal((await f.db.manifest()).count, 1);
  await assert.rejects(sampleInput({ ...f.sample, transcript: { status: "missing" } }));
  const alternate = structuredClone(f.ctx);
  alternate.cues[0].content = "changed";
  const fresh = { ...f.sample, transcript: { status: "missing" } };
  await attachTranscript(fresh, alternate, { kind: "test" });
  assert.equal(fresh.transcript.status, "alternate");
  await assert.rejects(sampleInput(fresh));
  assert.equal((await sampleInput(fresh, { allowAlternate: true })).exact, false);
  assert.equal(
    await attachTranscript(f.sample, alternate, {}),
    false,
    "preserve an exact original transcript",
  );
  const result = await importSnapshot(f.db, {
    readOnly: true,
    capturedAt: "2026-10-02",
    records: [{ ...f.row, request_hash: "wrong" }],
  });
  assert.equal(result.rejected.length, 1);
  assert.throws(() => f.db.file("../../secret"));
});
test("interval comparison unions overlap and treats empty reference as unknown", () => {
  assert.deepEqual(
    intervalDiff(
      [
        { start: 0, end: 10 },
        { start: 5, end: 15 },
      ],
      [{ start: 10, end: 20 }],
    ),
    {
      firstSeconds: 15,
      secondSeconds: 10,
      overlapSeconds: 5,
      onlyFirstSeconds: 10,
      onlySecondSeconds: 5,
      iou: 0.25,
    },
  );
  assert.equal(intervalDiff([], []).iou, null);
});
test("community read is bounded GET and distinguishes invalid CID/duration, missing, failures and non-sponsor", async (t) => {
  const f = await fixture(t);
  const segment = {
    cid: String(f.ctx.video.cid),
    UUID: "public-segment",
    category: "sponsor",
    actionType: "skip",
    segment: [10, 20],
    votes: 1,
    locked: 0,
    videoDuration: 100,
  };
  const url = new URL(communityUrl(f.ctx.video));
  assert.equal(url.hostname, "bsbsb.top");
  assert.equal(url.searchParams.get("cid"), String(f.ctx.video.cid));
  const data = parseCommunity(
    [
      segment,
      { ...segment, cid: "999" },
      { ...segment, videoDuration: 0 },
      { ...segment, videoDuration: 103 },
      { ...segment, actionType: "full", segment: [0, 0] },
    ],
    f.ctx.video,
  );
  assert.deepEqual(
    data.map((row) => row.comparable),
    [true, false, false, false, false],
  );
  assert.throws(() => parseCommunity([{ ...segment, segment: [20, 10] }], f.ctx.video));
  const loaded = await fetchCommunity(f.ctx.video, function (_url, options) {
    assert.equal(this, globalThis);
    assert.equal(options.method, "GET");
    assert.ok(options.headers["x-ext-version"]);
    assert.equal(options.headers.Authorization, undefined);
    return Promise.resolve(new Response(JSON.stringify([segment])));
  });
  assert.equal(loaded.status, "ok");
  assert.equal(
    (await fetchCommunity(f.ctx.video, async () => new Response(null, { status: 404 }))).status,
    "missing",
  );
  assert.equal(
    (await fetchCommunity(f.ctx.video, async () => new Response(null, { status: 429 }))).status,
    "error",
  );
});
test("lab runner snapshots exact requests, validates output and keeps keys out of artifacts", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const key = "synthetic-private-key-only";
  const runner = new LabRunner({
    db: f.db,
    runsRoot: path.join(f.root, "runs"),
    keyProvider: () => key,
    fetcher: async (url, options) => {
      calls.push({ url, request: JSON.parse(options.body) });
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: pipeOutput } }],
          usage,
          model: MODEL,
        }),
      );
    },
  });
  await assert.rejects(
    runner.start({ ids: [f.id], repeats: 1, prompt: INSTRUCTIONS, consent: false }),
  );
  const started = await runner.start({
    ids: [f.id],
    repeats: 2,
    prompt: "Synthetic revised prompt",
    consent: true,
  });
  await runner.active.task;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.messages[0].content, "Synthetic revised prompt");
  assert.equal(calls[0].request.thinking.type, "disabled");
  const raw = await readFile(path.join(f.root, "runs", `${started.id}.json`), "utf8");
  assert.equal(raw.includes(key), false);
  const result = JSON.parse(raw);
  assert.equal(result.status, "done");
  assert.equal(result.results[0].comparisonToBaseline.iou, 1);
  assert.equal(result.results[0].rawOutput, pipeOutput);
});

test("full-dataset JSON mode shares strict ad-only decoding and preserves charges for malformed output", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const key = "synthetic-json-batch-key";
  const runner = new LabRunner({
    db: f.db,
    runsRoot: path.join(f.root, "runs"),
    keyProvider: () => key,
    // Synthetic JSON replies exercise the production lab scheduler, not the paid model.
    fetcher: async function (_url, options) {
      assert.equal(this, globalThis);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      const request = JSON.parse(options.body);
      calls.push(request);
      const output = JSON.stringify({
        topic: "Synthetic",
        blocks: [
          {
            start: 2,
            end: 3,
            type: calls.length === 1 ? "ad" : "body",
            subject: "测试品牌",
            confidence: 0.95,
            reason: "合成推广",
          },
        ],
      });
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: output } }],
          usage,
          model: MODEL,
        }),
      );
    },
  });
  const started = await runner.start({
    ids: [f.id],
    repeats: 2,
    prompt: "Synthetic JSON prompt",
    protocol: "partition-ad-only",
    consent: true,
    concurrency: 1,
  });
  await runner.active.task;
  const raw = await readFile(path.join(f.root, "runs", `${started.id}.json`), "utf8");
  assert.equal(raw.includes(key), false);
  const result = JSON.parse(raw);
  assert.equal(result.status, "partial");
  assert.equal(result.settings.experimentalProtocol, "partition-ad-only");
  assert.equal(result.settings.max_tokens, 8192);
  assert.deepEqual(
    result.results.map((row) => row.status),
    ["done", "error"],
  );
  assert.ok(
    result.results.every(
      (row) => row.usage.outputTokens === usage.completion_tokens && row.apiCalls === 1,
    ),
  );
  assert.ok(
    calls.every(
      (request) =>
        request.messages[0].content === "Synthetic JSON prompt" &&
        request.thinking.type === "disabled" &&
        request.max_tokens === 8192 &&
        request.response_format.type === "json_object",
    ),
  );
  assert.equal(result.results[0].explanation.blocks[0].type, "ad");
  assert.equal(result.results[0].segments[0].start_id, 2);
  assert.equal(result.results[1].segments, undefined);
  assert.throws(() =>
    validateRunOptions({
      ids: [f.id],
      repeats: 1,
      prompt: "test",
      protocol: "unknown",
      consent: true,
    }),
  );
});

test("JSON batches retain cancellation, rate-limit stopping and explicit large-call confirmation", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const runner = new LabRunner({
    db: f.db,
    runsRoot: path.join(f.root, "runs"),
    keyProvider: () => "synthetic-json-key",
    fetcher: async () => {
      calls++;
      return new Response(null, { status: 429 });
    },
  });
  const started = await runner.start({
    ids: [f.id],
    repeats: 5,
    prompt: "test",
    protocol: "partition-ad-only",
    consent: true,
  });
  await runner.active.task;
  const saved = JSON.parse(await readFile(path.join(f.root, "runs", `${started.id}.json`), "utf8"));
  assert.equal(calls, 1);
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.stopReason, "HTTP 429");
  assert.throws(() =>
    validateRunOptions({
      ids: Array.from(
        { length: 21 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      ),
      repeats: 1,
      prompt: "test",
      protocol: "partition-ad-only",
      consent: true,
    }),
  );
});
test("lab serializes batches, blocks missing transcripts and cancels later paid calls", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const runner = new LabRunner({
    db: f.db,
    runsRoot: path.join(f.root, "runs"),
    keyProvider: () => "synthetic-only-key",
    fetcher: async (_url, options) =>
      new Promise((_resolve, reject) => {
        calls++;
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  });
  const options = { ids: [f.id], repeats: 5, prompt: INSTRUCTIONS, consent: true };
  const run = await runner.start(options);
  await assert.rejects(runner.start(options));
  while (!calls) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const task = runner.active.task;
  runner.cancel(run.id);
  await task;
  assert.equal(calls, 1);
  assert.equal(runner.active, null);
  const result = JSON.parse(await readFile(path.join(f.root, "runs", `${run.id}.json`), "utf8"));
  assert.equal(result.status, "cancelled");
});
test("localhost API enforces host, origin, capability and keeps secret configuration private", async (t) => {
  const f = await fixture(t);
  const server = createLabServer({
    db: f.db,
    runsRoot: path.join(f.root, "runs"),
    keyProvider: () => "synthetic-only-key",
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
  const report = await fetch(origin + "/experiments.html");
  assert.equal(report.status, 200);
  assert.match(await report.text(), /正文穿插实验/);
  assert.equal(boot.hasEnvironmentKey, true);
  assert.equal(JSON.stringify(boot).includes("synthetic-only-key"), false);
  assert.equal((await fetch(origin + "/api/cases")).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(
      origin + "/api/bootstrap",
      { headers: { Host: "attacker.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal(
    (await fetch(origin + "/api/bootstrap", { headers: { Origin: "https://evil.example" } }))
      .status,
    403,
  );
  const headers = { "x-lab-token": boot.csrf, Origin: origin, "Content-Type": "application/json" };
  const cases = await (await fetch(origin + "/api/cases", { headers })).json();
  assert.equal(cases.cases.length, 1);
  const response = await fetch(origin + "/api/prompt", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "test", prompt: "new prompt" }),
  });
  assert.equal(response.status, 201);
  assert.equal(
    (
      await fetch(origin + "/api/run", {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: [f.id], repeats: 1, prompt: INSTRUCTIONS, consent: false }),
      })
    ).status,
    400,
  );
  const traversal = await fetch(origin + "/api/case/..%2Fsecret", { headers });
  assert.equal(traversal.status, 400);
  assert.equal(
    (
      await fetch(origin + "/api/transcript", {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body: "{}",
      })
    ).status,
    403,
  );
});
test("community comparison is absent when there is no matching sponsor skip reference", async (t) => {
  const f = await fixture(t);
  f.sample.community = { status: "ok", segments: [] };
  assert.equal(sampleSummary(f.sample).comparison, null);
});

test("dataset packaging creates a JSONL snapshot with a verifiable manifest", async (t) => {
  const f = await fixture(t);
  const exported = await packageDataset(f.db);
  assert.equal(exported.records, 1);
  assert.equal(exported.exactTranscripts, 1);
  const text = await readFile(path.join(f.root, exported.file), "utf8");
  assert.equal(JSON.parse(text.trim()).id, f.id);
  assert.equal(Buffer.byteLength(text), exported.bytes);
  assert.match(exported.sha256, /^[a-f0-9]{64}$/);
});

test("preparation verifies subtitles, deduplicates cohorts and preserves local human review", async (t) => {
  const f = await fixture(t);
  const batchFile = path.join(f.root, "input.jsonl");
  const row = {
    id: "batch-row",
    bvid: f.ctx.video.bvid,
    cid: f.ctx.video.cid,
    transcript: { status: "ready", sha256: f.ctx.transcript_sha256 },
    context: f.ctx,
    community: { raw: [] },
  };
  await writeFile(
    batchFile,
    JSON.stringify(row) +
      "\n" +
      JSON.stringify({ ...row, id: "bad", transcript: { status: "ready", sha256: "wrong" } }) +
      "\n",
  );
  const db = new LabData(path.join(f.root, "prepared"));
  const options = {
    db,
    batchFile,
    legacyRoot: f.root,
    legacyRuns: path.join(f.root, "old-runs"),
    runsRoot: path.join(f.root, "new-runs"),
  };
  const report = await prepareData(options);
  assert.equal(report.uniqueInputs, 1);
  assert.equal(report.rejected.length, 1);
  const [sample] = await db.list();
  assert.deepEqual(sample.datasets, ["legacy", "community-542"]);
  assert.ok(sample.baseline);
  sample.review = { status: "complete", segments: [], note: "synthetic manual review" };
  await db.save(sample);
  await prepareData(options);
  assert.equal((await db.get(sample.id)).review.note, "synthetic manual review");
  assert.equal((await sampleInput(sample)).exact, true);
});

test("new subtitle-only samples remain pending rather than fabricated zero-ad baselines", async (t) => {
  const f = await fixture(t);
  const sample = {
    video: f.ctx.video,
    baseline: null,
    transcript: { status: "ready", context: f.ctx },
    community: { status: "pending" },
    datasets: ["community-542"],
  };
  assert.equal((await sampleInput(sample)).exact, true);
  assert.equal(sampleSummary(sample).hasBaseline, false);
  assert.equal(sampleSummary(sample).comparison, null);
});

test("large paid batches require exact call-count confirmation and bounded concurrency", () => {
  const ids = Array.from(
    { length: 21 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );
  const options = { ids, repeats: 1, consent: true, prompt: "synthetic" };
  assert.throws(() => validateRunOptions(options));
  assert.throws(() => validateRunOptions({ ...options, confirmedCalls: 20 }));
  assert.doesNotThrow(() => validateRunOptions({ ...options, confirmedCalls: 21, concurrency: 8 }));
  assert.throws(() => validateRunOptions({ ...options, confirmedCalls: 21, concurrency: 9 }));
});

test("concurrent runner pairs actual snapshots, reports metrics and flags a missed-ad regression", async (t) => {
  const f = await fixture(t);
  f.sample.review = {
    status: "complete",
    segments: f.sample.baseline.segments.map(({ start, end }) => ({ start, end })),
  };
  await f.db.save(f.sample);
  const runner = new LabRunner({
    db: f.db,
    runsRoot: path.join(f.root, "runs"),
    keyProvider: () => "synthetic-model-key",
    fetcher: async (_url, options) => {
      const prompt = JSON.parse(options.body).messages[0].content;
      return new Response(
        JSON.stringify({
          model: MODEL,
          choices: [
            {
              finish_reason: "stop",
              message: { content: prompt === "candidate" ? "NONE" : pipeOutput },
            },
          ],
          usage,
        }),
      );
    },
  });
  const reports = [];
  for (const prompt of ["baseline", "candidate"]) {
    const started = await runner.start({
      ids: [f.id],
      repeats: 3,
      prompt,
      consent: true,
      concurrency: 2,
    });
    await runner.active.task;
    const report = JSON.parse(
      await readFile(path.join(f.root, "runs", `${started.id}.json`), "utf8"),
    );
    assert.equal(report.results.length, 3);
    assert.equal(report.metrics.failed, 0);
    assert.equal(report.results[0].referenceSnapshot.kind, "human");
    reports.push(report);
  }
  const compared = compareRuns(...reports);
  assert.equal(compared.paired, 3);
  assert.equal(compared.before.meanIou, 1);
  assert.equal(compared.after.adMissRate, 1);
  assert.equal(compared.verdict, "review");
});

test("model rate-limit responses stop concurrent dispatch and preserve partial progress", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const runner = new LabRunner({
    db: f.db,
    runsRoot: path.join(f.root, "runs"),
    keyProvider: () => "synthetic-rate-key",
    fetcher: async () => {
      calls++;
      return new Response("rate limited", { status: 429 });
    },
  });
  const report = await runner.start({
    ids: [f.id],
    repeats: 5,
    prompt: "synthetic",
    consent: true,
    concurrency: 2,
  });
  await runner.active.task;
  const stored = JSON.parse(await readFile(path.join(f.root, "runs", `${report.id}.json`), "utf8"));
  assert.ok(calls <= 2);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.stopReason, "HTTP 429");
  assert.equal(stored.metrics.successful, 0);
});

test("batch execution errors retain sanitized diagnostics and a completion timestamp", async (t) => {
  const f = await fixture(t);
  const key = "synthetic-execution-key";
  const runner = new LabRunner({
    db: f.db,
    runsRoot: path.join(f.root, "runs"),
    keyProvider: () => key,
  });
  // Synthetic execution failure verifies diagnostics without calling the paid model.
  runner.execute = async () => {
    const error = new Error(`Synthetic storage failure ${key}`);
    error.code = "SYNTHETIC_IO";
    throw error;
  };
  const started = await runner.start({
    ids: [f.id],
    prompt: "synthetic",
    repeats: 1,
    consent: true,
  });
  await runner.active.task;
  const saved = await readFile(path.join(f.root, "runs", `${started.id}.json`), "utf8");
  assert.equal(saved.includes(key), false);
  const run = JSON.parse(saved);
  assert.equal(run.status, "error");
  assert.equal(run.executionErrors[0].code, "SYNTHETIC_IO");
  assert.ok(run.executionErrors[0].message.includes("[REDACTED]"));
  assert.ok(run.finishedAt);
});
