import assert from "node:assert/strict";
import { test } from "node:test";
import { UserscriptRuntime, SETTINGS_KEY } from "../../userscript/runtime.js";
import { GMStore } from "../../userscript/storage.js";
import { normalize, hash } from "../../extension/lib/core.js";
import { AsrResourceGate, loadAsrResources } from "../../userscript/asr-resources.js";
import { ASR_VERSION } from "../../extension/lib/asr-config.js";
import { MODEL, PROMPT_VERSION } from "../../extension/lib/constants.js";
import { gmFixture, lockFixture } from "./fixtures.js";
import {
  ref,
  body,
  video,
  labels,
  deferred,
  flush,
  jsonOutput,
  usage,
} from "../extension/fixtures.js";

function setup(options = {}) {
  const f = gmFixture(options);
  const locks = options.locks || lockFixture();
  const runtime = new UserscriptRuntime({
    gm: f.gm,
    locks,
    location: { href: `https://www.bilibili.com/video/${(options.ref || ref).bvid}/` },
    openOptions() {},
    asr: options.asr,
  });
  runtime.service.bili.pause = async () => {};
  return { ...f, runtime, locks };
}
const calls = (f, path) =>
  f.requests.filter(({ details }) => new URL(details.url).pathname === path);
const analyze = (runtime, force = false) =>
  runtime.handle({ type: "ANALYZE", video: ref, force, automatic: false });
async function authorize(f) {
  await f.runtime.saveKey("test-only-placeholder");
  await f.runtime.saveSettings({ consent: true });
}

test("real clients through GM: English subtitles -> model -> local cache -> automatic shared upload", async () => {
  const f = setup({ language: "en" });
  await authorize(f);
  const result = await analyze(f.runtime);
  assert.equal(result.subtitleSource, "bilibili:en");
  assert.equal(result.record.segments[0].start, 10);
  assert.equal(result.record.segments[0].end, 20);
  assert.equal(result.settings.hasKey, true);
  assert.equal(result.settings.apiKey, undefined);
  assert.equal(result.job.status, "done");
  assert.equal(calls(f, "/chat/completions").length, 1);
  const request = calls(f, "/chat/completions")[0].details;
  assert.equal(request.anonymous, true);
  assert.equal(request.headers.authorization, "Bearer test-only-placeholder");
  assert.equal(JSON.parse(request.data).model, "deepseek-flash");
  const upload = calls(f, "/v1/candidates")[0].details;
  assert.equal(upload.anonymous, true);
  assert.equal(upload.headers.authorization, undefined);
  assert.doesNotMatch(upload.data, /test-only-placeholder/);
  assert.equal((await f.runtime.db.all("outbox"))[0].status, "sent");
  assert.equal(
    [...f.values.keys()].some((key) => key.includes(":contexts:")),
    false,
  );
  const second = setup({ values: f.values });
  const cached = await analyze(second.runtime);
  assert.equal(cached.record.source, "local-cache");
  assert.equal(calls(second, "/chat/completions").length, 0);
  assert.equal(calls(second, "/v1/candidates").length, 0);
  await second.runtime.handle({ type: "UPLOAD", video: ref, key: result.record.key });
  assert.equal(calls(second, "/v1/candidates").length, 0);
});

test("zero-ad results are uploaded and both upload switches are honored", async () => {
  const f = setup({ zeroAds: true });
  await authorize(f);
  const result = await analyze(f.runtime);
  assert.deepEqual(result.record.segments, []);
  assert.deepEqual(JSON.parse(calls(f, "/v1/candidates")[0].details.data).segments, []);
  const off = setup();
  await authorize(off);
  await off.runtime.saveSettings({ autoUpload: false });
  const local = await analyze(off.runtime);
  assert.equal(calls(off, "/v1/candidates").length, 0);
  await off.runtime.handle({ type: "UPLOAD", video: ref, key: local.record.key });
  assert.equal(calls(off, "/v1/candidates").length, 1);
  await off.runtime.saveSettings({ sharedUpload: false });
  await assert.rejects(off.runtime.handle({ type: "UPLOAD", video: ref, key: local.record.key }), {
    code: "SHARED_DISABLED",
  });
});

