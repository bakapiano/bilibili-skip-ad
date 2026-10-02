import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { normalize } from "../extension/lib/core.js";
import { validateCandidate, payloadHash } from "../server/validation.js";
import { renameWithRetry } from "./atomic-file.js";

export const PROMPT_ROOT = fileURLToPath(new URL("./", import.meta.url));
export const DEFAULT_DATA = path.join(PROMPT_ROOT, "data");
export const DEFAULT_RUNS = path.join(PROMPT_ROOT, "runs");
export const sampleVideo = (sample) => sample.video || sample.baseline?.video;
export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export const validId = (id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
export async function readJson(filename, fallback) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}
export async function saveJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    await renameWithRetry(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}
export function intervals(segments) {
  const sorted = segments
    .map(({ start, end }) => [start, end])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b > a)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) {
      last[1] = Math.max(last[1], interval[1]);
    } else {
      merged.push([...interval]);
    }
  }
  return merged;
}
export function intervalDiff(first, second) {
  const a = intervals(first);
  const b = intervals(second);
  const length = (items) => items.reduce((sum, [start, end]) => sum + end - start, 0);
  let intersection = 0;
  for (const x of a) {
    for (const y of b) {
      intersection += Math.max(0, Math.min(x[1], y[1]) - Math.max(x[0], y[0]));
    }
  }
  const firstSeconds = length(a);
  const secondSeconds = length(b);
  const union = firstSeconds + secondSeconds - intersection;
  const round = (n) => Math.round(n * 1000) / 1000;
  return {
    firstSeconds: round(firstSeconds),
    secondSeconds: round(secondSeconds),
    overlapSeconds: round(intersection),
    onlyFirstSeconds: round(firstSeconds - intersection),
    onlySecondSeconds: round(secondSeconds - intersection),
    iou: union ? Math.round((intersection / union) * 10000) / 10000 : null,
  };
}
export function communityReference(sample) {
  if (sample.community?.status !== "ok") {
    return null;
  }
  return sample.community.segments
    .filter((row) => row.category === "sponsor" && row.actionType === "skip" && row.comparable)
    .map((row) => ({ start: row.segment[0], end: row.segment[1] }));
}
export function sampleSummary(sample) {
  const p = sample.baseline || { video: sampleVideo(sample), segments: [] };
  const seconds = p.segments.reduce((sum, s) => sum + s.end - s.start, 0);
  const reference = communityReference(sample);
  return {
    id: sample.id,
    video: p.video,
    model: p.model || "pending",
    promptVersion: p.prompt_version || "待运行",
    hasBaseline: Boolean(sample.baseline),
    datasets: sample.datasets || ["legacy"],
    createdAt: sample.createdAt,
    split: sample.split,
    segmentCount: p.segments.length,
    adSeconds: Math.round(seconds * 1000) / 1000,
    coverage: seconds / p.video.duration,
    protected: seconds >= p.video.duration * 0.5,
    belowThreshold: p.segments.filter((s) => s.confidence < 0.9).length,
    transcriptStatus: sample.transcript?.status || "missing",
    transcriptSource: sample.transcript?.context?.source || null,
    cueCount: sample.transcript?.context?.cues.length || 0,
    communityStatus: sample.community?.status || "pending",
    referenceCount: reference?.length || 0,
    comparison: sample.baseline && reference?.length ? intervalDiff(p.segments, reference) : null,
    reviewed: Boolean(sample.review),
    review: sample.review ? { note: sample.review.note, segments: sample.review.segments } : null,
  };
}
export class LabData {
  constructor(root = DEFAULT_DATA) {
    this.root = path.resolve(root);
  }
  file(id) {
    if (!validId(id)) {
      throw new Error("样本ID格式异常。");
    }
    return path.join(this.root, "cases", `${id}.json`);
  }
  get(id) {
    return readJson(this.file(id));
  }
  save(sample) {
    return saveJson(this.file(sample.id), sample);
  }
  async list() {
    const files = await readdir(path.join(this.root, "cases")).catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    return Promise.all(
      files
        .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
        .map((name) => readJson(path.join(this.root, "cases", name))),
    );
  }
  async manifest() {
    const samples = await this.list();
    const summary = {
      updatedAt: new Date().toISOString(),
      count: samples.length,
      cases: samples.map(sampleSummary).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
    await saveJson(path.join(this.root, "manifest.json"), summary);
    return summary;
  }
}
export async function importSnapshot(db, snapshot) {
  if (!snapshot.readOnly || !Array.isArray(snapshot.records)) {
    throw new Error("无效的只读缓存快照。");
  }
  const accepted = [];
  const rejected = [];
  for (const row of snapshot.records) {
    try {
      if (!validId(row.id) || row.active !== 1 || !row.payload?.segments?.length) {
        throw new Error("样本须为有效含广告缓存。");
      }
      validateCandidate(row.payload, payloadHash(row.payload));
      if (row.request_hash && row.request_hash !== payloadHash(row.payload)) {
        throw new Error("历史请求哈希不一致。");
      }
      const previous = await readJson(db.file(row.id), null);
      const sample = {
        schemaVersion: 1,
        id: row.id,
        createdAt: new Date(row.created_at).toISOString(),
        source: {
          kind: "biliskip-shared-model-label",
          snapshotAt: snapshot.capturedAt,
          reviewed: false,
        },
        split:
          parseInt(digest(row.payload.video.bvid).slice(0, 8), 16) % 5 === 0
            ? "holdout"
            : "development",
        baseline: row.payload,
        transcript: previous?.transcript || { status: "missing" },
        community: previous?.community || { status: "pending" },
        review: previous?.review || null,
      };
      await db.save(sample);
      accepted.push(row.id);
    } catch (error) {
      rejected.push({ id: row.id, error: error.message });
    }
  }
  return { accepted, rejected };
}
export async function attachTranscript(sample, input, provenance) {
  const video = sampleVideo(sample);
  const context = await normalize(
    input.video,
    input.cues || input.body,
    input.source || "imported",
  );
  if (
    context.video.bvid !== video.bvid ||
    context.video.cid !== video.cid ||
    context.video.page !== video.page
  ) {
    throw new Error("字幕视频身份与样本不一致。");
  }
  const rebased = await normalize(video, context.cues, context.source);
  const exact = !sample.baseline || rebased.transcript_sha256 === sample.baseline.transcript_sha256;
  if (sample.transcript?.status === "exact" && !exact) {
    return false;
  }
  sample.transcript = {
    status: sample.baseline ? (exact ? "exact" : "alternate") : "ready",
    context: exact ? rebased : context,
    provenance,
    attachedAt: new Date().toISOString(),
    matchesBaseline: exact,
  };
  return true;
}

export async function packageDataset(db = new LabData()) {
  const samples = (await db.list()).sort((a, b) => a.id.localeCompare(b.id));
  const text =
    samples.map((sample) => JSON.stringify(sample)).join("\n") + (samples.length ? "\n" : "");
  if (/\bsk-[A-Za-z0-9_-]{24,}\b|SESSDATA\s*[:=]|bili_jct\s*[:=]/.test(text)) {
    throw new Error("数据集包含凭据特征，请检查导出内容。");
  }
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const filename = path.join(db.root, "exports", `dataset-${stamp}.jsonl`);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, text, { flag: "wx" });
  const summary = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    file: path.relative(db.root, filename).split(path.sep).join("/"),
    records: samples.length,
    videos: new Set(samples.map((s) => sampleVideo(s).bvid)).size,
    exactTranscripts: samples.filter((s) => ["exact", "ready"].includes(s.transcript.status))
      .length,
    bytes: Buffer.byteLength(text),
    sha256: digest(text),
    labelPolicy:
      "Historical model outputs are weak labels; community is reference, human review is separate; splits are advisory grouping, not an untouched evaluation guarantee.",
  };
  await saveJson(`${filename}.manifest.json`, summary);
  await saveJson(path.join(db.root, "latest-export.json"), summary);
  return summary;
}
