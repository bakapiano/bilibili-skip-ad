import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { sampleSummary } from "../data.js";
import { evaluateRun } from "../metrics.js";
import { annotateRun } from "../observations.js";

async function fixture(t) {
  const [html, source] = await Promise.all([
    readFile(new URL("../ui/index.html", import.meta.url), "utf8"),
    readFile(new URL("../ui/app.js", import.meta.url), "utf8"),
  ]);
  // Synthetic API fixtures exercise the real UI without model calls or local dataset writes.
  const samples = [
    { id: "boundary", scores: [0.9], status: "exact", split: "development" },
    { id: "low", scores: [0.899], status: "exact", split: "development" },
    { id: "mixed", scores: [0.95, 0.8], status: "exact", split: "holdout" },
    { id: "empty", scores: [], status: "missing", split: "holdout" },
    { id: "high", scores: [0.99], status: "missing", split: "development" },
  ].map(({ id, scores, status, split }) => ({
    id,
    split,
    baseline: {
      video: { title: id, bvid: id, page: 1, cid: 1, duration: 100 },
      model: "synthetic",
      prompt_version: "ad-cues-v5-obvious",
      segments: scores.map((confidence, index) => ({
        start: 10 + index * 20,
        end: id === "boundary" ? 70 : 20 + index * 20,
        confidence,
        brand: "fixture",
        reason: "synthetic test interval",
      })),
      labels: {},
    },
    transcript: { status },
    community: { status: "missing", segments: [] },
  }));
  const original = structuredClone(samples);
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:43820/",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const calls = [];
  dom.window.fetch = async (url, options) => {
    calls.push({ url, method: options.method });
    assert.equal(options.method, "GET");
    if (url.startsWith("/api/case-runs/")) {
      return { ok: true, json: async () => ({ runs: [] }) };
    }
    const routes = {
      "/api/bootstrap": { csrf: "synthetic-token", productionPrompt: "synthetic prompt" },
      "/api/cases": { cases: samples.map(sampleSummary) },
      "/api/prompts": { prompts: [] },
      "/api/runs": { runs: [] },
      ...Object.fromEntries(samples.map((s) => [`/api/case/${s.id}`, { sample: s, input: null }])),
    };
    assert.ok(Object.hasOwn(routes, url), `Unexpected request: ${url}`);
    return { ok: true, json: async () => structuredClone(routes[url]) };
  };
  await dom.window.eval(`(async () => {\n${source}\n})()`);
  const $ = (id) => dom.window.document.getElementById(id);
  assert.equal($("toast").textContent, "");
  const filter = (id, value) => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event(id === "search" ? "input" : "change"));
  };
  const visible = () =>
    [...dom.window.document.querySelectorAll(".case-row strong")].map((el) => el.textContent);
  return { dom, $, filter, visible, samples, original, calls };
}

test("lab score filter includes 0.90 and handles low, mixed and empty samples", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.visible(), ["boundary", "low", "mixed", "empty", "high"]);
  f.filter("score-filter", "high");
  assert.deepEqual(f.visible(), ["boundary", "mixed", "high"]);
  assert.equal(f.$("selected-count").textContent, "已选 0 / 显示 3");
  f.filter("score-filter", "low");
  assert.deepEqual(f.visible(), ["low", "mixed"]);
  f.filter("score-filter", "all");
  assert.deepEqual(f.visible(), ["boundary", "low", "mixed", "empty", "high"]);
  assert.deepEqual(f.samples, f.original);
});

