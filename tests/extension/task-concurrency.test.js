import assert from "node:assert/strict";
import { test } from "node:test";
import { AnalysisService } from "../../extension/lib/service.js";
import { AppError, hash, normalize } from "../../extension/lib/core.js";
import { ASR_VERSION } from "../../extension/lib/asr-config.js";
import { body, video, defaults, database, labels, deferred, json } from "./fixtures.js";

// Synthetic resource gates keep ASR/model calls pending without network or real workers.
async function fixture(t) {
  const db = database();
  t.after(async () => (await db.open()).close());
  const settings = { ...defaults, asrEnabled: true };
  const videos = [1, 2, 3].map((page) => ({ ...video, page, cid: video.cid + page }));
  const contexts = await Promise.all(videos.map((item) => normalize(item, body)));
  const events = [];
  const asrStarted = deferred();
  const asrGate = deferred();
  const service = new AnalysisService({
    db,
    settings: async () => settings,
    bili: {
      metadata: async ({ page }) => ({ video: videos[page - 1] }),
      load: async ({ page }) => {
        events.push(`subtitle:${page}`);
        if (page === 2) {
          return contexts[1];
        }
        throw new AppError("NO_SUBTITLE", "Synthetic missing subtitles");
      },
      fetcher: async () => {
        events.push("audio");
        return json({
          code: 0,
          data: {
            dash: {
              audio: [
                {
                  codecs: "mp4a.40.2",
                  bandwidth: 64000,
                  baseUrl: "https://cn-test.bilivideo.com/audio.m4a",
                },
              ],
            },
          },
        });
      },
    },
    asr: {
      transcribe: async () => {
        events.push("asr-start");
        asrStarted.resolve();
        await asrGate.promise;
        events.push("asr-finish");
        return { cues: body };
      },
    },
    model: {
      analyze: async (context) => {
        events.push(`model:${context.video.page}`);
        return { labels: labels(context) };
      },
    },
    shared: { lookup: async () => null },
  });
  return { service, db, videos, contexts, settings, events, asrStarted, asrGate };
}

test("subtitle analysis finishes while a different video is still transcribing", async (t) => {
  const f = await fixture(t);
  const running = f.service.analyze(f.videos[0]);
  assert.equal(f.service.analyze(f.videos[0]), running);
  await f.asrStarted.promise;
  try {
    const result = await f.service.analyze(f.videos[1]);
    assert.equal(result.record.video.page, 2);
    assert.equal(result.job.status, "done");
    assert.equal(f.events.includes("asr-finish"), false);
    assert.equal(f.events.filter((value) => value === "asr-start").length, 1);
    assert.ok(f.events.includes("model:2"));
  } finally {
    f.asrGate.resolve();
    await running;
  }
  assert.ok(f.events.indexOf("model:2") < f.events.indexOf("asr-finish"));
  assert.equal(f.service.inflight.size, 0);
});

test("cached transcripts bypass an active ASR resource while another ASR request stays exclusive", async (t) => {
  const f = await fixture(t);
  const running = f.service.analyze(f.videos[0]);
  await f.asrStarted.promise;
  try {
    await assert.rejects(f.service.analyze(f.videos[2]), { code: "BUSY" });
    assert.equal(f.events.filter((event) => event === "audio").length, 1);
    const cached = await normalize(f.videos[2], body, `local-asr:${ASR_VERSION}`);
    await f.db.put("transcripts", {
      key: await hash({ video: f.videos[2], asr: ASR_VERSION }),
      context: cached,
      asrVersion: ASR_VERSION,
    });
    const result = await f.service.analyze(f.videos[2]);
    assert.equal(result.record.video.page, 3);
    assert.ok(f.events.includes("model:3"));
    assert.equal(f.events.includes("asr-finish"), false);
    assert.equal(f.events.filter((event) => event === "asr-start").length, 1);
  } finally {
    f.asrGate.resolve();
    await running;
  }
});

test("cached subtitle markers remain usable during a pending model request", async (t) => {
  const f = await fixture(t);
  const cached = await f.service.analyze(f.videos[1]);
  const modelStarted = deferred();
  const modelGate = deferred();
  f.service.model.analyze = async (context) => {
    modelStarted.resolve();
    await modelGate.promise;
    return { labels: labels(context) };
  };
  f.service.bili.load = async ({ page }) => f.contexts[page - 1];
  const running = f.service.analyze(f.videos[0]);
  await modelStarted.promise;
  try {
    const result = await f.service.analyze(f.videos[1]);
    assert.equal(result.record.key, cached.record.key);
    assert.equal(result.record.source, "local-cache");
    await assert.rejects(f.service.analyze(f.videos[2]), { code: "BUSY" });
  } finally {
    modelGate.resolve();
    await running;
  }
  assert.equal((await f.db.stats()).apiCalls, 2);
});

test("failed ASR releases the resource and per-video ownership for a later retry", async (t) => {
  const f = await fixture(t);
  f.service.asr.transcribe = async () => {
    throw new AppError("ASR", "Synthetic worker initialization failure");
  };
  await assert.rejects(f.service.analyze(f.videos[0]), { code: "ASR" });
  assert.equal(f.service.resources.size, 0);
  assert.equal(f.service.inflight.size, 0);
  f.service.asr.transcribe = async () => ({ cues: body });
  assert.equal((await f.service.analyze(f.videos[0])).job.status, "done");
  assert.equal(f.service.resources.size, 0);
});
