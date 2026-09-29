import assert from "node:assert/strict";
import { test } from "node:test";
import { createGMFetch, allowedTarget } from "../../userscript/network.js";
import { MAX_BYTES } from "../../extension/lib/constants.js";
import { gmFixture } from "./fixtures.js";
import { deferred, flush } from "../extension/fixtures.js";

const api = "https://api.bilibili.com/x/web-interface/view?bvid=BV1pFUDBKE8X";
const model = "https://api.deepseek.com/chat/completions";

test("GM adapter restricts destinations, methods and credential headers", async () => {
  const f = gmFixture();
  const fetcher = createGMFetch(f.gm);
  for (const url of [
    "http://api.bilibili.com/x/web-interface/view",
    "https://api.deepseek.com.evil.test/chat/completions",
    "https://api.bilibili.com/other",
    "https://api.deepseek.com/chat/completions#extra",
    "https://user:secret@api.deepseek.com/chat/completions",
    "https://evil.test/bfs/test.json",
    "https://aisubtitle.hdslb.com/other",
    "https://biliskipad.bakapiano.com/admin",
  ]) {
    assert.throws(() => allowedTarget(url), { code: "HOST" });
  }
  assert.throws(() => fetcher(api, { headers: { Authorization: "synthetic-secret" } }), {
    code: "HEADERS",
  });
  assert.throws(() => fetcher(api, { headers: { Cookie: "synthetic-session" } }), {
    code: "HEADERS",
  });
  assert.throws(() => fetcher(model), { code: "METHOD" });
  assert.equal(f.requests.length, 0);
  const response = await fetcher(api, { credentials: "include" });
  assert.equal((await response.json()).code, 0);
  assert.equal(f.requests[0].details.anonymous, false);
  assert.equal(f.requests[0].details.redirect, "error");
  await fetcher("https://aisubtitle.hdslb.com/bfs/test.json", { credentials: "include" });
  assert.equal(f.requests[1].details.anonymous, true);
  await fetcher("https://biliskipad.bakapiano.com/v1/segments", { credentials: "include" });
  assert.equal(f.requests[2].details.anonymous, true);
});

test("GM adapter refuses changed final URLs and oversized response bodies", async () => {
  const redirected = gmFixture({
    handler: async () => ({
      status: 200,
      finalUrl: "https://evil.test/",
      response: new ArrayBuffer(0),
    }),
  });
  await assert.rejects(createGMFetch(redirected.gm)(api), { code: "REDIRECT" });
  const large = gmFixture({
    handler: async () => ({ status: 200, response: new ArrayBuffer(MAX_BYTES + 1) }),
  });
  await assert.rejects(createGMFetch(large.gm)(api), { code: "TOO_LARGE" });
});

test("GM adapter honors already-aborted signals, in-flight timeouts and teardown", async () => {
  const gate = deferred();
  const f = gmFixture({ handler: () => gate.promise });
  const fetcher = createGMFetch(f.gm);
  await assert.rejects(fetcher(api, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(f.requests.length, 0);
  const signal = new AbortController();
  const pending = fetcher(api, { signal: signal.signal });
  signal.abort(new DOMException("test timeout", "TimeoutError"));
  await assert.rejects(pending, { name: "TimeoutError" });
  assert.equal(f.requests[0].aborted, true);
  const other = fetcher(api);
  fetcher.dispose();
  await assert.rejects(other, { name: "AbortError" });
  assert.equal(f.requests[1].aborted, true);
  assert.throws(() => fetcher(api), { name: "AbortError" });
  gate.resolve({ status: 200, response: new ArrayBuffer(0) });
  await flush();
});

test("GM network failures expose a fixed message instead of raw credentials or URLs", async () => {
  const f = gmFixture({
    handler: async () => {
      throw new Error("synthetic-secret https://private.test/");
    },
  });
  await assert.rejects(createGMFetch(f.gm)(api), (error) => {
    assert.equal(error.code, "NETWORK");
    assert.doesNotMatch(error.message, /synthetic-secret|private\.test/);
    return true;
  });
});