test("lab score filter combines with other filters and preserves selection and full details", async (t) => {
  const f = await fixture(t);
  f.filter("score-filter", "high");
  f.filter("transcript-filter", "exact");
  assert.deepEqual(f.visible(), ["boundary", "mixed"]);
  f.filter("split-filter", "development");
  assert.deepEqual(f.visible(), ["boundary"]);
  f.filter("issue-filter", "protected");
  assert.deepEqual(f.visible(), ["boundary"]);
  f.filter("search", "mixed");
  assert.deepEqual(f.visible(), []);
  assert.match(f.$("case-list").textContent, /当前筛选下没有样本/);
  f.filter("split-filter", "all");
  f.filter("issue-filter", "all");
  assert.deepEqual(f.visible(), ["mixed"]);
  const checkbox = f.$("case-list").querySelector("input");
  checkbox.click();
  f.$("case-list").querySelector("button").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.$("sample-panel").querySelector("h2").textContent, "mixed");
  const scores = () =>
    [...f.$("sample-panel").querySelectorAll("tbody tr")].map((row) => row.lastChild.textContent);
  assert.deepEqual(scores(), ["0.95", "0.8"]);
  f.filter("score-filter", "low");
  assert.deepEqual(f.visible(), ["mixed"]);
  assert.deepEqual(scores(), ["0.95", "0.8"]);
  assert.equal(f.$("case-list").querySelector("input").checked, true);
  assert.equal(f.$("selected-count").textContent, "已选 1 / 显示 1");
  assert.deepEqual(f.samples, f.original);
  assert.ok(f.calls.every((call) => call.method === "GET"));
  assert.equal(f.$("toast").textContent, "");
});

async function resultFixture(t, workspace = "") {
  const [html, source] = await Promise.all([
    readFile(new URL("../ui/index.html", import.meta.url), "utf8"),
    readFile(new URL("../ui/app.js", import.meta.url), "utf8"),
  ]);
  const video = {
    bvid: "BV1eVaz6UENn",
    cid: 123,
    page: 1,
    title: "synthetic video",
    duration: 200,
  };
  const runId = "00000000-0000-4000-8000-000000000001";
  const run = evaluateRun({
    id: runId,
    status: "partial",
    plannedCalls: 13,
    startedAt: "2026-10-02",
    name: "Synthetic batch",
    promptSha256: "synthetic-prompt",
    results: Array.from({ length: 13 }, (_, i) => ({
      caseId: `case-${i}`,
      bvid: video.bvid,
      title: `result-${i}`,
      video,
      repeat: i + 1,
      status: i === 12 ? "error" : "done",
      baseline: null,
      segments:
        i === 12
          ? undefined
          : [{ start: 10, end: 20 + i, brand: "synthetic-brand", confidence: 0.95 }],
      error: i === 12 ? { message: "synthetic format failure" } : null,
      rawOutput: i === 12 ? "invalid-output" : `1|2|synthetic-brand|snapshot-${i}|0.95`,
      request: { messages: [{ role: "user", content: `snapshot-input-${i}` }] },
      transcriptSha256: "matching-hash",
      referenceSnapshot: {
        available: true,
        kind: "community",
        ranges: [{ start: 10, end: 20 }],
        preserve: [],
      },
      observation:
        i === 11
          ? { title: "Synthetic note", text: "<img src=x onerror=alert(1)>", basis: "Test note" }
          : null,
    })),
  });
  const sample = {
    video,
    baseline: { video, segments: [{ start: 100, end: 101 }] },
    transcript: {
      context: {
        video,
        transcript_sha256: "matching-hash",
        cues: [
          { id: 1, from: 19, to: 22, content: "nearby subtitle" },
          { id: 2, from: 23, to: 25, content: "another cue" },
        ],
      },
    },
  };
  const dom = new JSDOM(html, {
    url: `http://127.0.0.1:43820/?run=${runId}&workspace=${workspace}`,
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  // DOM-only scroll/focus substitutes let the test exercise the real result view.
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const calls = [];
  let delayed;
  dom.window.fetch = async (url, options) => {
    calls.push({ url, method: options.method });
    assert.equal(options.method, "GET");
    url = url.split("?")[0];
    const routes = {
      "/api/bootstrap": { csrf: "synthetic", productionPrompt: "synthetic" },
      "/api/cases": { cases: [] },
      "/api/prompts": { prompts: [] },
      "/api/runs": {
        runs: [
          {
            id: runId,
            startedAt: "2026-10-02",
            plannedCalls: 13,
            completed: 13,
            status: "partial",
          },
        ],
      },
      [`/api/run/${runId}`]: run,
    };
    if (url.startsWith("/api/case/")) {
      const value = structuredClone(sample);
      if (delayed) {
        return delayed(value);
      }
      return { ok: true, json: async () => ({ sample: value }) };
    }
    assert.ok(Object.hasOwn(routes, url), url);
    return { ok: true, json: async () => structuredClone(routes[url]) };
  };
  await dom.window.eval(`(async () => {\n${source}\n})()`);
  const $ = (id) => dom.window.document.getElementById(id);
  const filter = (id, value) => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event(id === "outlier-search" ? "input" : "change"));
  };
  return {
    dom,
    $,
    filter,
    run,
    sample,
    calls,
    delayWith: (fn) => {
      delayed = fn;
    },
  };
}

