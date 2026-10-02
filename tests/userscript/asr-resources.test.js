import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  readAsrResource,
  loadAsrResources,
  AsrResourceGate,
} from "../../userscript/asr-resources.js";
import { ASR_ASSETS, asrAssetUrl } from "../../userscript/asr-assets.js";
import { deferred, flush } from "../extension/fixtures.js";

function assetFixture() {
  const bytes = Buffer.from([0, 97, 115, 109, 255, 128, 0, 1]);
  return {
    bytes,
    asset: {
      name: "test-resource",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

test("manager-preloaded data and blob resources preserve binary bytes and verify SHA-256", async () => {
  const { bytes, asset } = assetFixture();
  const data = await readAsrResource(
    {
      getResourceUrl: async (name) => {
        assert.equal(name, asset.name);
        return `data:application/wasm;base64,${bytes.toString("base64")}`;
      },
    },
    asset,
    () => {
      throw new Error("Data resource must not make fetch requests");
    },
  );
  assert.deepEqual(Buffer.from(data), bytes);
  const blob = await readAsrResource(
    { getResourceUrl: async () => "blob:https://www.bilibili.com/test-resource" },
    asset,
    function (url, options) {
      assert.equal(this, globalThis);
      assert.ok(url.startsWith("blob:"));
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      return Promise.resolve(new Response(bytes));
    },
  );
  assert.deepEqual(Buffer.from(blob), bytes);
});

test("missing, remote, oversized, corrupt or tampered manager resources fail closed", async () => {
  const { bytes, asset } = assetFixture();
  await assert.rejects(readAsrResource({}, asset), { code: "ASR_RESOURCE" });
  for (const url of [
    undefined,
    "https://biliskipad.bakapiano.com/runtime.wasm",
    "file:///runtime.wasm",
    "data:text/plain,invalid",
    "data:application/wasm;base64,%%%%",
  ]) {
    await assert.rejects(
      readAsrResource({ getResourceUrl: async () => url }, asset, () => {
        throw new Error("Unexpected network");
      }),
    );
  }
  for (const [buffer, code] of [
    [Buffer.alloc(bytes.length + 1), "ASR_RESOURCE_SIZE"],
    [Buffer.alloc(bytes.length - 1), "ASR_RESOURCE_SIZE"],
    [Buffer.alloc(bytes.length), "ASR_RESOURCE_HASH"],
  ]) {
    await assert.rejects(
      readAsrResource(
        {
          getResourceUrl: async () =>
            `data:application/octet-stream;base64,${buffer.toString("base64")}`,
        },
        asset,
      ),
      { code },
    );
  }
});

test("real pinned WASM and VAD support resources match Chrome assets and round trip via GM fixture", async () => {
  const urls = new Map();
  for (const asset of ASR_ASSETS) {
    const bytes = await readFile(
      new URL(`../../extension/asr/vendor/${asset.file}`, import.meta.url),
    );
    assert.equal(bytes.length, asset.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
    assert.equal(new URL(asrAssetUrl(asset)).hostname, "biliskipad.bakapiano.com");
    urls.set(asset.name, `data:application/octet-stream;base64,${bytes.toString("base64")}`);
  }
  const result = await loadAsrResources({ getResourceUrl: async (name) => urls.get(name) });
  assert.equal(result.binary.byteLength, ASR_ASSETS[0].bytes);
  assert.equal(result.support.byteLength, ASR_ASSETS[1].bytes);
});

test("optional resource gate is lazy, shares concurrent reads and retains verified buffers", async () => {
  const pending = deferred();
  const buffers = { binary: new ArrayBuffer(8), support: new ArrayBuffer(4) };
  let reads = 0;
  const gate = new AsrResourceGate(async () => {
    reads++;
    return pending.promise;
  });
  const changes = [];
  const unsubscribe = gate.subscribe((state) => changes.push(state.status));
  assert.equal(gate.state.status, "unchecked");
  assert.equal(reads, 0);
  const first = gate.load();
  const second = gate.load({ retry: true });
  await flush();
  assert.equal(gate.state.status, "checking");
  assert.equal(reads, 1);
  pending.resolve(buffers);
  assert.equal(await first, buffers);
  assert.equal(await second, buffers);
  assert.equal(await gate.load(), buffers);
  assert.equal(reads, 1);
  assert.deepEqual(changes, ["checking", "ready"]);
  unsubscribe();
  assert.equal(gate.listeners.size, 0);
});

test("either missing ASR resource pauses fresh transcription until an explicit verified retry", async () => {
  const urls = new Map();
  for (const asset of ASR_ASSETS) {
    const bytes = await readFile(
      new URL(`../../extension/asr/vendor/${asset.file}`, import.meta.url),
    );
    urls.set(asset.name, `data:application/octet-stream;base64,${bytes.toString("base64")}`);
  }
  for (const asset of ASR_ASSETS) {
    let broken = true;
    let reads = 0;
    const gm = {
      getResourceUrl: async (name) => {
        reads++;
        return broken && name === asset.name ? undefined : urls.get(name);
      },
    };
    const gate = new AsrResourceGate((signal) => loadAsrResources(gm, fetch, signal));
    await assert.rejects(gate.load(), { code: "ASR_UNAVAILABLE" });
    assert.equal(gate.state.status, "unavailable");
    assert.match(gate.state.message, /字幕识别与已有缓存继续可用/);
    const afterFailure = reads;
    broken = false;
    await assert.rejects(gate.load(), { code: "ASR_UNAVAILABLE" });
    assert.equal(reads, afterFailure, "automatic retries remain paused");
    const recovered = await gate.load({ retry: true });
    assert.equal(recovered.binary.byteLength, ASR_ASSETS[0].bytes);
    assert.equal(recovered.support.byteLength, ASR_ASSETS[1].bytes);
    assert.equal(gate.state.status, "ready");
  }
});

test("tampered resources remain gated and a hanging manager read times out without late recovery", async () => {
  const { asset, bytes } = assetFixture();
  const bad = new AsrResourceGate(() =>
    readAsrResource(
      {
        getResourceUrl: async () =>
          `data:application/wasm;base64,${Buffer.alloc(bytes.length).toString("base64")}`,
      },
      asset,
    ),
  );
  await assert.rejects(bad.load(), { code: "ASR_UNAVAILABLE" });
  assert.match(bad.state.message, /完整性校验失败/);
  const pending = deferred();
  let signal;
  const stalled = new AsrResourceGate(
    (input) => {
      signal = input;
      return pending.promise;
    },
    { timeoutMs: 20 },
  );
  await assert.rejects(stalled.load(), { code: "ASR_UNAVAILABLE" });
  assert.ok(signal.aborted);
  assert.match(stalled.state.message, /超时/);
  pending.resolve({ binary: new ArrayBuffer(8), support: new ArrayBuffer(4) });
  await flush();
  assert.equal(stalled.state.status, "unavailable");
  assert.equal(stalled.buffers, null);
});
