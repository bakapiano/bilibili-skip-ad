import assert from "node:assert/strict";
import { test } from "node:test";
import { AnalysisService } from "../../extension/lib/service.js";
import { SharedClient } from "../../extension/lib/providers.js";
import { AppError, normalize, validateSettings } from "../../extension/lib/core.js";
import { ASR_VERSION } from "../../extension/lib/asr-config.js";
import { validateTranscript } from "../../server/validation.js";
import { body, video, ref, defaults, database, labels, json, deferred } from "./fixtures.js";

function fixture(t, patch = {}, responseStatus = 201) {
  const db = database();
  t.after(async () => (await db.open()).close());
  const settings = { ...defaults, asrEnabled: true, asrUpload: true, ...patch };
  const requests = [];
  let modelCalls = 0;
  const shared = new SharedClient(
    async (url, options) => {
      requests.push({ url, options });
      if (url.includes("/v1/segments?")) {
        return json({}, { status: 404 });
      }
      assert.equal(new URL(url).pathname, "/v1/transcripts");
      const payload = JSON.parse(options.body);
      validateTranscript(payload, options.headers["Idempotency-Key"]);
      return json(
        { schema_version: 1, status: "accepted", submission_id: "synthetic-transcript" },
        { status: responseStatus },
      );
    },
    async () => true,
  );
  const service = new AnalysisService({
    db,
    settings: async () => settings,
    shared,
    bili: {
      metadata: async () => ({ video }),
      load: async () => {
        throw new AppError("NO_SUBTITLE", "Synthetic missing subtitles");
      },
      fetcher: async () =>
        json({
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
        }),
    },
    asr: { transcribe: async () => ({ cues: body }) },
    model: {
      analyze: async (context) => {
        modelCalls++;
        return { labels: labels(context) };
      },
    },
  });
  return { service, db, settings, shared, requests, modelCalls: () => modelCalls };
}

test("ASR upload defaults on and independently uploads only newly transcribed text", async (t) => {
  assert.equal(validateSettings().asrUpload, true);
  assert.equal(validateSettings({ asrUpload: false }).asrUpload, false);
  assert.throws(() => validateSettings({ asrUpload: "true" }));
  const f = fixture(t);
  assert.equal(f.settings.sharedUpload, false);
  const result = await f.service.analyze(ref);
  assert.equal(result.job.status, "done");
  assert.equal(f.requests.length, 1);
  const sent = f.requests[0];
  assert.equal(sent.options.credentials, "omit");
  assert.equal(sent.options.headers.Authorization, undefined);
  assert.equal(sent.options.body.includes(f.settings.apiKey), false);
  assert.equal(JSON.parse(sent.options.body).cues.length, body.length);
  assert.equal((await f.db.all("outbox"))[0].kind, "transcript");
  assert.equal((await f.db.all("outbox"))[0].status, "sent");
  await f.service.prepare(ref);
  assert.equal(f.requests.length, 1);
  assert.equal(f.modelCalls(), 1);
});

test("the latest ASR upload opt-out is honored after transcription and before dispatch", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  const started = deferred();
  f.service.asr.transcribe = async () => {
    started.resolve();
    await gate.promise;
    return { cues: body };
  };
  const pending = f.service.analyze(ref);
  await started.promise;
  f.settings.asrUpload = false;
  gate.resolve();
  assert.equal((await pending).job.status, "done");
  assert.equal(f.requests.length, 0);
  const context = await normalize(video, body, `local-asr:${ASR_VERSION}`);
  const entry = await f.shared.transcript(context);
  f.settings.asrUpload = true;
  assert.equal(await f.shared.uploadTranscript(entry, f.settings, async () => false), null);
  assert.equal(f.requests.length, 0);
});

test("transcript sharing failures preserve subtitles, ad analysis and an isolated error receipt", async (t) => {
  const f = fixture(t, {}, 429);
  const result = await f.service.analyze(ref);
  assert.equal(result.job.status, "done");
  assert.match(result.warning, /转写字幕已保存在本机/);
  assert.equal((await f.db.all("transcripts")).length, 1);
  assert.equal((await f.db.all("records")).length, 1);
  assert.equal((await f.db.all("outbox"))[0].status, "error");
  assert.equal(f.modelCalls(), 1);
});

test("keyless manual ASR follows its upload switch while cache-only lookup uses zero model calls", async (t) => {
  const f = fixture(t, { apiKey: "", consent: false, sharedRead: true });
  await f.service.prepare(ref);
  assert.equal(f.requests.length, 0);
  const result = await f.service.prepare(ref, { transcribeForCache: true });
  assert.equal(result.record, null);
  assert.equal(
    f.requests.filter((row) => new URL(row.url).pathname === "/v1/transcripts").length,
    1,
  );
  assert.equal(f.modelCalls(), 0);
});

test("transcript sharing keeps ordinary subtitles and credential-bearing text local", async (t) => {
  const f = fixture(t);
  const ordinary = await normalize(video, body);
  await assert.rejects(f.shared.transcript(ordinary), { code: "ASR_UPLOAD" });
  const privateContext = await normalize(
    video,
    [{ from: 0, to: 1, content: f.settings.apiKey }],
    `local-asr:${ASR_VERSION}`,
  );
  const entry = await f.shared.transcript(privateContext);
  await assert.rejects(f.shared.uploadTranscript(entry, f.settings), { code: "ASR_UPLOAD" });
  assert.equal(f.requests.length, 0);
});
