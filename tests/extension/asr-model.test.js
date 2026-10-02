import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AsrModelCache, ASR_CACHE_NAME } from "../../extension/lib/asr-model.js";
import { deferred, flush } from "./fixtures.js";
import {
  ASR_MODEL_SOURCES,
  ASR_MODEL,
  allowedModelDownload,
  modelSource,
} from "../../extension/lib/asr-config.js";

function fixture() {
  // Tiny fixed bytes and in-memory Cache/Web Locks, never the real 239MB model.
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const model = {
    url: "https://biliskipad.bakapiano.com/models/test.onnx",
    legacyUrl: "https://huggingface.co/test.onnx",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const entries = new Map();
  const cache = {
    match: async (key) => entries.get(key)?.clone(),
    put: async (key, value) => {
      entries.set(key, value.clone());
    },
    delete: async (key) => entries.delete(key),
  };
  const storage = {
    open: async (name) => {
      assert.equal(name, ASR_CACHE_NAME);
      return cache;
    },
  };
  let held = false;
  const locks = {
    request: async (_name, _options, callback) => {
      if (held) {
        return callback(null);
      }
      held = true;
      try {
        return await callback({});
      } finally {
        held = false;
      }
    },
  };
  const calls = [];
  const fetcher = async function (url, options) {
    assert.equal(this, globalThis);
    calls.push({ url, options });
    return new Response(bytes);
  };
  return {
    bytes,
    model,
    entries,
    cache,
    storage,
    locks,
    calls,
    fetcher,
    client: (patch = {}) => new AsrModelCache({ model, storage, locks, fetcher, ...patch }),
  };
}

test("manual model download uses own host, anonymous nonredirected request and verified cache", async () => {
  const f = fixture();
  const client = f.client();
  assert.equal((await client.status()).cached, false);
  assert.equal(f.calls.length, 0);
  const progress = [];
  assert.equal((await client.download((row) => progress.push(row))).cached, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, f.model.url);
  assert.equal(f.calls[0].options.credentials, "omit");
  assert.equal(f.calls[0].options.redirect, "error");
  assert.equal(progress.at(-1).stage, "ready");
  assert.deepEqual(await client.load(), f.bytes);
  assert.equal(f.calls.length, 1);
});

test("legacy cache migrates locally after SHA verification", async () => {
  const f = fixture();
  await f.cache.put(f.model.legacyUrl, new Response(f.bytes));
  assert.equal((await f.client().status()).cached, true);
  assert.deepEqual(await f.client().load(), f.bytes);
  assert.equal(f.calls.length, 0);
  assert.equal(f.entries.has(f.model.url), true);
  assert.equal(f.entries.has(f.model.legacyUrl), false);
});

test("bad hash, oversize and unexpected final URL never become a ready cache", async () => {
  for (const [kind, code] of [
    ["hash", "ASR_HASH"],
    ["size", "TOO_LARGE"],
    ["redirect", "ASR_HOST"],
  ]) {
    const f = fixture();
    const client = f.client({
      fetcher: async () => {
        const response = new Response(kind === "size" ? new Uint8Array(5) : new Uint8Array(4));
        if (kind === "redirect") {
          Object.defineProperty(response, "url", { value: "https://other.example/model" });
        }
        return response;
      },
    });
    await assert.rejects(client.download(), { code });
    assert.equal(f.entries.size, 0);
  }
  const f = fixture();
  await f.cache.put(f.model.url, new Response(new Uint8Array(4)));
  await assert.rejects(f.client().load(), { code: "ASR_HASH" });
  assert.equal(f.entries.size, 0);
});

test("cross-context model lock prevents duplicate downloads and cancellation releases the lock", async () => {
  const f = fixture();
  const gate = deferred();
  const controller = new AbortController();
  const slow = f.client({
    fetcher: async (_url, options) => {
      options.signal.addEventListener("abort", () => gate.reject(new Error("cancelled")), {
        once: true,
      });
      return gate.promise;
    },
  });
  const pending = slow.download(() => {}, controller.signal);
  await flush();
  await assert.rejects(f.client().download(), { code: "BUSY" });
  controller.abort();
  await assert.rejects(pending, { code: "ASR_CANCELLED" });
  assert.equal(f.entries.size, 0);
  assert.equal((await f.client().download()).cached, true);
});

test("each selected source uses the same hash gate and shares one canonical cache entry", async () => {
  for (const { id } of ASR_MODEL_SOURCES) {
    const bad = fixture();
    await assert.rejects(
      bad
        .client({ fetcher: async () => new Response(new Uint8Array(4)) })
        .download(() => {}, undefined, id),
      { code: "ASR_HASH" },
    );
    assert.equal(bad.entries.size, 0);
  }
  const f = fixture();
  for (const { id } of ASR_MODEL_SOURCES) {
    assert.equal((await f.client().download(() => {}, undefined, id)).cached, true);
  }
  assert.equal(f.calls.length, 1);
  assert.deepEqual([...f.entries.keys()], [f.model.url]);
  assert.equal(modelSource("unreviewed"), undefined);
  for (const source of ASR_MODEL_SOURCES) {
    assert.equal(allowedModelDownload(source.url, source), true);
    assert.equal(allowedModelDownload("https://evil.example/model", source), false);
    assert.equal(allowedModelDownload("https://user@cdn.hf.co/model", source), false);
    assert.equal(
      allowedModelDownload("https://us.aws.cdn.hf.co/model", source),
      source.id !== "biliskip",
    );
    if (source.id !== "biliskip") {
      assert.equal(new URL(source.url).pathname, new URL(ASR_MODEL.legacyUrl).pathname);
    }
  }
});