test("shared cache works with a fresh GM store and no configured key", async () => {
  const first = setup();
  await authorize(first);
  const resultKey = (await analyze(first.runtime)).record.key;
  const record = await first.runtime.db.get("records", resultKey);
  const f = setup({
    handler: async (details) =>
      new URL(details.url).pathname === "/v1/segments"
        ? {
            status: 200,
            response: new TextEncoder().encode(
              JSON.stringify({
                schema_version: 1,
                status: "published",
                model: record.model,
                prompt_version: record.promptVersion,
                labels: record.labels,
              }),
            ).buffer,
          }
        : undefined,
  });
  const result = await f.runtime.handle({ type: "GET_PAGE_STATE", video: ref });
  assert.equal(result.record.source, "shared");
  assert.equal(result.settings.hasKey, false);
  assert.equal(calls(f, "/chat/completions").length, 0);
});

test("keyless userscript explicitly transcribes for shared cache with DeepSeek consent disabled", async () => {
  const ctx = await normalize(video, body, `local-asr:${ASR_VERSION}`);
  let asrCalls = 0;
  const f = setup({
    asr: {
      transcribe: async () => {
        asrCalls++;
        return { cues: body };
      },
    },
    handler: (details) => {
      const url = new URL(details.url);
      let payload;
      if (url.pathname === "/x/player/wbi/v2") {
        payload = { code: 0, data: { subtitle: { subtitles: [] } } };
      } else if (url.pathname === "/x/player/playurl") {
        payload = {
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
        };
      } else if (url.pathname === "/v1/segments") {
        assert.equal(url.searchParams.get("transcript_sha256"), ctx.transcript_sha256);
        assert.equal(details.headers.authorization, undefined);
        payload = {
          schema_version: 1,
          status: "published",
          model: MODEL,
          prompt_version: PROMPT_VERSION,
          labels: labels(ctx),
        };
      }
      return payload
        ? { status: 200, response: new TextEncoder().encode(JSON.stringify(payload)).buffer }
        : undefined;
    },
  });
  await f.runtime.saveSettings({ asrEnabled: true, asrUpload: false });
  const before = await f.runtime.handle({ type: "GET_PAGE_STATE", video: ref });
  assert.equal(before.asrRequired, true);
  assert.equal(asrCalls, 0);
  const result = await f.runtime.handle({
    type: "GET_PAGE_STATE",
    video: ref,
    transcribeForCache: true,
    preferShared: true,
  });
  assert.equal(result.settings.hasKey, false);
  assert.equal(result.settings.consent, false);
  assert.equal(result.record.source, "shared");
  assert.equal(asrCalls, 1);
  assert.equal(calls(f, "/chat/completions").length, 0);
  assert.equal(calls(f, "/v1/candidates").length, 0);
  assert.equal(f.locks.held.size, 0);
  await assert.rejects(
    f.runtime.handle({ type: "GET_PAGE_STATE", video: ref, transcribeForCache: "true" }),
    { code: "MESSAGE" },
  );
});

test("failed auto upload preserves validated records and an explicit retry sends once", async () => {
  let rejectUpload = true;
  const f = setup({
    handler: async (details) => {
      if (new URL(details.url).pathname === "/v1/candidates" && rejectUpload) {
        return { status: 429, response: new ArrayBuffer(0) };
      }
    },
  });
  await authorize(f);
  const result = await analyze(f.runtime);
  assert.match(result.warning, /429/);
  assert.ok(await f.runtime.db.get("records", result.record.key));
  assert.equal((await f.runtime.db.all("outbox"))[0].status, "error");
  rejectUpload = false;
  await f.runtime.handle({ type: "UPLOAD", video: ref, key: result.record.key });
  assert.equal((await f.runtime.db.all("outbox"))[0].status, "sent");
  assert.equal(calls(f, "/chat/completions").length, 1);
});

test("cross-tab lock prevents concurrent model charges and subsequent tabs reuse saved results", async () => {
  const gate = deferred();
  const f = setup({
    handler: (details) =>
      new URL(details.url).pathname === "/chat/completions" ? gate.promise : undefined,
  });
  await authorize(f);
  const second = setup({ values: f.values, locks: f.locks });
  const pending = analyze(f.runtime);
  for (let attempt = 0; attempt < 50 && calls(f, "/chat/completions").length === 0; attempt++) {
    await flush();
  }
  assert.equal(calls(f, "/chat/completions").length, 1);
  await assert.rejects(analyze(second.runtime), { code: "BUSY" });
  assert.equal(calls(second, "/chat/completions").length, 0);
  gate.resolve({
    status: 200,
    response: new TextEncoder().encode(
      JSON.stringify({
        usage,
        choices: [{ finish_reason: "stop", message: { content: jsonOutput } }],
      }),
    ).buffer,
  });
  await pending;
  assert.equal((await analyze(second.runtime)).record.source, "local-cache");
  assert.equal(calls(second, "/chat/completions").length, 0);
});

