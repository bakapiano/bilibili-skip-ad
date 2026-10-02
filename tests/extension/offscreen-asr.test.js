import { test } from "node:test";
import assert from "node:assert/strict";
import { OffscreenAsr } from "../../extension/lib/offscreen-asr.js";
import { deferred, flush, video } from "./fixtures.js";

test("offscreen startup serializes callers, scopes media headers and authenticates progress", async (t) => {
  const original = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = original;
  });
  const gate = deferred();
  let receive;
  const sent = [];
  const rules = [];
  const created = [];
  // Explicit Chrome adapter fixture; no browser/network/model execution here.
  globalThis.chrome = {
    runtime: {
      id: "test-asr",
      getURL: (file) => `chrome-extension://test-asr/${file}`,
      onMessage: {
        addListener: (listener) => {
          receive = listener;
        },
      },
      getContexts: () => gate.promise,
      sendMessage: async (message) => {
        sent.push(message);
      },
    },
    declarativeNetRequest: {
      updateSessionRules: async (rule) => {
        rules.push(rule);
      },
    },
    offscreen: {
      createDocument: async (options) => {
        created.push(options);
      },
    },
  };
  const client = new OffscreenAsr();
  const progress = [];
  const first = client.transcribe(
    video,
    { url: "https://cn-test.bilivideo.com/audio" },
    2,
    (value) => progress.push(value),
  );
  await assert.rejects(
    client.transcribe(video, {}, 2, () => {}),
    { code: "BUSY" },
  );
  gate.resolve([]);
  await flush();
  assert.equal(created.length, 1);
  assert.deepEqual(rules[0].addRules[0].condition.initiatorDomains, ["test-asr"]);
  assert.deepEqual(rules[0].addRules[0].condition.requestDomains, [
    "bilivideo.com",
    "bilivideo.cn",
  ]);
  const id = sent[0].id;
  receive(
    { type: "ASR_EVENT", id, done: true, result: { bad: true } },
    { id: "other", url: "https://www.bilibili.com/" },
  );
  assert.equal(client.pending.size, 1);
  const sender = { id: "test-asr", url: "chrome-extension://test-asr/offscreen.html" };
  receive({ type: "ASR_EVENT", id, progress: "transcribing" }, sender);
  receive({ type: "ASR_EVENT", id, done: true, result: { cues: [] } }, sender);
  assert.deepEqual(await first, { cues: [] });
  assert.deepEqual(progress, ["transcribing"]);
  assert.equal(client.pending.size, 0);
});
