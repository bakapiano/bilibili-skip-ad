import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { LabData, attachTranscript, saveJson, sampleVideo } from "./data.js";
import { fetchCommunity } from "./community.js";
import { BilibiliClient } from "../extension/lib/bilibili.js";

export async function collectCommunity(
  db = new LabData(),
  { refresh = false, progress = () => {} } = {},
) {
  const samples = await db.list();
  const byVideo = new Map();
  for (const sample of samples) {
    const key = `${sampleVideo(sample).bvid}:${sampleVideo(sample).cid}`;
    if (!byVideo.has(key)) {
      byVideo.set(key, []);
    }
    byVideo.get(key).push(sample);
  }
  let count = 0;
  for (const group of byVideo.values()) {
    let result = group
      .map((s) => s.community)
      .find((c) => c?.status !== "pending" && c?.status !== "error" && c?.fetchedAt);
    if (refresh || !result) {
      result = await fetchCommunity(sampleVideo(group[0]));
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (const sample of group) {
      const latest = await db.get(sample.id);
      latest.community = result;
      await db.save(latest);
    }
    progress({
      done: ++count,
      total: byVideo.size,
      bvid: sampleVideo(group[0]).bvid,
      status: result.status,
      segments: result.segments.length,
    });
    if ([403, 429].includes(result.httpStatus)) {
      break;
    }
  }
  return db.manifest();
}
function contextsIn(value, found, depth = 0) {
  if (!value || typeof value !== "object" || depth > 9) {
    return;
  }
  if (value.video?.bvid && Array.isArray(value.cues)) {
    found.push(value);
    return;
  }
  for (const child of Object.values(value)) {
    contextsIn(child, found, depth + 1);
  }
}
export async function importContextFile(db, filename) {
  const size = (await stat(filename)).size;
  if (size > 32 * 1024 * 1024) {
    return { found: 0, attached: 0, skipped: "oversized" };
  }
  const data = JSON.parse(await readFile(filename, "utf8"));
  const contexts = [];
  contextsIn(data, contexts);
  const samples = await db.list();
  let attached = 0;
  for (const context of contexts) {
    for (const sample of samples.filter(
      (s) => sampleVideo(s).bvid === context.video.bvid && sampleVideo(s).cid === context.video.cid,
    )) {
      try {
        const latest = await db.get(sample.id);
        if (
          await attachTranscript(latest, context, {
            kind: "local-file",
            file: path.resolve(filename),
          })
        ) {
          await db.save(latest);
          attached++;
        }
      } catch {
        /* Invalid/mismatched contexts are never silently used. */
      }
    }
  }
  return { found: contexts.length, attached };
}
export async function scanContexts(db, roots, { progress = () => {} } = {}) {
  const candidates = [];
  async function walk(directory, depth = 0) {
    if (depth > 5) {
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (
          /profile|offline-copy|node_modules|vendor|\.git|cache-storage|indexeddb|extensions|assets|models|site-build|snapshots|prompt-lab|^cases$/i.test(
            entry.name,
          )
        ) {
          continue;
        }
        await walk(path.join(directory, entry.name), depth + 1);
      } else if (entry.name.endsWith(".json")) {
        candidates.push(path.join(directory, entry.name));
      }
    }
  }
  for (const root of roots) {
    await walk(root);
  }
  let attached = 0;
  for (const file of candidates) {
    try {
      const result = await importContextFile(db, file);
      attached += result.attached;
    } catch {
      /* Unrelated JSON is not a transcript source. */
    }
  }
  const manifest = await db.manifest();
  progress({ files: candidates.length, attached });
  return manifest;
}
export async function fetchMissingSubtitles(
  db = new LabData(),
  { limit = 100, progress = () => {} } = {},
) {
  const samples = await db.list();
  const groups = new Map();
  for (const sample of samples) {
    if (["exact", "ready"].includes(sample.transcript.status)) {
      continue;
    }
    const key = `${sampleVideo(sample).bvid}:${sampleVideo(sample).page}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(sample);
  }
  const report = [];
  for (const group of [...groups.values()].slice(0, limit)) {
    const video = sampleVideo(group[0]);
    const client = new BilibiliClient((url, options) =>
      fetch(url, {
        ...options,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: `https://www.bilibili.com/video/${video.bvid}/`,
        },
      }),
    );
    try {
      const context = await client.load(video);
      for (const sample of group) {
        await attachTranscript(sample, context, {
          kind: "current-bilibili",
          fetchedAt: new Date().toISOString(),
        });
        await db.save(sample);
      }
      report.push({
        bvid: video.bvid,
        status: group[0].transcript.status,
        cues: context.cues.length,
      });
    } catch (error) {
      report.push({ bvid: video.bvid, status: "unavailable", code: error.code || "NETWORK" });
    }
    progress({ ...report.at(-1), done: report.length, total: Math.min(groups.size, limit) });
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (report.at(-1).code === "BILI_API" && report.slice(-3).every((r) => r.code === "BILI_API")) {
      break;
    }
  }
  await saveJson(path.join(db.root, "subtitle-fetch-report.json"), report);
  return db.manifest();
}
