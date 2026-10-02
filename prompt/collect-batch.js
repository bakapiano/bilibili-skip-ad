import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BilibiliClient, boundedBody } from "../extension/lib/bilibili.js";
import { AppError } from "../extension/lib/core.js";
import { parseCommunity } from "./community.js";
import { DEFAULT_DATA, digest, readJson, saveJson } from "./data.js";

const TARGET = 1000;
const CONCURRENCY = 8;
const COMMUNITY_GAP_MS = 500;
const MAX_BUCKETS = 1000;
const HEADERS = {
  Origin: "http://127.0.0.1:43820",
  "x-ext-version": "biliskip-prompt-lab/0.1",
};
const ROOT = path.join(DEFAULT_DATA, "community-batches");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function randomPrefixes(count = MAX_BUCKETS) {
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 65536);
  const values = Array.from({ length: 65536 }, (_, n) => n.toString(16).padStart(4, "0"));
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values.slice(0, count);
}

export function parseBucket(raw, prefix) {
  assert.ok(Array.isArray(raw) && raw.length <= 2000, "Invalid bucket shape");
  const accepted = [];
  const rejected = [];
  for (const item of raw) {
    try {
      assert.match(item.videoID, /^BV[A-Za-z0-9]{10}$/);
      assert.ok(digest(item.videoID).startsWith(prefix), "Hash prefix mismatch");
      assert.ok(Array.isArray(item.segments) && item.segments.length <= 500);
      const segments = [];
      for (const segment of item.segments) {
        const cid = Number(segment.cid);
        assert.ok(Number.isSafeInteger(cid) && cid > 0);
        parseCommunity([segment], { cid, duration: segment.videoDuration || 1 });
        if (
          segment.category === "sponsor" &&
          segment.actionType === "skip" &&
          segment.segment[1] > segment.segment[0]
        ) {
          segments.push(segment);
        }
      }
      if (segments.length) {
        accepted.push({ bvid: item.videoID, prefix, segments });
      }
    } catch {
      rejected.push({
        bvid: typeof item?.videoID === "string" ? item.videoID.slice(0, 32) : null,
        reason: "Invalid video identity, hash bucket or segment schema",
      });
    }
  }
  return { accepted, rejected };
}

export function chooseSamples(candidates, seed, target = TARGET) {
  const unique = new Map();
  for (const candidate of candidates) {
    if (!unique.has(candidate.bvid)) {
      unique.set(candidate.bvid, { ...candidate, segments: [] });
    }
    const saved = unique.get(candidate.bvid);
    for (const s of candidate.segments) {
      if (!saved.segments.some((x) => x.UUID === s.UUID)) {
        saved.segments.push(s);
      }
    }
  }
  return [...unique.values()]
    .sort((a, b) =>
      digest(`${seed}:video:${a.bvid}`).localeCompare(digest(`${seed}:video:${b.bvid}`)),
    )
    .slice(0, target)
    .map((c) => {
      const cids = [...new Set(c.segments.map((s) => Number(s.cid)))];
      cids.sort((a, b) =>
        digest(`${seed}:${c.bvid}:${a}`).localeCompare(digest(`${seed}:${c.bvid}:${b}`)),
      );
      const cid = cids[0];
      return {
        ...c,
        cid,
        availableCids: cids,
        communityRaw: c.segments.filter((s) => Number(s.cid) === cid),
      };
    });
}

export async function workers(items, concurrency, processItem, stopped = () => false) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (!stopped() && cursor < items.length) {
        const item = items[cursor++];
        await processItem(item);
      }
    }),
  );
}