test("cross-tab ASR ownership permits English subtitles and keeps other ASR tasks exclusive", async () => {
  const started = deferred();
  const gate = deferred();
  let transcribing = false;
  const missingSubtitles = (details) => {
    const pathname = new URL(details.url).pathname;
    const payload =
      pathname === "/x/player/wbi/v2"
        ? { code: 0, data: { subtitle: { subtitles: [] } } }
        : pathname === "/x/player/playurl"
          ? {
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
            }
          : null;
    return payload
      ? { status: 200, response: new TextEncoder().encode(JSON.stringify(payload)).buffer }
      : undefined;
  };
  const first = setup({
    handler: missingSubtitles,
    asr: {
      transcribe: async () => {
        transcribing = true;
        started.resolve();
        await gate.promise;
        transcribing = false;
        return { cues: body };
      },
    },
  });
  await authorize(first);
  await first.runtime.saveSettings({ asrEnabled: true });
  const otherRef = { bvid: "BV1eVaz6UENn", page: 1 };
  const subtitleTab = setup({
    values: first.values,
    locks: first.locks,
    language: "en",
    ref: otherRef,
    asr: { transcribe: () => assert.fail("English subtitles use the subtitle path") },
  });
  const thirdRef = { bvid: "BV1Lmd2BAEad", page: 1 };
  let thirdAsrCalls = 0;
  const third = setup({
    values: first.values,
    locks: first.locks,
    ref: thirdRef,
    handler: missingSubtitles,
    asr: {
      transcribe: async () => {
        thirdAsrCalls++;
        return { cues: body };
      },
    },
  });
  const pending = analyze(first.runtime);
  await started.promise;
  try {
    assert.ok(first.locks.held.has("biliskip:userscript:asr"));
    const result = await subtitleTab.runtime.handle({
      type: "ANALYZE",
      video: otherRef,
      force: false,
      automatic: false,
    });
    assert.equal(result.subtitleSource, "bilibili:en");
    assert.equal(result.record.video.bvid, otherRef.bvid);
    assert.equal(result.job.status, "done");
    assert.equal(calls(subtitleTab, "/chat/completions").length, 1);
    assert.equal(calls(subtitleTab, "/x/player/playurl").length, 0);
    assert.equal(transcribing, true);
    await assert.rejects(
      third.runtime.handle({ type: "ANALYZE", video: thirdRef, force: false, automatic: false }),
      { code: "BUSY" },
    );
    assert.equal(calls(third, "/x/player/playurl").length, 0);
    assert.equal(thirdAsrCalls, 0);
  } finally {
    gate.resolve();
    await pending;
  }
  assert.equal(first.locks.held.size, 0);
  const resumed = await third.runtime.handle({
    type: "ANALYZE",
    video: thirdRef,
    force: false,
    automatic: false,
  });
  assert.equal(resumed.job.status, "done");
  assert.equal(thirdAsrCalls, 1);
});

test("different-video model contention is guarded before a paid call or API-call event", async () => {
  const started = deferred();
  const gate = deferred();
  const first = setup({
    handler: (details) => {
      if (new URL(details.url).pathname === "/chat/completions") {
        started.resolve();
        return gate.promise;
      }
    },
  });
  await authorize(first);
  const otherRef = { bvid: "BV1eVaz6UENn", page: 1 };
  const second = setup({ values: first.values, locks: first.locks, ref: otherRef });
  const pending = analyze(first.runtime);
  await started.promise;
  try {
    await assert.rejects(
      second.runtime.handle({ type: "ANALYZE", video: otherRef, force: false, automatic: false }),
      { code: "BUSY" },
    );
    assert.equal(calls(second, "/chat/completions").length, 0);
    assert.equal((await first.runtime.db.stats()).apiCalls, 1);
    assert.equal(second.runtime.service.resources.size, 0);
  } finally {
    gate.resolve({
      status: 200,
      response: new TextEncoder().encode(
        JSON.stringify({
          usage,
          choices: [{ finish_reason: "stop", message: { content: jsonOutput } }],
        }),
      ).buffer,
    });
    await pending;
  }
  assert.equal(first.locks.held.size, 0);
  const result = await second.runtime.handle({
    type: "ANALYZE",
    video: otherRef,
    force: false,
    automatic: false,
  });
  assert.equal(result.job.status, "done");
  assert.equal(calls(second, "/chat/completions").length, 1);
});

