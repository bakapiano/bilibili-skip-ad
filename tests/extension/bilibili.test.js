import { test } from "node:test";
import assert from "node:assert/strict";
import {
  subtitleUrl,
  protobufFields,
  parseTracks,
  boundedBody,
  BilibiliClient,
} from "../../extension/lib/bilibili.js";
import { body, ref, video, json } from "./fixtures.js";
import { cacheKey } from "../../extension/lib/core.js";

const varint = (input) => {
  let n = BigInt(input);
  const bytes = [];
  do {
    const byte = Number(n & 127n);
    n >>= 7n;
    bytes.push(byte | (n ? 128 : 0));
  } while (n);
  return bytes;
};
const field = (id, value) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...varint(id * 8 + 2), ...varint(bytes.length), ...bytes];
};
const track = (lan, file = lan) => ({
  lan,
  subtitle_url: `https://aisubtitle.hdslb.com/bfs/${file}.json`,
});
const protobuf = (tracks = [track("ai-zh", "test")]) =>
  new Uint8Array(
    field(
      1,
      tracks.flatMap((item) => field(3, [...field(3, item.lan), ...field(5, item.subtitle_url)])),
    ),
  );

// Fixed-response transport for language-selection regressions; no live model/API calls.
function languageFixture({ player = [], alternate = [], subtitle = () => json({ body }) } = {}) {
  const calls = [];
  const pauses = [];
  const client = new BilibiliClient(
    async (url, options) => {
      const target = new URL(url);
      calls.push({ url: target, options });
      if (target.pathname === "/x/web-interface/view") {
        return json({
          code: 0,
          data: {
            bvid: ref.bvid,
            aid: 1,
            title: video.title,
            pages: [{ cid: video.cid, duration: video.duration, part: video.part }],
          },
        });
      }
      if (target.pathname === "/x/player/wbi/v2") {
        return json({ code: 0, data: { subtitle: { subtitles: player } } });
      }
      if (target.pathname === "/x/v2/subtitle/web/view") {
        return typeof alternate === "function" ? alternate() : new Response(protobuf(alternate));
      }
      return subtitle(target);
    },
    async (ms) => pauses.push(ms),
  );
  return {
    client,
    calls,
    pauses,
    downloads: () => calls.filter((call) => call.url.hostname.endsWith(".hdslb.com")),
  };
}

test("subtitle priority is Chinese, English, then other languages with human tracks first", async (t) => {
  const cases = [
    { name: "human Chinese", player: ["en", "ai-zh", "zh-CN"], expected: "zh-cn" },
    { name: "AI Chinese before English", player: ["en", "ai-zh"], expected: "ai-zh" },
    { name: "normalized language tags", player: ["en", "AI_ZH_TW"], expected: "ai-zh-tw" },
    { name: "human English", player: ["ja", "ai-en", "EN_us"], expected: "en-us" },
    { name: "AI English before Japanese", player: ["ja", "ai-en"], expected: "ai-en" },
    { name: "other human language", player: ["ai-ja", "ko"], expected: "ko" },
    { name: "other AI language", player: ["ai-ja"], expected: "ai-ja" },
    { name: "Protobuf English", alternate: ["ja", "ai-en", "en"], expected: "en" },
    { name: "Protobuf other language", alternate: ["ja"], expected: "ja" },
    { name: "Chinese discovered later", player: ["en"], alternate: ["ai-zh"], expected: "ai-zh" },
    { name: "merged player English", player: ["en"], alternate: ["ja"], expected: "en" },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const f = languageFixture({
        player: item.player?.map((lan) => track(lan)),
        alternate: item.alternate?.map((lan) => track(lan)),
      });
      const ctx = await f.client.load(ref);
      assert.equal(ctx.source, `bilibili:${item.expected}`);
      assert.equal(ctx.cues.length, body.length);
      assert.equal(f.downloads().length, 1);
      assert.equal(f.downloads()[0].options.credentials, "omit");
      if (item.expected.includes("zh") && !item.alternate) {
        assert.equal(f.calls.length, 3);
      }
    });
  }
});

test("player English survives empty, unavailable or malformed alternate metadata", async (t) => {
  for (const [name, alternate, reads] of [
    ["empty envelope", () => new Response(protobuf([])), 2],
    ["HTTP failure", () => new Response("unavailable", { status: 503 }), 1],
    ["malformed protobuf", () => new Response(new Uint8Array([128])), 1],
  ]) {
    await t.test(name, async () => {
      const f = languageFixture({ player: [track("en")], alternate });
      assert.equal((await f.client.load(ref)).source, "bilibili:en");
      assert.equal(f.calls.length, reads + 3);
      assert.deepEqual(f.pauses, reads === 2 ? [350] : []);
    });
  }
});