async function collectCommunity(root, plan) {
  const startedAt = Date.now();
  const candidates = [];
  const unique = new Set();
  const summaries = [];
  let lastRequest = 0;
  let stopped = null;
  for (const prefix of plan.prefixes) {
    const file = path.join(root, "buckets", `${prefix}.json`);
    let bucket = await readJson(file, null);
    if (!bucket || !["ok", "empty"].includes(bucket.status)) {
      if (lastRequest) {
        await delay(Math.max(0, COMMUNITY_GAP_MS - (Date.now() - lastRequest)));
      }
      const url = `https://bsbsb.top/api/skipSegments/${prefix}?${new URLSearchParams({ categories: '["sponsor"]' })}`;
      bucket = { prefix, url, fetchedAt: new Date().toISOString() };
      lastRequest = Date.now();
      try {
        const response = await fetch(url, {
          headers: HEADERS,
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        bucket.httpStatus = response.status;
        bucket.elapsedMs = Date.now() - lastRequest;
        if ([403, 412, 429].includes(response.status)) {
          stopped = {
            site: "community",
            httpStatus: response.status,
            retryAfter: response.headers.get("retry-after"),
            at: new Date().toISOString(),
          };
          bucket.status = "paused";
          await response.body?.cancel();
        } else if (response.status === 404) {
          bucket.status = "empty";
          bucket.raw = [];
        } else {
          const bytes = await boundedBody(response, 4 * 1024 * 1024);
          bucket.raw = JSON.parse(new TextDecoder().decode(bytes));
          const parsed = parseBucket(bucket.raw, prefix);
          bucket.capturedJsonSha256 = digest(bucket.raw);
          bucket.accepted = parsed.accepted;
          bucket.rejected = parsed.rejected;
          bucket.status = "ok";
        }
      } catch (error) {
        bucket.status = "error";
        bucket.errorCode = error.code || error.name;
      }
      await saveJson(file, bucket);
    }
    for (const candidate of bucket.accepted || []) {
      candidates.push(candidate);
      unique.add(candidate.bvid);
    }
    summaries.push({
      prefix,
      status: bucket.status,
      httpStatus: bucket.httpStatus,
      videos: bucket.accepted?.length || 0,
      rejected: bucket.rejected?.length || 0,
    });
    if (summaries.length % 10 === 0 || unique.size >= TARGET || stopped) {
      const progress = {
        phase: "community",
        buckets: summaries.length,
        videos: unique.size,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        stopped,
      };
      console.log(JSON.stringify(progress));
      await saveJson(path.join(root, "progress.json"), progress);
    }
    if (unique.size >= TARGET || stopped) {
      break;
    }
  }
  const selected = chooseSamples(candidates, plan.seed);
  const collection = {
    schemaVersion: 1,
    batchId: plan.id,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    status: selected.length === TARGET ? "complete" : "partial",
    stopped,
    buckets: summaries,
    uniqueVideosAvailable: unique.size,
    selectedCount: selected.length,
    candidates: selected,
  };
  await saveJson(path.join(root, "collection.json"), collection);
  return collection;
}

export async function collectSubtitles(
  root,
  plan,
  collection,
  { concurrency = CONCURRENCY, requestGapMs = 0 } = {},
) {
  assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8);
  assert.ok(Number.isInteger(requestGapMs) && requestGapMs >= 0 && requestGapMs <= 2000);
  const startedAt = Date.now();
  let stop = null;
  let inFlight = 0;
  let maxInFlight = 0;
  let requestCount = 0;
  let done = 0;
  let ready = 0;
  const requestStats = new Map();
  let launchQueue = Promise.resolve();
  let lastStart = 0;
  const pending = [];
  for (const candidate of collection.candidates) {
    const old = await readJson(path.join(root, "samples", `${candidate.bvid}.json`), null);
    if (old && ["ready", "unavailable"].includes(old.transcript.status)) {
      done++;
      ready += Number(old.transcript.status === "ready");
    } else {
      pending.push(candidate);
    }
  }
  console.log(
    JSON.stringify({
      phase: "subtitles",
      concurrency,
      requestGapMs,
      selected: collection.selectedCount,
      pending: pending.length,
      reused: done,
    }),
  );
  async function fetchBili(url, options, bvid) {
    if (stop) {
      throw new AppError("COLLECTION_PAUSED", "B站采集已暂停，保留待处理样本。");
    }
    const target = new URL(url);
    assert.ok(
      target.protocol === "https:" &&
        (target.hostname === "api.bilibili.com" || target.hostname.endsWith(".hdslb.com")),
    );
    if (requestGapMs) {
      const slot = launchQueue.then(async () => {
        await delay(Math.max(0, requestGapMs - (Date.now() - lastStart)));
        if (stop) {
          throw new AppError("COLLECTION_PAUSED", "B站采集已暂停，保留待处理样本。");
        }
        lastStart = Date.now();
      });
      launchQueue = slot.catch(() => {});
      await slot;
    }
    requestCount++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const response = await fetch(url, {
        ...options,
        method: "GET",
        credentials: "omit",
        redirect: "error",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: `https://www.bilibili.com/video/${bvid}/`,
        },
      });
      const requestKey = `${target.hostname}:${target.hostname === "api.bilibili.com" ? target.pathname : "subtitle-json"}:${response.status}`;
      requestStats.set(requestKey, (requestStats.get(requestKey) || 0) + 1);
      if ([403, 412, 429].includes(response.status)) {
        stop ||= {
          site: "bilibili",
          httpStatus: response.status,
          endpoint: target.pathname,
          retryAfter: response.headers.get("retry-after"),
          at: new Date().toISOString(),
        };
      }
      return response;
    } finally {
      inFlight--;
    }
  }
  await workers(
    pending,
    concurrency,
    async (candidate) => {
      const sampleStarted = Date.now();
      const sample = {
        schemaVersion: 1,
        id: `${plan.id}:${candidate.bvid}:${candidate.cid}`,
        batchId: plan.id,
        bvid: candidate.bvid,
        cid: candidate.cid,
        source: { kind: "community-random-hash-bucket", prefix: candidate.prefix, reviewed: false },
        community: {
          raw: candidate.communityRaw,
          availableCids: candidate.availableCids,
          segments: [],
          labelType: "unreviewed-reference",
        },
        transcript: { status: "pending" },
        modelResult: null,
        review: null,
      };
      const client = new BilibiliClient((url, options) => fetchBili(url, options, candidate.bvid));
      // Surface JSON risk codes to the batch scheduler before the normal subtitle fallback.
      const originalApi = client.api.bind(client);
      client.api = async (...args) => {
        try {
          return await originalApi(...args);
        } catch (error) {
          const match = /B站接口返回 (-?\d+)/.exec(error.message || "");
          const code = match ? Number(match[1]) : null;
          if ([-352, -412, -509, -799].includes(code)) {
            stop ||= {
              site: "bilibili",
              businessCode: code,
              endpoint: args[0],
              at: new Date().toISOString(),
            };
          }
          throw error;
        }
      };
      try {
        const { meta } = await client.metadata({ bvid: candidate.bvid, page: 1 });
        const index = meta.pages.findIndex((part) => part.cid === candidate.cid);
        if (index < 0) {
          throw new AppError("CID_CHANGED", "社区CID已不在当前视频分P中。");
        }
        const part = meta.pages[index];
        const video = {
          bvid: candidate.bvid,
          cid: candidate.cid,
          page: index + 1,
          title: meta.title,
          part: part.part,
          duration: part.duration,
        };
        sample.video = video;
        sample.community.segments = parseCommunity(candidate.communityRaw, video);
        sample.community.comparableCount = sample.community.segments.filter(
          (s) => s.comparable,
        ).length;
        const context = await client.load(video, () => {}, { meta, video });
        const contextFile = `contexts/${video.bvid}-${video.cid}.json`;
        await saveJson(path.join(root, contextFile), context);
        sample.transcript = {
          status: "ready",
          file: contextFile,
          sha256: context.transcript_sha256,
          source: context.source,
          cues: context.cues.length,
          firstCueStart: context.cues[0].from,
          lastCueEnd: context.cues.at(-1).to,
        };
        ready++;
      } catch (error) {
        sample.transcript = {
          status: stop ? "deferred" : "unavailable",
          errorCode: error.code || error.name,
          error: error instanceof AppError ? error.message : "采集或数据校验失败。",
        };
      }
      sample.fetchedAt = new Date().toISOString();
      sample.elapsedMs = Date.now() - sampleStarted;
      await saveJson(path.join(root, "samples", `${candidate.bvid}.json`), sample);
      done++;
      if (done % 25 === 0 || done === collection.selectedCount || stop) {
        const progress = {
          phase: "subtitles",
          completed: done,
          total: collection.selectedCount,
          ready,
          requests: requestCount,
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          stopped: stop,
        };
        console.log(JSON.stringify(progress));
        await saveJson(path.join(root, "progress.json"), progress);
      }
    },
    () => Boolean(stop),
  );
  const report = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    concurrency,
    requestGapMs,
    maxInFlightRequests: maxInFlight,
    requestCount,
    requestStats: Object.fromEntries(requestStats),
    stopped: stop,
  };
  await saveJson(path.join(root, `subtitle-pass-${randomUUID()}.json`), report);
  return report;
}

