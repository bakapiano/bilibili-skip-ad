import { test } from "node:test";
import assert from "node:assert/strict";
import { subtitleUrl, protobufFields, parseTracks, boundedBody, BilibiliClient } from "../../extension/lib/bilibili.js";
import { body, ref, video, json } from "./fixtures.js";

const varint = input => { let n = BigInt(input), bytes = []; do { const byte = Number(n & 127n); n >>= 7n; bytes.push(byte | (n ? 128 : 0)); } while (n); return bytes; };
const field = (id, value) => { const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value; return [...varint(id * 8 + 2), ...varint(bytes.length), ...bytes]; };
const protobuf = () => new Uint8Array(field(1, field(3, [...field(3, "ai-zh"), ...field(4, "中文"), ...field(5, "https://aisubtitle.hdslb.com/bfs/test.json")])));

test("Protobuf fallback extracts the track and rejects malformed integers/wires", () => {
  assert.deepEqual(parseTracks(protobuf()), [{ lan: "ai-zh", subtitle_url: "https://aisubtitle.hdslb.com/bfs/test.json" }]);
  for (const bytes of [[128], [0], [10, 10, 1], [11], [...varint(2n ** 60n), 0], [8, ...Array(10).fill(255)], [...varint(0xffffffffn + 1n), 0]])
    assert.throws(() => protobufFields(new Uint8Array(bytes)));
  assert.equal(protobufFields(new Uint8Array([8, 5]))[0][2], 5n);
});
test("subtitle URL codec unwraps known format and guards protocol, credentials and host", () => {
  const prefix = 'nP](wOFRvU.+<fjS{jn-!$D|Dz&",zT`', seed = '=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`bilibili';
  const plain = prefix + "/bfs/ai_subtitle/test.json";
  const encoded = encodeURIComponent(Array.from(plain, (c, i) => String.fromCharCode(c.charCodeAt(0) ^ seed.charCodeAt(i % seed.length))).join(""));
  const path = `subtitle.bilibili.com/${encoded}?auth_key=synthetic`;
  assert.equal(subtitleUrl(`https://${path}`), "https://aisubtitle.hdslb.com/bfs/ai_subtitle/test.json?auth_key=synthetic");
  assert.equal(subtitleUrl("//aisubtitle.hdslb.com/bfs/test.json"), "https://aisubtitle.hdslb.com/bfs/test.json");
  for (const url of [`http://${path}`, `https://u:p@${path}`, `https://subtitle.bilibili.com:8443/${encoded}`,
    "https://subtitle.bilibili.com/unknown", "https://evil.test/file", "https://x.hdslb.com.evil.test/file", "https://aisubtitle.hdslb.com/file#x"])
    assert.throws(() => subtitleUrl(url));
});
test("streaming responses enforce byte budget", async () => {
  assert.deepEqual(await boundedBody(new Response(new Uint8Array([1, 2, 3])), 3), new Uint8Array([1, 2, 3]));
  await assert.rejects(boundedBody(new Response("12345"), 4), { code: "TOO_LARGE" });
  await assert.rejects(boundedBody(new Response("bad", { status: 503 })), { code: "HTTP" });
});
test("Bilibili load uses fresh metadata, Protobuf fallback and cookie isolation", async () => {
  const calls = [], stages = [];
  const bili = new BilibiliClient(async (url, options) => {
    calls.push({ url, options }); const path = new URL(url).pathname;
    if (path === "/x/web-interface/view") return json({ code: 0, data: { bvid: ref.bvid, aid: 1, title: "test", pages: [{ cid: video.cid, duration: video.duration, part: "P1" }] } });
    if (path === "/x/player/wbi/v2") return json({ code: 0, data: { subtitle: { subtitles: [] } } });
    if (path === "/x/v2/subtitle/web/view") return new Response(protobuf());
    return json({ body });
  });
  const ctx = await bili.load(ref, stage => stages.push(stage));
  assert.equal(ctx.cues.length, 4); assert.equal(ctx.video.cid, video.cid); assert.deepEqual(stages, ["video", "subtitle"]);
  assert.equal(calls.length, 4); assert.equal(calls[0].options.credentials, "include"); assert.equal(calls[3].options.credentials, "omit");
  assert.ok(calls.every(call => call.options.redirect === "error" && call.options.signal instanceof AbortSignal));
  assert.equal(JSON.stringify(ctx).includes("subtitle_url"), false);
  await assert.rejects(bili.request("https://evil.test/data"), { code: "HOST" });
});
test("metadata identity, missing subtitles and network failures have safe errors", async () => {
  const wrong = new BilibiliClient(async () => json({ code: 0, data: { bvid: "BV1pFUDBKE8Y", aid: 1, pages: [] } }));
  await assert.rejects(wrong.load(ref), { code: "VIDEO" });
  const failed = new BilibiliClient(async () => { throw new Error("secret-cookie"); });
  await assert.rejects(failed.load(ref), error => error.code === "BILI_NETWORK" && !error.message.includes("secret"));
  let reads = 0;
  const none = new BilibiliClient(async url => {
    if (new URL(url).pathname === "/x/v2/subtitle/web/view") { reads++; return new Response(new Uint8Array()); }
    return json({ code: 0, data: { bvid: ref.bvid, aid: 1, pages: [{ cid: video.cid, duration: 100 }] } });
  }, async () => {});
  await assert.rejects(none.load(ref), { code: "NO_SUBTITLE" });
  assert.equal(reads, 2);
});
test("one bounded retry recovers transient empty subtitle envelope", async () => {
  let reads = 0, pauses = 0;
  const client = new BilibiliClient(async url => {
    const path = new URL(url).pathname;
    if (path === "/x/v2/subtitle/web/view") return new Response(++reads === 1 ? new Uint8Array([10, 0]) : protobuf());
    if (path === "/bfs/test.json") return json({ body });
    return json({ code: 0, data: { bvid: ref.bvid, aid: 1, pages: [{ cid: video.cid, duration: 100 }] } });
  }, async ms => { assert.equal(ms, 350); pauses++; });
  assert.equal((await client.load(ref)).cues.length, 4); assert.equal(reads, 2); assert.equal(pauses, 1);
});
test("browser diagnostics distinguish transport, JSON and deadline without exposing URL tokens", async () => {
  const url = "https://aisubtitle.hdslb.com/bfs/synthetic?auth_key=private-signed-token";
  const failed = new BilibiliClient(async () => { throw new TypeError("private-signed-token"); });
  await assert.rejects(failed.request(url), error => error.code === "BILI_NETWORK" && /字幕 CDN.*TypeError/.test(error.message) && !error.message.includes("private"));
  const html = new BilibiliClient(async () => new Response("<html>private-cookie</html>"));
  await assert.rejects(html.request(url), error => error.code === "BILI_JSON" && !error.message.includes("private"));
  const timeout = new BilibiliClient(async () => { throw new DOMException("private-signed-token", "TimeoutError"); });
  await assert.rejects(timeout.request(url), { code: "BILI_TIMEOUT" });
});