test("broken Chinese resources fall back to English after download and content checks", async (t) => {
  for (const [name, response] of [
    ["HTTP failure", () => new Response("expired", { status: 403 })],
    ["empty body", () => json({ body: [] })],
    ["invalid timestamps", () => json({ body: [{ from: -1, to: 5, content: "bad" }] })],
    ["invalid JSON", () => new Response("private-signed-token")],
  ]) {
    await t.test(name, async () => {
      const f = languageFixture({
        player: [track("zh"), track("en")],
        subtitle: (url) => (url.pathname === "/bfs/zh.json" ? response() : json({ body })),
      });
      assert.equal((await f.client.load(ref)).source, "bilibili:en");
      assert.equal(f.downloads().length, 2);
    });
  }
});

test("duplicate tracks across endpoints and languages request each resource once", async () => {
  const f = languageFixture({
    player: [track("en"), track("ai-en", "en")],
    alternate: [
      { ...track("EN"), subtitle_url: "//aisubtitle.hdslb.com/bfs/en.json" },
      track("ja"),
    ],
    subtitle: (url) =>
      url.pathname === "/bfs/en.json"
        ? new Response("unavailable", { status: 403 })
        : json({ body }),
  });
  assert.equal((await f.client.load(ref)).source, "bilibili:ja");
  assert.deepEqual(
    f.downloads().map((call) => call.url.pathname),
    ["/bfs/en.json", "/bfs/ja.json"],
  );
  assert.equal(f.pauses.length, 0);
});

test("track fallback keeps the host allowlist and five-resource request bound", async () => {
  const f = languageFixture({
    player: [
      { lan: "zh", subtitle_url: "https://evil.test/subtitle?secret=private" },
      ...Array.from({ length: 8 }, (_, index) => track("en", `en-${index}`)),
    ],
    subtitle: () => new Response("private-signed-token", { status: 403 }),
  });
  await assert.rejects(
    f.client.load(ref),
    (error) => error.code === "HTTP" && !/secret|private/.test(error.message),
  );
  assert.equal(f.downloads().length, 5);
  assert.ok(f.calls.every((call) => call.url.hostname !== "evil.test"));
});

test("invalid track shapes are ignored and complete metadata failure keeps its diagnostic", async () => {
  const f = languageFixture({ player: [null, {}, { lan: 1 }, track("zh<script>"), track("en")] });
  assert.equal((await f.client.load(ref)).source, "bilibili:en");
  const broken = languageFixture({
    player: { malformed: true },
    alternate: () => new Response("unavailable", { status: 503 }),
  });
  await assert.rejects(broken.client.load(ref), { code: "HTTP" });
});

test("translated subtitle content produces a separate cache identity", async () => {
  const chinese = languageFixture({ player: [track("zh")] });
  const english = languageFixture({
    player: [track("en")],
    subtitle: () =>
      json({ body: body.map((cue, index) => ({ ...cue, content: `English caption ${index}` })) }),
  });
  const a = await chinese.client.load(ref);
  const b = await english.client.load(ref);
  assert.equal(a.video_key, b.video_key);
  assert.notEqual(a.transcript_sha256, b.transcript_sha256);
  assert.notEqual(cacheKey(a), cacheKey(b));
});

