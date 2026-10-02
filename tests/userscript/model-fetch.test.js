import { test } from "node:test";
import assert from "node:assert/strict";
import { createModelFetch } from "../../userscript/model-fetch.js";
import { ASR_MODEL, ASR_MODEL_SOURCES } from "../../extension/lib/asr-config.js";

test("GM model fetch is exact-host GET, anonymous, redirect-rejecting and reports progress", async () => {
  const progress = [];
  const fetcher = createModelFetch({
    xmlHttpRequest(options) {
      assert.equal(options.url, ASR_MODEL.url);
      assert.equal(options.anonymous, true);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers, undefined);
      options.onprogress({ loaded: 3 });
      const request = Promise.resolve({
        finalUrl: ASR_MODEL.url,
        status: 200,
        response: new Uint8Array([1, 2, 3]).buffer,
      });
      request.abort = () => {};
      return request;
    },
  });
  const result = await fetcher(ASR_MODEL.url, {
    onDownloadProgress: (value) => progress.push(value),
  });
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual(progress, [3]);
  assert.throws(() => fetcher("https://huggingface.co/other"), { code: "HOST" });
});

test("mirror choices allow reviewed anonymous CDN redirects and reject unrelated destinations", async () => {
  for (const source of ASR_MODEL_SOURCES.filter((item) => item.id !== "biliskip")) {
    let finalUrl = "https://us.aws.cdn.hf.co/public-model";
    const fetcher = createModelFetch({
      xmlHttpRequest(options) {
        assert.equal(options.url, source.url);
        assert.equal(options.anonymous, true);
        assert.equal(options.redirect, "follow");
        const request = Promise.resolve({ finalUrl, status: 200, response: new ArrayBuffer(0) });
        request.abort = () => {};
        return request;
      },
    });
    assert.equal((await fetcher(source.url)).status, 200);
    finalUrl = "https://evil.example/model";
    await assert.rejects(fetcher(source.url), { code: "HOST" });
  }
});

test("GM model redirects and already-cancelled requests are rejected", async () => {
  let calls = 0;
  const fetcher = createModelFetch({
    xmlHttpRequest() {
      calls++;
      const request = Promise.resolve({
        finalUrl: "https://other.example/model",
        status: 200,
        response: new ArrayBuffer(0),
      });
      request.abort = () => {};
      return request;
    },
  });
  await assert.rejects(fetcher(ASR_MODEL.url), { code: "HOST" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetcher(ASR_MODEL.url, { signal: controller.signal }), {
    code: "ASR_CANCELLED",
  });
  assert.equal(calls, 1);
});