test("batch outlier list sorts, paginates, searches and distinguishes failures", async (t) => {
  const f = await resultFixture(t);
  assert.match(f.$("outlier-count").textContent, /13 条/);
  assert.equal(f.$("outlier-table").querySelectorAll("tbody tr").length, 10);
  assert.equal(f.$("outlier-table").querySelector("tbody strong").textContent, "result-11");
  f.$("outlier-next").click();
  assert.equal(f.$("outlier-page").textContent, "2 / 2");
  assert.equal(f.$("outlier-table").querySelectorAll("tbody tr").length, 3);
  f.filter("outlier-sort", "iou");
  assert.equal(f.$("outlier-page").textContent, "1 / 2");
  assert.equal(f.$("outlier-table").querySelector("tbody strong").textContent, "result-11");
  f.filter("outlier-filter", "error");
  assert.equal(f.$("outlier-table").querySelectorAll("tbody tr").length, 1);
  assert.match(f.$("outlier-table").textContent, /执行 \/ 格式失败/);
  f.filter("outlier-filter", "noted");
  assert.equal(f.$("outlier-table").querySelectorAll("tbody tr").length, 1);
  f.filter("outlier-search", "unmatched");
  assert.match(f.$("outlier-table").textContent, /当前筛选下没有结果/);
  assert.equal(f.$("outlier-page").textContent, "0 / 0");
  assert.equal(f.$("outlier-next").disabled, true);
});

test("top-level problem entry shows counts and reason summaries in one click, then returns from debug", async (t) => {
  const f = await resultFixture(t);
  assert.equal(f.$("issue-count").textContent, "1");
  f.filter("outlier-search", "unmatched");
  f.$("tab-issues").click();
  assert.equal(f.$("tab-issues").getAttribute("aria-pressed"), "true");
  assert.equal(f.$("tab-overview").getAttribute("aria-pressed"), "false");
  assert.equal(f.$("overview-view").hidden, false);
  assert.equal(f.$("outlier-filter").value, "noted");
  assert.equal(f.$("outlier-search").value, "");
  assert.equal(f.$("outlier-table").querySelectorAll("tbody tr").length, 1);
  assert.ok(f.$("outlier-table").querySelector(".reason-summary").textContent.includes("<img"));
  assert.equal(f.$("outlier-table").querySelector("img"), null);
  f.$("outlier-table").querySelector("tbody button").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.$("debug-view").hidden, false);
  f.$("back-to-dataset").click();
  assert.equal(f.$("tab-issues").getAttribute("aria-pressed"), "true");
  assert.equal(f.$("outlier-filter").value, "noted");
  f.$("show-all-results").click();
  assert.equal(f.$("outlier-table").querySelectorAll("tbody tr").length, 10);
  assert.equal(f.$("show-all-results").getAttribute("aria-pressed"), "true");
  f.$("show-noted").click();
  assert.equal(f.$("outlier-table").querySelectorAll("tbody tr").length, 1);
  f.$("tab-overview").click();
  assert.equal(f.$("outlier-filter").value, "all");
  assert.ok(f.calls.every((call) => call.method === "GET"));
});

test("problem entry is restored from the URL and updates for absent or excluded review notes", async (t) => {
  const f = await resultFixture(t, "issues");
  assert.equal(f.$("tab-issues").getAttribute("aria-pressed"), "true");
  assert.equal(new URL(f.dom.window.location.href).searchParams.get("workspace"), "issues");
  f.run.results[11].excludedFromDataset = true;
  f.filter("run-history", f.run.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.$("issue-count").textContent, "0");
  assert.match(f.$("outlier-table").textContent, /当前批次暂无原因标签/);
  assert.equal(f.$("outlier-next").disabled, true);
  f.$("show-all-results").click();
  assert.ok(f.$("outlier-table").querySelectorAll("tbody tr").length > 0);
});