test("Protobuf fallback extracts the track and rejects malformed integers/wires", () => {
  assert.deepEqual(parseTracks(protobuf()), [
    { lan: "ai-zh", subtitle_url: "https://aisubtitle.hdslb.com/bfs/test.json" },
  ]);
  for (const bytes of [
    [128],
    [0],
    [10, 10, 1],
    [11],
    [...varint(2n ** 60n), 0],
    [8, ...Array(10).fill(255)],
    [...varint(0xffffffffn + 1n), 0],
  ]) {
    assert.throws(() => protobufFields(new Uint8Array(bytes)));
  }
  assert.equal(protobufFields(new Uint8Array([8, 5]))[0][2], 5n);
});
test("subtitle URL codec unwraps known format and guards protocol, credentials and host", () => {
  const prefix = 'nP](wOFRvU.+<fjS{jn-!$D|Dz&",zT`';
  const seed = "=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`bilibili";
  const plain = prefix + "/bfs/ai_subtitle/test.json";
  const encoded = encodeURIComponent(
    Array.from(plain, (c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ seed.charCodeAt(i % seed.length)),
    ).join(""),
  );
  const path = `subtitle.bilibili.com/${encoded}?auth_key=synthetic`;
  assert.equal(
    subtitleUrl(`https://${path}`),
    "https://aisubtitle.hdslb.com/bfs/ai_subtitle/test.json?auth_key=synthetic",
  );
  assert.equal(
    subtitleUrl("//aisubtitle.hdslb.com/bfs/test.json"),
    "https://aisubtitle.hdslb.com/bfs/test.json",
  );
  for (const url of [
    `http://${path}`,
    `https://u:p@${path}`,
    `https://subtitle.bilibili.com:8443/${encoded}`,
    "https://subtitle.bilibili.com/unknown",
    "https://evil.test/file",
    "https://x.hdslb.com.evil.test/file",
    "https://aisubtitle.hdslb.com/file#x",
  ]) {
    assert.throws(() => subtitleUrl(url));
  }
});
test("streaming responses enforce byte budget", async () => {
  assert.deepEqual(
    await boundedBody(new Response(new Uint8Array([1, 2, 3])), 3),
    new Uint8Array([1, 2, 3]),
  );
  await assert.rejects(boundedBody(new Response("12345"), 4), { code: "TOO_LARGE" });
  await assert.rejects(boundedBody(new Response("bad", { status: 503 })), { code: "HTTP" });
});
test("Bilibili load uses fresh metadata, Protobuf fallback and cookie isolation", async () => {
  const calls = [];
  const stages = [];
  const bili = new BilibiliClient(async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    if (path === "/x/web-interface/view") {
      return json({
        code: 0,
        data: {
          bvid: ref.bvid,
          aid: 1,
          title: "test",
          pages: [{ cid: video.cid, duration: video.duration, part: "P1" }],
        },
      });
    }
    if (path === "/x/player/wbi/v2") {
      return json({ code: 0, data: { subtitle: { subtitles: [] } } });
    }
    if (path === "/x/v2/subtitle/web/view") {
      return new Response(protobuf());
    }
    return json({ body });
  });
  const ctx = await bili.load(ref, (stage) => stages.push(stage));
  assert.equal(ctx.cues.length, 4);
  assert.equal(ctx.video.cid, video.cid);
  assert.deepEqual(stages, ["video", "subtitle"]);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[3].options.credentials, "omit");
  assert.ok(
    calls.every(
      (call) => call.options.redirect === "error" && call.options.signal instanceof AbortSignal,
    ),
  );
  assert.equal(JSON.stringify(ctx).includes("subtitle_url"), false);
  await assert.rejects(bili.request("https://evil.test/data"), { code: "HOST" });
});
test("metadata identity, missing subtitles and network failures have safe errors", async () => {
  const wrong = new BilibiliClient(async () =>
    json({ code: 0, data: { bvid: "BV1pFUDBKE8Y", aid: 1, pages: [] } }),
  );
  await assert.rejects(wrong.load(ref), { code: "VIDEO" });
  const failed = new BilibiliClient(async () => {
    throw new Error("secret-cookie");
  });
  await assert.rejects(
    failed.load(ref),
    (error) => error.code === "BILI_NETWORK" && !error.message.includes("secret"),
  );
  let reads = 0;
  const none = new BilibiliClient(
    async (url) => {
      if (new URL(url).pathname === "/x/v2/subtitle/web/view") {
        reads++;
        return new Response(new Uint8Array());
      }
      return json({
        code: 0,
        data: { bvid: ref.bvid, aid: 1, pages: [{ cid: video.cid, duration: 100 }] },
      });
    },
    async () => {},
  );
  await assert.rejects(none.load(ref), { code: "NO_SUBTITLE" });
  assert.equal(reads, 2);
});
test("one bounded retry recovers transient empty subtitle envelope", async () => {
  let reads = 0;
  let pauses = 0;
  const client = new BilibiliClient(
    async (url) => {
      const path = new URL(url).pathname;
      if (path === "/x/v2/subtitle/web/view") {
        return new Response(++reads === 1 ? new Uint8Array([10, 0]) : protobuf());
      }
      if (path === "/bfs/test.json") {
        return json({ body });
      }
      return json({
        code: 0,
        data: { bvid: ref.bvid, aid: 1, pages: [{ cid: video.cid, duration: 100 }] },
      });
    },
    async (ms) => {
      assert.equal(ms, 350);
      pauses++;
    },
  );
  assert.equal((await client.load(ref)).cues.length, 4);
  assert.equal(reads, 2);
  assert.equal(pauses, 1);
});
test("browser diagnostics distinguish transport, JSON and deadline without exposing URL tokens", async () => {
  const url = "https://aisubtitle.hdslb.com/bfs/synthetic?auth_key=private-signed-token";
  const failed = new BilibiliClient(async () => {
    throw new TypeError("private-signed-token");
  });
  await assert.rejects(
    failed.request(url),
    (error) =>
      error.code === "BILI_NETWORK" &&
      /字幕 CDN.*TypeError/.test(error.message) &&
      !error.message.includes("private"),
  );
  const html = new BilibiliClient(async () => new Response("<html>private-cookie</html>"));
  await assert.rejects(
    html.request(url),
    (error) => error.code === "BILI_JSON" && !error.message.includes("private"),
  );
  const timeout = new BilibiliClient(async () => {
    throw new DOMException("private-signed-token", "TimeoutError");
  });
  await assert.rejects(timeout.request(url), { code: "BILI_TIMEOUT" });
});
