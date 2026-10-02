import { readFile, readdir, mkdir, copyFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalize } from "../extension/lib/core.js";
import { validateCandidate, payloadHash } from "../server/validation.js";
import { parseCommunity } from "./community.js";
import {
  LabData,
  PROMPT_ROOT,
  DEFAULT_RUNS,
  digest,
  readJson,
  saveJson,
  packageDataset,
} from "./data.js";

const REPO = path.dirname(PROMPT_ROOT.replace(/[\\/]$/, ""));
const DEFAULT_BATCH = path.join(
  REPO,
  "data/prompt-lab/community-batches/f8412a90-b0db-4cba-9d23-5646e8986230/ready-542.jsonl",
);
export function caseIdentity(context) {
  return `${context.video_key}:${context.transcript_sha256}`;
}
export function caseId(context) {
  const hash = digest(caseIdentity(context));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
async function verifiedContext(input) {
  const ctx = await normalize(input.video, input.cues, input.source);
  if (ctx.transcript_sha256 !== input.transcript_sha256 || ctx.video_key !== input.video_key) {
    throw new Error("整理字幕时发现指纹或视频身份不一致。");
  }
  return ctx;
}

export async function prepareData({
  db = new LabData(),
  legacyRoot = path.join(REPO, "data/prompt-lab"),
  batchFile = DEFAULT_BATCH,
  legacyRuns = path.join(REPO, "runs/prompt-lab"),
  runsRoot = DEFAULT_RUNS,
} = {}) {
  const collected = new Map();
  const report = {
    createdAt: new Date().toISOString(),
    legacyWithSubtitles: 0,
    skippedMissing: 0,
    batchRecords: 0,
    rejected: [],
    copiedRuns: 0,
  };
  async function add(
    input,
    cohort,
    origin,
    baseline = null,
    community = null,
    review = null,
    createdAt = report.createdAt,
  ) {
    const context = await verifiedContext(input);
    if (baseline) {
      validateCandidate(baseline, payloadHash(baseline));
      if (
        baseline.video.bvid !== context.video.bvid ||
        baseline.video.cid !== context.video.cid ||
        baseline.video.page !== context.video.page
      ) {
        throw new Error("历史模型与字幕视频身份不一致。");
      }
    }
    const key = caseIdentity(context);
    const previous = collected.get(key);
    const sample = previous || {
      schemaVersion: 2,
      id: caseId(context),
      video: context.video,
      createdAt,
      source: { kind: "curated-input", origins: [] },
      datasets: [],
      split:
        parseInt(digest(context.video.bvid).slice(0, 8), 16) % 5 === 0 ? "holdout" : "development",
      baseline: null,
      baselineHistory: [],
      transcript: { status: "ready", context, matchesBaseline: null },
      community: { status: "pending", segments: [] },
      review: null,
    };
    sample.datasets = [...new Set([...sample.datasets, cohort])];
    sample.source.origins.push(origin);
    if (baseline) {
      sample.baselineHistory.push({ sourceId: origin.id, createdAt, payload: baseline });
      sample.baselineHistory.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      sample.baseline = sample.baselineHistory[0].payload;
      const matches = sample.baseline.transcript_sha256 === context.transcript_sha256;
      sample.transcript.status = matches ? "exact" : "alternate";
      sample.transcript.matchesBaseline = matches;
    }
    if (community?.status === "ok") {
      sample.community = {
        ...community,
        segments: parseCommunity(community.segments, context.video),
      };
    }
    if (review) {
      sample.review = review;
    }
    collected.set(key, sample);
  }
  const oldFiles = await readdir(path.join(legacyRoot, "cases")).catch(() => []);
  for (const file of oldFiles.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))) {
    const sample = await readJson(path.join(legacyRoot, "cases", file));
    if (!sample.transcript?.context) {
      report.skippedMissing++;
      continue;
    }
    try {
      await add(
        sample.transcript.context,
        "legacy",
        { kind: "legacy", id: sample.id },
        sample.baseline,
        sample.community,
        sample.review,
        sample.createdAt,
      );
      report.legacyWithSubtitles++;
    } catch (error) {
      report.rejected.push({ source: "legacy", id: sample.id, error: error.message });
    }
  }
  const raw = await readFile(batchFile, "utf8");
  if (Buffer.byteLength(raw) > 256 * 1024 * 1024) {
    throw new Error("待整理数据超过256MiB。");
  }
  const sourceHash = digest(raw);
  const suppliedManifest = await readJson(
    path.join(path.dirname(batchFile), "ready-manifest.json"),
    null,
  );
  if (
    suppliedManifest &&
    suppliedManifest.file === path.basename(batchFile) &&
    suppliedManifest.sha256 !== sourceHash
  ) {
    throw new Error("原始批次校验清单与JSONL不一致。");
  }
  for (const line of raw.split(/\r?\n/).filter((s) => s.trim())) {
    const row = JSON.parse(line);
    try {
      if (row.transcript?.status !== "ready" || !row.context) {
        report.skippedMissing++;
        continue;
      }
      if (
        row.bvid !== row.context.video.bvid ||
        row.cid !== row.context.video.cid ||
        row.transcript.sha256 !== row.context.transcript_sha256
      ) {
        throw new Error("批次记录与字幕身份不一致。");
      }
      await add(
        row.context,
        "community-542",
        { kind: "community-batch", batchId: row.batchId, id: row.id },
        null,
        {
          status: "ok",
          fetchedAt: row.fetchedAt,
          source: "community-hash-bucket",
          segments: row.community.raw,
        },
        row.review,
      );
      report.batchRecords++;
    } catch (error) {
      report.rejected.push({ source: "batch", id: row.id, error: error.message });
    }
  }
  if (!collected.size) {
    throw new Error("当前输入没有通过校验的完整字幕样本。");
  }
  for (const sample of collected.values()) {
    const previous = await readJson(db.file(sample.id), null);
    if (previous) {
      sample.review = previous.review;
    }
    if (/\bsk-[A-Za-z0-9_-]{24,}\b|SESSDATA\s*[:=]|bili_jct\s*[:=]/.test(JSON.stringify(sample))) {
      throw new Error("待整理数据包含凭据特征。");
    }
    await db.save(sample);
  }
  const sourceDirectory = path.join(db.root, "sources");
  await mkdir(sourceDirectory, { recursive: true });
  const target = path.join(sourceDirectory, `community-${sourceHash.slice(0, 16)}.jsonl`);
  try {
    await copyFile(batchFile, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST" || digest(await readFile(target, "utf8")) !== sourceHash) {
      throw error;
    }
  }
  const runFiles = await readdir(legacyRuns).catch(() => []);
  for (const file of runFiles.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))) {
    const destination = path.join(runsRoot, file);
    if (!(await readJson(destination, null))) {
      const old = await readJson(path.join(legacyRuns, file));
      if (/\bsk-[A-Za-z0-9_-]{24,}\b/.test(JSON.stringify(old))) {
        throw new Error("历史运行记录包含凭据特征。");
      }
      await saveJson(destination, old);
      report.copiedRuns++;
    }
  }
  const drafts = await readdir(path.join(legacyRoot, "prompts")).catch(() => []);
  for (const file of drafts.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))) {
    const destination = path.join(db.root, "prompts", file);
    if (!(await readJson(destination, null))) {
      const draft = await readJson(path.join(legacyRoot, "prompts", file));
      if (/\bsk-[A-Za-z0-9_-]{24,}\b/.test(JSON.stringify(draft))) {
        throw new Error("历史Prompt草稿包含凭据特征。");
      }
      await saveJson(destination, draft);
    }
  }
  const manifest = await db.manifest();
  report.uniqueInputs = manifest.count;
  report.cohorts = Object.fromEntries(
    ["community-542", "legacy"].map((name) => [
      name,
      manifest.cases.filter((s) => s.datasets.includes(name)).length,
    ]),
  );
  report.sourceSha256 = sourceHash;
  report.export = await packageDataset(db);
  await saveJson(path.join(db.root, "preparation.json"), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(
    JSON.stringify(
      await prepareData(process.argv[2] ? { batchFile: path.resolve(process.argv[2]) } : {}),
      null,
      2,
    ),
  );
}
