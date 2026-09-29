import { test } from "node:test";
import assert from "node:assert/strict";
import { BilibiliClient } from "../../extension/lib/bilibili.js";
import { DeepSeekClient, SharedClient } from "../../extension/lib/providers.js";
import { MODEL, PROMPT_VERSION } from "../../extension/lib/constants.js";
import { context, labels, usage, defaults, json } from "./fixtures.js";

test("Bilibili native-like fetch retains the global receiver", async () => {
  const client = new BilibiliClient(function () {
    assert.equal(this, globalThis, "native fetch rejects a client instance as its receiver");
    return Promise.resolve(json({ ok: true }));
  });
  assert.deepEqual(await client.request("https://api.bilibili.com/x/web-interface/view"), {
    ok: true,
  });
});
test("DeepSeek native-like fetch retains the global receiver", async () => {
  const ctx = await context();
  const client = new DeepSeekClient(function () {
    assert.equal(this, globalThis);
    return Promise.resolve(
      json({
        usage,
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(labels(ctx)) } }],
      }),
    );
  });
  assert.equal((await client.analyze(ctx, defaults.apiKey)).segments.length, 1);
});
test("shared native-like fetch retains the global receiver", async () => {
  const ctx = await context();
  const client = new SharedClient(
    function () {
      assert.equal(this, globalThis);
      return Promise.resolve(
        json({
          schema_version: 1,
          status: "published",
          model: MODEL,
          prompt_version: PROMPT_VERSION,
          labels: labels(ctx),
        }),
      );
    },
    async () => true,
  );
  assert.deepEqual(
    await client.lookup(ctx, {
      ...defaults,
      sharedRead: true,
      sharedBaseUrl: "https://cache.example.com",
    }),
    labels(ctx),
  );
});
