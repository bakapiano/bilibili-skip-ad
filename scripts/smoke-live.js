// Real service integration using the exact extension modules; this is not Chrome E2E.
// Default: Bilibili subtitle fetch only. --deepseek: one paid API call, then cache checks.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";
import { BilibiliClient } from "../extension/lib/bilibili.js";
import { DeepSeekClient, SharedClient } from "../extension/lib/providers.js";
import { LocalDB } from "../extension/lib/db.js";
import { AnalysisService } from "../extension/lib/service.js";
import { DEFAULT_SETTINGS, MODEL, PROMPT_VERSION } from "../extension/lib/constants.js";
import { safeError } from "../extension/lib/core.js";

const paid = process.argv.includes("--deepseek");
const ref = { bvid: "BV1pFUDBKE8X", page: 1 };
const report = { timestamp: new Date().toISOString(), runtime: "Node + fake-indexeddb (extension modules)", chromeE2E: false,
  model: MODEL, promptVersion: PROMPT_VERSION, video: ref, paidAnalysis: paid, requests: [] };
let apiKey = process.env.DEEPSEEK_API_KEY || "";
if (paid && process.argv.includes("--stdin-key")) {
  process.stdin.setEncoding("utf8");
  apiKey = await new Promise(resolve => {
    let text = "";
    const onData = chunk => { text += chunk; if (text.includes("\n")) { process.stdin.off("data", onData); process.stdin.pause(); resolve(text.split(/\r?\n/)[0].trim()); } };
    process.stdin.on("data", onData); process.stdin.once("end", () => resolve(text.trim()));
  });
}
try {
  assert.ok(!paid || apiKey, "Set DEEPSEEK_API_KEY or use --stdin-key for the paid integration test.");
  const measuredFetch = async (url, options) => {
    const start = performance.now(), target = new URL(url);
    const result = await fetch(url, options);
    report.requests.push({ origin: target.origin, path: target.pathname, status: result.status, headersMs: Math.round(performance.now() - start) });
    return result;
  };
  const db = new LocalDB(new IDBFactory(), `biliskip-smoke-${crypto.randomUUID()}`);
  const service = new AnalysisService({ db, bili: new BilibiliClient(measuredFetch), model: new DeepSeekClient(measuredFetch), shared: new SharedClient(),
    settings: async () => ({ ...DEFAULT_SETTINGS, consent: paid, apiKey }),
    notify: (_route, data) => console.log(JSON.stringify({ stage: data.job?.stage || data.stage, message: data.job?.message || data.message })),
  });
  const start = performance.now();
  const prepared = await service.prepare(ref);
  report.subtitleMs = Math.round(performance.now() - start);
  report.video = prepared.video; report.cueCount = prepared.cueCount; report.subtitleSource = prepared.subtitleSource;
  report.transcriptSha256 = prepared.transcript_sha256;
  assert.equal(prepared.video.bvid, ref.bvid); assert.equal(prepared.video.cid, 34253507696); assert.ok(prepared.cueCount > 100);
  if (paid) {
    const analysis = await service.analyze(ref);
    report.modelMs = analysis.record.elapsedMs; report.usage = analysis.record.usage;
    report.segments = analysis.record.segments; report.summary = analysis.record.summary;
    assert.equal((await db.stats()).apiCalls, 1);
    const cache = await service.prepare(ref); assert.equal(cache.record.source, "local-cache");
    const repeated = await service.analyze(ref); assert.equal(repeated.job.stage, "cached");
    report.stats = await db.stats(); assert.equal(report.stats.apiCalls, 1); assert.equal(report.stats.cacheHits, 2);
    report.cacheVerified = true;
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = safeError(error); process.exitCode = 1;
} finally {
  apiKey = "";
  const directory = new URL(`../runs/extension-live-${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url);
  await mkdir(directory, { recursive: true }); await writeFile(new URL("report.json", directory), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); console.log(`Report: ${directory.pathname}report.json`);
}