test("identity, consent, destination and secret validation precede privileged work", async () => {
  const f = setup();
  await assert.rejects(analyze(f.runtime), { code: "CONSENT" });
  assert.equal(calls(f, "/chat/completions").length, 0);
  await assert.rejects(f.runtime.saveKey("short"), { code: "KEY" });
  await assert.rejects(f.runtime.saveSettings({ sharedBaseUrl: "https://other.example" }), {
    code: "SETTINGS",
  });
  await assert.rejects(f.runtime.saveSettings({ autoAnalyze: true }), { code: "SETTINGS" });
  const previous = f.requests.length;
  await assert.rejects(f.runtime.handle({ type: "GET_PAGE_STATE", video: { ...ref, page: 2 } }), {
    code: "SENDER",
  });
  assert.equal(f.requests.length, previous);
  await authorize(f);
  const notifications = [];
  const unsubscribe = f.runtime.subscribe((data) => notifications.push(data));
  await f.runtime.saveSettings({ autoSkip: true });
  assert.equal(notifications.at(-1).settings.apiKey, undefined);
  assert.equal(f.values.get(SETTINGS_KEY).apiKey, undefined);
  unsubscribe();
  await f.runtime.saveKey("");
  assert.equal((await f.runtime.settings()).apiKey, "");
});

test("GM database shares individual cache rows while contexts/jobs remain per-tab", async () => {
  const f = gmFixture();
  const first = new GMStore(f.gm);
  const second = new GMStore(f.gm);
  await f.gm.setValue("biliskip:v1:deepseekKey", "test-only-placeholder");
  await Promise.all([first.put("records", { key: "a" }), second.put("records", { key: "b" })]);
  assert.equal((await first.all("records")).length, 2);
  await first.put("jobs", { route: "example", status: "running" });
  await first.put("contexts", { route: "example", context: { cues: ["private subtitle"] } });
  assert.equal(await second.get("jobs", "example"), undefined);
  assert.equal(
    [...f.values.keys()].some((key) => /:(contexts|jobs):/.test(key)),
    false,
  );
  await first.clearRecords();
  assert.equal((await second.stats()).records, 0);
  assert.equal(await f.gm.getValue("biliskip:v1:deepseekKey"), "test-only-placeholder");
});

test("ASR resource failure gates audio/model work while subtitles, caches and saved settings survive", async () => {
  let missing = true;
  let reads = 0;
  const availability = new AsrResourceGate(() => {
    reads++;
    return loadAsrResources({});
  });
  const asr = {
    ensureAvailable: () => availability.load(),
    transcribe: () => assert.fail("Unavailable ASR must stay dormant"),
  };
  const f = setup({
    asr,
    handler: (details) =>
      missing && new URL(details.url).pathname === "/x/player/wbi/v2"
        ? {
            status: 200,
            response: new TextEncoder().encode(
              JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }),
            ).buffer,
          }
        : undefined,
  });
  await authorize(f);
  await f.runtime.saveSettings({ asrEnabled: true });
  const blocked = await f.runtime.handle({ type: "GET_PAGE_STATE", video: ref });
  assert.equal(blocked.error.code, "ASR_UNAVAILABLE");
  assert.equal(blocked.cueCount, 0);
  assert.equal(blocked.asrRequired, undefined);
  await assert.rejects(analyze(f.runtime), { code: "ASR_UNAVAILABLE" });
  assert.equal(reads, 1);
  assert.equal(calls(f, "/x/player/playurl").length, 0);
  assert.equal(calls(f, "/chat/completions").length, 0);
  assert.equal(f.locks.held.size, 0);
  assert.equal((await f.runtime.settings()).asrEnabled, true);
  assert.equal(f.values.get(SETTINGS_KEY).asrEnabled, true);

  missing = false;
  const analyzed = await analyze(f.runtime);
  assert.equal(analyzed.record.source, "deepseek");
  assert.equal(analyzed.record.segments.length, 1);
  assert.equal(calls(f, "/v1/candidates").length, 1);
  assert.equal(calls(f, "/chat/completions").length, 1);
  assert.equal(reads, 1);
  assert.equal((await analyze(f.runtime)).record.source, "local-cache");
  assert.equal(calls(f, "/chat/completions").length, 1);

  // Test-only prior ASR transcript: dependency availability must not change cache identity.
  const context = await normalize(video, body, `local-asr:${ASR_VERSION}`);
  await f.runtime.db.put("transcripts", {
    key: await hash({ video, asr: ASR_VERSION }),
    context,
  });
  missing = true;
  const cached = await f.runtime.handle({ type: "GET_PAGE_STATE", video: ref });
  assert.equal(cached.record.source, "local-cache");
  assert.equal(cached.subtitleSource, `local-asr:${ASR_VERSION}`);
  assert.equal(reads, 1);
  assert.equal(calls(f, "/x/player/playurl").length, 0);
});
