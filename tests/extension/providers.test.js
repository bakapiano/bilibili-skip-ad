import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepSeekClient, SharedClient, deepseekRequest } from "../../extension/lib/providers.js";
import { MODEL, PROMPT_VERSION } from "../../extension/lib/constants.js";
import { validateLabels } from "../../extension/lib/core.js";
import { context, labels, usage, defaults, json } from "./fixtures.js";

const response = (ctx, changes = {}) => ({
  usage,
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify(labels(ctx)) } }],
  ...changes,
});
test("DeepSeek request uses fixed model, explicit data boundary and bounded JSON output", async () => {
  const ctx = await context();
  const request = deepseekRequest(ctx);
  assert.equal(request.model, MODEL);
  assert.equal(request.thinking.type, "disabled");
  assert.equal(request.response_format.type, "json_object");
  assert.equal(request.max_tokens, 2048);
  assert.equal(request.messages.length, 2);
  assert.match(request.messages[0].content, /不可信/);
  assert.deepEqual(JSON.parse(request.messages[1].content).cues, ctx.cues);
});
test("DeepSeek credentials only travel to official endpoint and usage is retained", async () => {
  const ctx = await context();
  let calls = 0;
  const model = new DeepSeekClient(async (url, options) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-only-placeholder");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.body.includes("test-only-placeholder"), false);
    return json(response(ctx));
  });
  const result = await model.analyze(ctx, defaults.apiKey);
  assert.equal(calls, 1);
  assert.equal(result.segments[0].start, 10);
  assert.equal(result.usage.promptTokens, 1000);
  assert.ok(result.elapsedMs >= 0);
  await assert.rejects(model.analyze(ctx, ""), { code: "KEY" });
  assert.equal(calls, 1);
});
test("HTTP errors and timeout are sanitized and never automatically retried", async () => {
  const ctx = await context();
  for (const status of [401, 402, 403, 429, 500]) {
    let calls = 0;
    const model = new DeepSeekClient(async () => {
      calls++;
      return json({ secret: "private-provider-body" }, { status });
    });
    await assert.rejects(
      model.analyze(ctx, defaults.apiKey),
      (e) => e.code === "DEEPSEEK_HTTP" && !e.message.includes("private"),
    );
    assert.equal(calls, 1);
  }
  const timeout = new DeepSeekClient(async () => {
    throw new DOMException("private", "TimeoutError");
  });
  await assert.rejects(timeout.analyze(ctx, defaults.apiKey), { code: "TIMEOUT" });
});
test("invalid or truncated output preserves billed usage without producing a record", async () => {
  const ctx = await context();
  for (const changes of [
    { choices: [{ finish_reason: "length", message: { content: "{}" } }] },
    { choices: [{ finish_reason: "stop", message: { content: "bad JSON" } }] },
    {
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify({ ...labels(ctx), transcript_sha256: "wrong" }) },
        },
      ],
    },
    { choices: [] },
  ]) {
    const model = new DeepSeekClient(async () => json(response(ctx, changes)));
    await assert.rejects(
      model.analyze(ctx, defaults.apiKey),
      (e) => e.details.usage.promptTokens === 1000,
    );
  }
});
test("shared cache opt-in and host permission are enforced before network", async () => {
  const ctx = await context();
  let calls = 0;
  const shared = new SharedClient(
    async () => {
      calls++;
    },
    async () => false,
  );
  assert.equal(await shared.lookup(ctx, defaults), null);
  await assert.rejects(shared.upload({ id: "x" }, defaults), { code: "SHARED_DISABLED" });
  await assert.rejects(
    shared.lookup(ctx, {
      ...defaults,
      sharedRead: true,
      sharedBaseUrl: "https://cache.example.com",
    }),
    { code: "SHARED_PERMISSION" },
  );
  assert.equal(calls, 0);
});
test("shared lookup accepts only published, versioned, context-bound labels", async () => {
  const ctx = await context();
  const settings = {
    ...defaults,
    sharedRead: true,
    sharedBaseUrl: "https://cache.example.com",
    sharedToken: "separate-server-token",
  };
  let payload = {
    schema_version: 1,
    status: "published",
    model: MODEL,
    prompt_version: PROMPT_VERSION,
    labels: labels(ctx),
  };
  const shared = new SharedClient(
    async (url, options) => {
      assert.ok(url.startsWith("https://cache.example.com/v1/segments?"));
      assert.equal(new URL(url).searchParams.get("transcript_sha256"), ctx.transcript_sha256);
      assert.equal(options.headers.Authorization, "Bearer separate-server-token");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      return json(payload);
    },
    async () => true,
  );
  assert.deepEqual(await shared.lookup(ctx, settings), labels(ctx));
  for (const patch of [
    { status: "pending" },
    { schema_version: 2 },
    { model: "other" },
    { prompt_version: "old" },
    { labels: { ...labels(ctx), transcript_sha256: "other" } },
  ]) {
    const saved = payload;
    payload = { ...payload, ...patch };
    await assert.rejects(shared.lookup(ctx, settings));
    payload = saved;
  }
  const miss = new SharedClient(
    async () => new Response("", { status: 404 }),
    async () => true,
  );
  assert.equal(await miss.lookup(ctx, settings), null);
});
test("candidate payload is an explicit projection and stable idempotency key", async () => {
  const ctx = await context();
  const value = labels(ctx);
  const record = {
    key: "cache-key",
    video: { ...ctx.video, cookie: "private-video-secret" },
    transcript_sha256: ctx.transcript_sha256,
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    labels: {
      ...value,
      secret: "private-label-secret",
      segments: value.segments.map((s) => ({ ...s, private: "private-segment-secret" })),
    },
    ...validateLabels(ctx, value),
    apiKey: "private-key",
    cues: [{ content: "private-full-transcript" }],
  };
  record.segments[0].evidence[0] = {
    ...record.segments[0].evidence[0],
    secret: "private-evidence-secret",
  };
  const shared = new SharedClient();
  const candidate = await shared.candidate(record);
  const again = await shared.candidate({ ...record, createdAt: 500 });
  assert.equal(candidate.id, again.id);
  assert.match(candidate.id, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(candidate.payload).includes("private"), false);
  assert.deepEqual(Object.keys(candidate.payload.labels).sort(), [
    "segments",
    "summary",
    "transcript_sha256",
    "video_key",
  ]);
  assert.equal(candidate.payload.segments[0].evidence.length, 2);
  let calls = 0;
  const uploader = new SharedClient(
    async (url, options) => {
      calls++;
      assert.equal(options.headers["Idempotency-Key"], candidate.id);
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), candidate.payload);
      return json({ schema_version: 1, status: "pending", submission_id: "test-submission" });
    },
    async () => true,
  );
  assert.equal(
    (
      await uploader.upload(candidate, {
        ...defaults,
        sharedUpload: true,
        sharedBaseUrl: "https://cache.example.com",
      })
    ).status,
    "pending",
  );
  assert.equal(calls, 1);
});
