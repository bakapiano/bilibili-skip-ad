import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, hash, normalize, fromUrl, identity, validateLabels, parseOutput, sharedOrigin, validateSettings, usageCost, safeError, publicRecord } from "../../extension/lib/core.js";
import { publicSettings, trustedUI, verifyPage } from "../../extension/lib/messaging.js";
import { context, labels, body, video, ref, defaults, usage } from "./fixtures.js";

test("stable canonical hash and subtitle normalization", async () => {
  assert.equal(canonical({ b: 2, a: [1, "中"] }), '{"a":[1,"中"],"b":2}');
  assert.equal(await hash({ b: 2, a: 1 }), await hash({ a: 1, b: 2 }));
  const ctx = await context();
  assert.equal(ctx.cues[0].id, 1); assert.match(ctx.transcript_sha256, /^[a-f0-9]{64}$/);
  assert.equal(ctx.transcript_sha256, (await context()).transcript_sha256);
  assert.notEqual(ctx.transcript_sha256, (await normalize({ ...video, cid: 99 }, body)).transcript_sha256);
  assert.notEqual(ctx.transcript_sha256, (await normalize(video, body.map((c, i) => ({ ...c, content: c.content + i })))).transcript_sha256);
});
test("invalid subtitle times, ordering, text and limits fail closed", async () => {
  for (const cues of [[], [{ from: -1, to: 2, content: "x" }], [{ from: 2, to: 1, content: "x" }],
    [{ from: 0, to: 102, content: "x" }], [{ from: NaN, to: 2, content: "x" }], [{ from: 0, to: 1, content: " " }],
    [{ from: 2, to: 4, content: "x" }, { from: 1, to: 3, content: "y" }]]) await assert.rejects(normalize(video, cues));
  await assert.rejects(normalize({ ...video, cid: "1" }, body));
  await assert.rejects(normalize(video, Array.from({ length: 20 }, (_, i) => ({ from: i, to: i + 1, content: "字".repeat(9000) }))));
});
test("URL identity pins host and exact BV/P", () => {
  assert.deepEqual(fromUrl(`https://www.bilibili.com/video/${ref.bvid}/?p=2`), { ...ref, page: 2 });
  for (const value of [`http://www.bilibili.com/video/${ref.bvid}`, `https://evil.test/video/${ref.bvid}`,
    `https://www.bilibili.com/video/${ref.bvid}other`, `https://www.bilibili.com/video/${ref.bvid}?p=1.2`,
    `https://www.bilibili.com/video/${ref.bvid}?p=1001`]) assert.equal(fromUrl(value), null);
  assert.throws(() => identity({ ...ref, page: 0 }));
});
test("labels bind to context and derive exact subtitle boundaries", async () => {
  const ctx = await context(), value = labels(ctx), parsed = validateLabels(ctx, value);
  assert.equal(parsed.segments[0].start, 10); assert.equal(parsed.segments[0].end, 20);
  assert.deepEqual(parsed.segments[0].evidence, ctx.cues.slice(1, 3));
  assert.deepEqual(validateLabels(ctx, { ...value, segments: [] }).segments, []);
  assert.throws(() => validateLabels(ctx, { ...value, transcript_sha256: "wrong" }), { code: "BINDING" });
  assert.throws(() => validateLabels(ctx, { ...value, video_key: "wrong" }));
  assert.throws(() => validateLabels(ctx, { ...value, apiKey: "unexpected" }));
});
test("strict validation rejects arbitrary timestamps, overlap, invalid evidence and confidence", async () => {
  const ctx = await context(), value = labels(ctx), seg = value.segments[0];
  for (const change of [{ start: 1 }, { start_id: 0 }, { end_id: 5 }, { start_id: 3, end_id: 2 },
    { confidence: NaN }, { confidence: 1.1 }, { confidence: "0.9" }, { brand: "" }, { reason: "" },
    { evidence_ids: [] }, { evidence_ids: [1] }, { evidence_ids: [2.5] }]) {
    assert.throws(() => validateLabels(ctx, { ...value, segments: [{ ...seg, ...change }] }));
  }
  assert.throws(() => validateLabels(ctx, { ...value, segments: [seg, seg] }));
  assert.throws(() => parseOutput("```json\n{}\n```"));
});
test("settings allowlist, explicit opt-in and public HTTPS origin validation", () => {
  assert.equal(validateSettings({ apiKey: "secret" }).apiKey, undefined);
  assert.equal(validateSettings().autoSkip, false);
  assert.equal(validateSettings().sharedRead, false);
  assert.throws(() => validateSettings({ autoAnalyze: true }));
  assert.throws(() => validateSettings({ sharedUpload: true }));
  assert.throws(() => validateSettings({ confidenceThreshold: 0.2 }));
  assert.equal(sharedOrigin("https://cache.example.com/"), "https://cache.example.com");
  for (const url of ["http://cache.example.com", "https://127.0.0.1", "https://localhost", "https://x.local", "https://x.internal",
    "https://u:p@cache.example.com", "https://cache.example.com/path", "https://cache.example.com:8443", "https://cache.example.com/?a=b"])
    assert.throws(() => sharedOrigin(url));
});
test("usage estimates account for cache hits and protect against malformed accounting", () => {
  const result = usageCost(usage);
  assert.equal(result.offPeakCny, 0.001302); assert.equal(result.peakCny, 0.002604);
  assert.equal(result.cacheBasis, "measured");
  assert.equal(usageCost({ prompt_tokens: 1000, completion_tokens: 100 }).cacheBasis, "all-miss-estimate");
  assert.throws(() => usageCost({ ...usage, prompt_cache_hit_tokens: 200 }));
  assert.throws(() => usageCost({ prompt_tokens: -1, completion_tokens: 0 }));
});
test("secret fields stay outside page-facing settings, records and generic errors", () => {
  const projected = publicSettings({ ...defaults, sharedToken: "private-shared", surprise: "private-extra" });
  assert.equal(projected.hasKey, true); assert.equal(projected.apiKey, undefined); assert.equal(projected.sharedToken, undefined);
  assert.equal(projected.surprise, undefined);
  assert.equal(publicRecord({ source: "deepseek", apiKey: "private", labels: {} }).apiKey, undefined);
  assert.equal(publicRecord({ source: "deepseek", labels: {} }).labels, undefined);
  assert.equal(JSON.stringify(safeError(new Error("private-secret"))).includes("private-secret"), false);
});
test("sender validation separates extension UI from top-frame matching video pages", () => {
  const runtime = { id: "test-extension", getURL: path => `chrome-extension://test-extension/${path}` };
  const sender = { id: runtime.id, url: `https://www.bilibili.com/video/${ref.bvid}`, frameId: 0, tab: { id: 1 } };
  assert.deepEqual(verifyPage(sender, ref, runtime.id), ref);
  for (const bad of [{ ...sender, frameId: 1 }, { ...sender, id: "other" }, { ...sender, tab: undefined },
    { ...sender, url: `https://evil.test/video/${ref.bvid}` }]) assert.throws(() => verifyPage(bad, ref, runtime.id));
  assert.throws(() => verifyPage(sender, { ...ref, page: 2 }, runtime.id));
  assert.equal(trustedUI(sender, runtime), false);
  assert.equal(trustedUI({ id: runtime.id, url: runtime.getURL("options.html#cache") }, runtime), true);
  assert.equal(trustedUI({ id: runtime.id, url: runtime.getURL("options.html/evil") }, runtime), false);
  assert.equal(trustedUI({ id: "other", url: runtime.getURL("popup.html") }, runtime), false);
});
test("SPA authorization uses current Chrome tab URL while preserving sender origin checks", () => {
  const original = { id: "self", frameId: 0, tab: { id: 1 }, url: `https://www.bilibili.com/video/${ref.bvid}` };
  const next = { bvid: "BV1WhE1zeEWH", page: 1 }, currentUrl = `https://www.bilibili.com/video/${next.bvid}`;
  assert.deepEqual(verifyPage(original, next, "self", currentUrl), next);
  assert.throws(() => verifyPage(original, ref, "self", currentUrl), { code: "SENDER" });
  assert.throws(() => verifyPage({ ...original, url: "https://evil.test" }, next, "self", currentUrl), { code: "SENDER" });
});