test("outlier details use run snapshots, escape notes and verify subtitle identity", async (t) => {
  const f = await resultFixture(t);
  f.$("outlier-table").querySelector("tbody button").click();
  await new Promise((resolve) => setImmediate(resolve));
  const root = f.$("outlier-detail");
  assert.equal(root.querySelector("h3").textContent, "result-11");
  assert.ok(root.textContent.includes("snapshot-input-11"));
  assert.ok(root.textContent.includes("nearby subtitle"));
  assert.ok(root.textContent.includes("<img src=x onerror=alert(1)>"));
  assert.equal(root.querySelector("img"), null);
  assert.match(root.querySelector(".range-links").textContent, /00:10.00–00:20.00/);
  assert.ok(
    [...root.querySelectorAll(".range-links")].some((p) =>
      p.textContent.includes("00:20.00–00:31.00"),
    ),
  );
  assert.equal(new URL(root.querySelector("a").href).hostname, "www.bilibili.com");
  assert.equal(root.querySelector("tbody tr td:last-child").textContent, "0.95");
  f.sample.transcript.context.transcript_sha256 = "changed";
  f.$("outlier-table").querySelector("tbody button").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(root.textContent, /当前样本字幕与本轮快照身份不同/);
  assert.equal(root.textContent.includes("nearby subtitle"), false);
  assert.ok(f.calls.every((call) => call.method === "GET"));
});

test("late subtitle responses cannot replace the currently selected outlier", async (t) => {
  const f = await resultFixture(t);
  const pending = [];
  f.delayWith(
    (sample) =>
      new Promise((resolve) =>
        pending.push(() => resolve({ ok: true, json: async () => ({ sample }) })),
      ),
  );
  f.$("outlier-table").querySelectorAll("tbody button")[0].click();
  f.$("outlier-table").querySelectorAll("tbody button")[1].click();
  pending[1]();
  await new Promise((resolve) => setImmediate(resolve));
  const content = f.$("outlier-detail").textContent;
  pending[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.$("outlier-detail").textContent, content);
  assert.equal(f.$("outlier-detail").querySelector("h3").textContent, "result-10");
});

test("experiment detail displays real stage requests and treats generated text as data", async (t) => {
  const f = await resultFixture(t);
  f.run.experiment = { pipeline: true, variant: "synthetic-review" };
  const row = f.run.results[11];
  row.explanation = { topic: "<img src=x onerror=alert(1)>" };
  row.probe = { autoBodySeconds: 1.56 };
  row.repair = { removed: [{ start: 3, end: 4 }] };
  row.stages = [
    {
      name: "partition-review",
      request: { messages: [{ role: "user", content: "actual-stage-input" }] },
      rawOutput: "actual-stage-output",
    },
  ];
  f.filter("run-history", f.run.id);
  await new Promise((resolve) => setImmediate(resolve));
  f.$("outlier-table").querySelector("tbody button").click();
  await new Promise((resolve) => setImmediate(resolve));
  const root = f.$("outlier-detail");
  assert.match(root.textContent, /actual-stage-input/);
  assert.match(root.textContent, /actual-stage-output/);
  assert.match(root.textContent, /1\.56/);
  assert.match(root.textContent, /synthetic-review/);
  assert.equal(root.querySelector("img"), null);
  assert.equal(root.textContent.includes("snapshot-input-11"), false);
});

test("subtitle-review notes only annotate the captured baseline and preserve model data", () => {
  const run = {
    id: "834d0889-6228-41f1-b08b-cbe968617ab8",
    promptSha256: "66c1984919801b1022b467593dd636815732eb826df95bd204d19ea47a8e8438",
    results: [{ bvid: "BV1Lmd2BAEad", segments: [] }],
  };
  const before = structuredClone(run);
  assert.match(annotateRun(run).results[0].observation.title, /合并/);
  assert.deepEqual(run, before);
  assert.equal(annotateRun({ ...run, id: "another-run" }).results[0].observation, undefined);
  assert.equal(
    annotateRun({ ...run, promptSha256: "different" }).results[0].observation,
    undefined,
  );
});