async function packageBatch(root, plan, collection, pass) {
  const records = [];
  const failures = {};
  let cueCount = 0;
  let durationSeconds = 0;
  for (const candidate of collection.candidates) {
    const sample = await readJson(path.join(root, "samples", `${candidate.bvid}.json`), null);
    const row = sample || {
      bvid: candidate.bvid,
      cid: candidate.cid,
      community: { raw: candidate.communityRaw },
      transcript: { status: "pending" },
      modelResult: null,
      review: null,
    };
    if (row.transcript.status === "ready") {
      row.context = await readJson(path.join(root, row.transcript.file));
      assert.equal(row.context.transcript_sha256, row.transcript.sha256);
      cueCount += row.context.cues.length;
      durationSeconds += row.video.duration;
    } else {
      const reason = `${row.transcript.status}:${row.transcript.errorCode || "not-started"}`;
      failures[reason] = (failures[reason] || 0) + 1;
    }
    records.push(row);
  }
  const jsonl = records.map((row) => JSON.stringify(row)).join("\n") + "\n";
  assert.ok(
    !/\bsk-[A-Za-z0-9_-]{24,}\b|SESSDATA\s*[:=]|bili_jct\s*[:=]/.test(jsonl),
    "Credential-like content in export",
  );
  const file = `dataset-${Date.now()}.jsonl`;
  await writeFile(path.join(root, file), jsonl, { flag: "wx" });
  const summary = {
    schemaVersion: 1,
    batchId: plan.id,
    startedAt: plan.createdAt,
    finishedAt: new Date().toISOString(),
    requestedVideos: TARGET,
    selectedVideos: records.length,
    selectedParts: new Set(records.map((r) => `${r.bvid}:${r.cid}`)).size,
    communityBuckets: collection.buckets.length,
    communitySegments: records.reduce((n, r) => n + r.community.raw.length, 0),
    readyTranscripts: records.filter((r) => r.transcript.status === "ready").length,
    readyAndComparable: records.filter(
      (r) => r.transcript.status === "ready" && r.community.comparableCount > 0,
    ).length,
    totalSubtitleCues: cueCount,
    videoDurationSeconds: durationSeconds,
    failures,
    communityStopped: collection.stopped,
    subtitlePass: pass,
    modelCalls: 0,
    artifact: { file, bytes: Buffer.byteLength(jsonl), sha256: digest(jsonl) },
    labelPolicy:
      "Community sponsor/skip weak references; random hash buckets, one hash-random CID per BV; model and human results remain separate. Subtitle absence is not a negative ad label.",
  };
  await saveJson(path.join(root, "summary.json"), summary);
  console.log(JSON.stringify({ phase: "complete", root, summary }));
  return summary;
}

export async function main(resumeId) {
  const id = resumeId || randomUUID();
  assert.match(id, /^[a-f0-9-]{36}$/);
  const root = path.join(ROOT, id);
  await mkdir(root, { recursive: true });
  let plan = await readJson(path.join(root, "plan.json"), null);
  if (!plan) {
    plan = {
      schemaVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      seed: randomBytes(16).toString("hex"),
      prefixes: randomPrefixes(),
      targetVideos: TARGET,
      communityGapMs: COMMUNITY_GAP_MS,
      subtitleConcurrency: CONCURRENCY,
    };
    await saveJson(path.join(root, "plan.json"), plan);
  }
  console.log(
    JSON.stringify({ phase: "start", root, target: TARGET, subtitleConcurrency: CONCURRENCY }),
  );
  let collection = await readJson(path.join(root, "collection.json"), null);
  if (collection?.status !== "complete") {
    collection = await collectCommunity(root, plan);
  }
  const pass = await collectSubtitles(root, plan, collection);
  return packageBatch(root, plan, collection, pass);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv[2]);
}
