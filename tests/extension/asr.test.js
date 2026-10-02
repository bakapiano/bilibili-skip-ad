import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { AnalysisService } from "../../extension/lib/service.js";
import { AppError, validateSettings } from "../../extension/lib/core.js";
import { ASR_MODEL, exemptVideo } from "../../extension/lib/asr-config.js";
import { audioUrl, audioTrack } from "../../extension/lib/audio.js";
import { LocalDB } from "../../extension/lib/db.js";
import { IDBFactory } from "fake-indexeddb";
import { body, video, ref, defaults, database, labels, context, json } from "./fixtures.js";

function fixture(settings = {}) {
  const state = { ...defaults, asrEnabled: true, asrConcurrency: 2, ...settings };
  const count = { subtitles: 0, audio: 0, asr: 0, model: 0, shared: 0 };
  const db = database();
  const service = new AnalysisService({
    db,
    settings: async () => state,
    bili: {
      metadata: async () => ({ video }),
      load: async () => {
        count.subtitles++;
        throw new AppError("NO_SUBTITLE", "无字幕");
      },
      fetcher: async () => {
        count.audio++;
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
      transcribe: async (_video, _track, concurrency) => {
        count.asr++;
        assert.equal(concurrency, 2);
        return { cues: body };
      },
    },
    model: {
      analyze: async (ctx) => {
        count.model++;
        return { labels: labels(ctx) };
      },
    },
    shared: {
      lookup: async () => {
        count.shared++;
        return null;
      },
    },
  });
  return { service, state, count, db };
}
test("ASR defaults, adjustable decimal exemption and strict boundary", () => {
  const settings = validateSettings();
  assert.equal(settings.asrEnabled, false);
  assert.equal(settings.asrModelSource, "biliskip");
  assert.equal(validateSettings({ asrModelSource: "hf-mirror" }).asrModelSource, "hf-mirror");
  assert.throws(() => validateSettings({ asrModelSource: "custom-unverified" }));
  assert.equal(validateSettings({ asrEnabled: true }).asrEnabled, true);
  assert.equal(validateSettings({ asrEnabled: false }).asrEnabled, false);
  assert.equal(settings.asrConcurrency, 2);
  assert.equal(settings.shortVideoExempt, false);
  assert.equal(
    exemptVideo({ duration: 89.9 }, { shortVideoExempt: true, shortVideoMinutes: 1.5 }),
    true,
  );
  assert.equal(
    exemptVideo({ duration: 90 }, { shortVideoExempt: true, shortVideoMinutes: 1.5 }),
    false,
  );
  for (const patch of [
    { asrConcurrency: 3 },
    { shortVideoMinutes: -1 },
    { shortVideoMinutes: Infinity },
  ]) {
    assert.throws(() => validateSettings(patch));
  }
});
test("short video exits before subtitles, audio, ASR, model and shared cache even on forced analysis", async () => {
  const f = fixture({ shortVideoExempt: true, shortVideoMinutes: 2 });
  assert.equal((await f.service.prepare(ref)).exempt, true);
  assert.equal((await f.service.analyze(ref, { force: true })).exempt, true);
  assert.deepEqual(f.count, { subtitles: 0, audio: 0, asr: 0, model: 0, shared: 0 });
});
test("page preparation offers ASR; explicit analysis transcribes once and persists reusable subtitles", async () => {
  const f = fixture();
  const initial = await f.service.prepare(ref);
  assert.equal(initial.asrRequired, true);
  assert.equal(f.count.asr, 0);
  const result = await f.service.analyze(ref);
  assert.equal(result.record.segments.length, 1);
  assert.equal(f.count.asr, 1);
  assert.equal(f.count.model, 1);
  f.service.contexts.clear();
  assert.equal((await f.service.prepare(ref)).record.source, "local-cache");
  await f.service.analyze(ref);
  assert.equal(f.count.asr, 1);
  assert.equal(f.count.model, 1);
  f.state.shortVideoExempt = true;
  f.state.shortVideoMinutes = 2;
  assert.equal((await f.service.prepare(ref)).record, null);
  assert.equal(f.count.asr, 1);
});
test("ASR switch and consent gate audio/model downloads; network errors retain their identity", async () => {
  const disabled = fixture({ asrEnabled: false });
  await assert.rejects(disabled.service.analyze(ref), { code: "NO_SUBTITLE" });
  assert.equal(disabled.count.asr, 0);
  const noConsent = fixture({ consent: false });
  await assert.rejects(noConsent.service.analyze(ref), { code: "CONSENT" });
  assert.equal(noConsent.count.audio, 0);
  const network = fixture();
  network.service.bili.load = async () => {
    throw new AppError("BILI_NETWORK", "connection");
  };
  await assert.rejects(network.service.analyze(ref), { code: "BILI_NETWORK" });
  assert.equal(network.count.asr, 0);
});
test("ordinary subtitles use existing pipeline and new prompt cache namespace", async () => {
  const f = fixture();
  const ctx = await context();
  f.service.bili.load = async () => ctx;
  const result = await f.service.analyze(ref);
  assert.equal(f.count.asr, 0);
  assert.match(result.record.key, /ad-cues-v6-json$/);
});

test("explicit keyless cache lookup transcribes locally and applies shared labels only", async () => {
  const f = fixture({ apiKey: "", consent: false, sharedRead: true });
  f.service.shared.lookup = async (ctx) => {
    f.count.shared++;
    return labels(ctx);
  };
  const offered = await f.service.prepare(ref);
  assert.equal(offered.asrRequired, true);
  assert.match(offered.notice, /手动转写后查询共享缓存/);
  assert.equal(f.count.asr, 0);
  const result = await f.service.prepare(ref, { preferShared: true, transcribeForCache: true });
  assert.equal(result.record.source, "shared");
  assert.equal(f.count.asr, 1);
  assert.equal(f.count.model, 0);
  assert.equal((await f.service.prepare(ref)).record.source, "local-cache");
  assert.equal(f.count.asr, 1);
  assert.equal((await f.db.stats()).apiCalls, 0);
});

test("keyless local transcription respects opt-outs and a miss leaves model calls dormant", async () => {
  for (const settings of [{ asrEnabled: false }, { sharedRead: false }]) {
    const f = fixture({ apiKey: "", consent: false, sharedRead: true, ...settings });
    await assert.rejects(f.service.prepare(ref, { transcribeForCache: true }));
    assert.equal(f.count.asr, 0);
    assert.equal(f.count.audio, 0);
    assert.equal(f.count.model, 0);
  }
  const f = fixture({ apiKey: "", consent: false, sharedRead: true });
  const miss = await f.service.prepare(ref, { transcribeForCache: true });
  assert.equal(miss.record, null);
  assert.match(miss.notice, /共享缓存暂未收录/);
  assert.equal(f.count.asr, 1);
  assert.equal(f.count.model, 0);
});

test("enabling exemption during ASR prevents the following model call", async () => {
  const f = fixture();
  f.service.asr.transcribe = async () => {
    f.state.shortVideoExempt = true;
    f.state.shortVideoMinutes = 2;
    return { cues: body };
  };
  const result = await f.service.analyze(ref);
  assert.equal(result.exempt, true);
  assert.equal(result.record, null);
  assert.equal(f.count.model, 0);
  assert.equal(f.count.shared, 0);
});

test("audio retrieval selects a standard HTTPS backup and rejects all-invalid addresses", async () => {
  const track = {
    codecs: "mp4a.40.2",
    bandwidth: 64000,
    baseUrl: "https://mcdn.bilivideo.com:8082/audio",
    backupUrl: ["https://cn-test.bilivideo.com/audio"],
  };
  const fetcher = async () => json({ code: 0, data: { dash: { audio: [track] } } });
  assert.equal((await audioTrack(video, fetcher)).url, track.backupUrl[0]);
  track.backupUrl = ["https://evil.example/audio"];
  await assert.rejects(audioTrack(video, fetcher), { code: "AUDIO_HOST" });
});

test("IndexedDB upgrade preserves v1 records and creates the transcript store", async () => {
  const factory = new IDBFactory();
  const name = "upgrade-asr";
  const old = await new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      const records = request.result.createObjectStore("records", { keyPath: "key" });
      records.put({ key: "retained", value: 42 });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  old.close();
  const db = new LocalDB(factory, name);
  assert.equal((await db.get("records", "retained")).value, 42);
  await db.put("transcripts", { key: "new-transcript", cues: [] });
  assert.equal((await db.all("transcripts")).length, 1);
});
test("pinned bundled runtime bytes and public model source match reviewed assets", async () => {
  const root = new URL("../../extension/asr/vendor/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("provenance.json", root), "utf8"));
  for (const [name, file] of Object.entries(manifest.files)) {
    const bytes = await readFile(new URL(name, root));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  assert.equal(ASR_MODEL.bytes, 239233841);
  assert.equal(new URL(ASR_MODEL.url).origin, "https://biliskipad.bakapiano.com");
  assert.match(ASR_MODEL.legacyUrl, /2365baeacb507f821a0c8120fcee3d484dba7a07/);
  assert.equal(
    audioUrl("https://cn-test.bilivideo.com/a.m4a"),
    "https://cn-test.bilivideo.com/a.m4a",
  );
  for (const target of [
    "https://evil.com/a",
    "https://bilivideo.com.evil.com/a",
    "http://cn-test.bilivideo.com/a",
  ]) {
    assert.throws(() => audioUrl(target));
  }
});
