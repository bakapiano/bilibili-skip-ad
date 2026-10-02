import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCacheServer, MAX_BODY_BYTES } from "../server/app.js";
import { clientIp, normalizeIp, readConfig } from "../server/config.js";
import { CacheStore } from "../server/store.js";
import { statsBadge } from "../server/badges.js";
import { HttpError, payloadHash, validateCandidate } from "../server/validation.js";
import { SharedClient } from "../extension/lib/providers.js";
import { validateLabels } from "../extension/lib/core.js";
import { MODEL, PROMPT_VERSION } from "../extension/lib/constants.js";
import { AnalysisService } from "../extension/lib/service.js";
import { context, labels, database, defaults } from "./extension/fixtures.js";

const SUPPORTED_PROMPTS = [
  "ad-cues-v1",
  "ad-cues-v2-compact",
  "ad-cues-v3-pipe",
  "ad-cues-v4-topic",
  "ad-cues-v5-obvious",
  "ad-cues-v6-json",
];

async function candidate() {
  const ctx = await context();
  const value = labels(ctx);
  const result = await new SharedClient().candidate({
    key: "test-cache",
    video: ctx.video,
    transcript_sha256: ctx.transcript_sha256,
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    labels: value,
    ...validateLabels(ctx, value),
  });
  return { ctx, ...result };
}

function query(ctx) {
  return new URLSearchParams({
    bvid: ctx.video.bvid,
    page: ctx.video.page,
    cid: ctx.video.cid,
    transcript_sha256: ctx.transcript_sha256,
    model: MODEL,
    prompt_version: PROMPT_VERSION,
  });
}

async function fixture(t, options = {}) {
  const store = new CacheStore(":memory:");
  const clock = { value: Date.now() };
  const server = createCacheServer({ store, now: () => clock.value, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (value, headers = {}) =>
    fetch(`${origin}/v1/candidates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": typeof value === "string" ? "a".repeat(64) : payloadHash(value),
        ...headers,
      },
      body: typeof value === "string" ? value : JSON.stringify(value),
    });
  return { store, clock, origin, post };
}

test("public stats are aggregate-only, cacheable and independent of private credentials", async (t) => {
  const app = await fixture(t, { token: "private-test-token" });
  const response = await fetch(`${app.origin}/v1/stats`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  const result = await response.json();
  assert.deepEqual(result, {
    schema_version: 1,
    cached_videos: 0,
    cached_parts: 0,
    cached_records: 0,
    ad_segments: 0,
    saved_seconds: 0,
    basis: "latest-active-per-video-part-ad-duration",
    updated_at: new Date(app.clock.value).toISOString(),
  });
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM ip_counts").get().count, 0);
  assert.equal((await fetch(`${app.origin}/v1/stats?ip=anything`)).status, 400);
  assert.equal((await fetch(`${app.origin}/v1/stats`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${app.origin}/v1/stats`, { method: "OPTIONS" })).status, 204);
});

test("public badges expose only fixed cache aggregates and preserve IP submission counters", async (t) => {
  const app = await fixture(t, { token: "private-test-token" });
  const item = await candidate();
  app.store.save(
    validateCandidate(item.payload, item.id),
    item.id,
    item.payload,
    "192.0.2.7",
    app.clock.value,
  );
  for (const [metric, label, message] of [
    ["videos", "缓存视频", "1 个"],
    ["segments", "广告片段", "1 段"],
    ["saved-time", "节省时间", "10 秒"],
  ]) {
    const response = await fetch(`${app.origin}/v1/badges/${metric}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=300");
    assert.deepEqual(await response.json(), {
      schemaVersion: 1,
      label,
      message,
      color: "3b82f6",
      cacheSeconds: 300,
    });
    assert.equal((await fetch(`${app.origin}/v1/badges/${metric}?url=anything`)).status, 400);
    assert.equal(
      (await fetch(`${app.origin}/v1/badges/${metric}`, { method: "POST" })).status,
      405,
    );
    assert.equal(
      (await fetch(`${app.origin}/v1/badges/${metric}`, { method: "OPTIONS" })).status,
      204,
    );
  }
  assert.equal((await fetch(`${app.origin}/v1/badges/users`)).status, 404);
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM ip_counts").get().count, 0);
  assert.equal(app.store.publicStats().cached_records, 1);
});

test("badge values format zero, count separators and cumulative ad duration", () => {
  const stats = { cached_videos: 1234, ad_segments: 5678, saved_seconds: 0 };
  assert.equal(statsBadge("videos", stats).message, "1,234 个");
  assert.equal(statsBadge("segments", stats).message, "5,678 段");
  for (const [seconds, message] of [
    [0, "0 秒"],
    [59.9, "59 秒"],
    [90, "1.5 分钟"],
    [3600, "1.0 小时"],
    [5400, "1.5 小时"],
  ]) {
    assert.equal(statsBadge("saved-time", { ...stats, saved_seconds: seconds }).message, message);
  }
  assert.throws(() => statsBadge("__proto__", stats));
});

test("retired results API returns 404 while shared-cache stats and stored results remain available", async (t) => {
  const app = await fixture(t);
  const item = await candidate();
  assert.equal((await app.post(item.payload)).status, 201);
  for (const method of ["GET", "POST", "OPTIONS"]) {
    for (const path of ["/v1/results", "/v1/results?page=1&filter=protected"]) {
      const response = await fetch(`${app.origin}${path}`, { method });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.code, "NOT_FOUND");
    }
  }
  assert.equal((await fetch(`${app.origin}/v1/stats`)).status, 200);
  assert.equal((await fetch(`${app.origin}/v1/segments?${query(item.ctx)}`)).status, 200);
  assert.equal(app.store.publicStats().cached_records, 1);
});

test("stats deduplicate versions and replaced media, count parts, zero ads and revoked rows", async (t) => {
  const app = await fixture(t);
  const item = await candidate();
  let number = 0;
  const add = (changes = {}) => {
    const payload = structuredClone(item.payload);
    payload.video = { ...payload.video, ...changes.video };
    payload.prompt_version = changes.version || PROMPT_VERSION;
    payload.labels.video_key = `${payload.video.bvid}:p${payload.video.page}:${payload.video.cid}`;
    payload.labels.summary = `Synthetic aggregate fixture ${++number}`;
    if (changes.zeroAds) {
      payload.labels.segments = [];
      payload.segments = [];
    } else if (changes.end) {
      payload.segments[0].end = changes.end;
    }
    const requestHash = payloadHash(payload);
    const key = validateCandidate(payload, requestHash);
    app.clock.value += 1001;
    return app.store.save(key, requestHash, payload, "192.0.2.5", app.clock.value).receipt
      .submission_id;
  };
  add({ version: "ad-cues-v1" });
  assert.equal(app.store.publicStats(app.clock.value).saved_seconds, 10);
  add({ version: "ad-cues-v2-compact", end: 25.125 });
  assert.equal(app.store.publicStats(app.clock.value).saved_seconds, 15.125);
  add({ video: { cid: 987654321 }, end: 30 });
  assert.equal(app.store.publicStats(app.clock.value).saved_seconds, 20);
  add({ video: { page: 2, cid: 987654322 } });
  const otherId = add({ video: { bvid: "BV191Yr6bEYy" }, zeroAds: true });
  const stats = app.store.publicStats(app.clock.value);
  assert.deepEqual(
    [
      stats.cached_videos,
      stats.cached_parts,
      stats.cached_records,
      stats.ad_segments,
      stats.saved_seconds,
    ],
    [2, 3, 5, 2, 30],
  );
  assert.strictEqual(app.store.publicStats(app.clock.value + 59999), stats);
  assert.notStrictEqual(app.store.publicStats(app.clock.value + 60000), stats);
  const zeroId = add({ zeroAds: true });
  assert.equal(app.store.publicStats(app.clock.value).saved_seconds, 10);
  app.store.revoke(zeroId);
  assert.equal(app.store.publicStats(app.clock.value).saved_seconds, 30);
  app.store.revoke(otherId);
  assert.equal(app.store.publicStats(app.clock.value).cached_videos, 1);
});

test("shared-cache HTTP round trip uses the real extension uploader, lookup and IndexedDB service", async (t) => {
  const app = await fixture(t);
  const item = await candidate();
  const settings = {
    ...defaults,
    sharedBaseUrl: "https://cache.example.com",
    sharedRead: true,
    sharedUpload: true,
  };
  const client = new SharedClient(
    (url, init) => {
      const remote = new URL(url);
      assert.equal(remote.origin, settings.sharedBaseUrl);
      return fetch(`${app.origin}${remote.pathname}${remote.search}`, init);
    },
    async () => true,
  );
  assert.equal(await client.lookup(item.ctx, settings), null);
  const receipt = await client.upload(item, settings);
  assert.equal(receipt.status, "accepted");
  const sharedLabels = await client.lookup(item.ctx, settings);
  assert.deepEqual(sharedLabels, labels(item.ctx));
  assert.deepEqual(validateLabels(item.ctx, sharedLabels).segments[0].start, 10);
  const db = database();
  t.after(async () => (await db.open()).close());
  const service = new AnalysisService({
    db,
    bili: { load: async () => item.ctx },
    model: { analyze: async () => assert.fail("Shared cache should satisfy the request") },
    shared: client,
    settings: async () => settings,
  });
  assert.equal((await service.prepare(item.ctx.video)).record.source, "shared");
  assert.equal((await service.prepare(item.ctx.video)).record.source, "local-cache");
  assert.equal((await db.stats()).apiCalls, 0);
});

test("all prompt generations coexist under separate shared cache identities", async (t) => {
  const app = await fixture(t);
  const item = await candidate();
  for (const version of SUPPORTED_PROMPTS) {
    const payload = structuredClone(item.payload);
    payload.prompt_version = version;
    payload.labels.summary = version;
    assert.equal((await app.post(payload)).status, 201);
    app.clock.value += 1001;
  }
  for (const version of SUPPORTED_PROMPTS) {
    const params = query(item.ctx);
    params.set("prompt_version", version);
    const response = await fetch(`${app.origin}/v1/segments?${params}`);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.prompt_version, version);
    assert.equal(value.labels.summary, version);
  }
  const invalid = query(item.ctx);
  invalid.set("prompt_version", "unreviewed-version");
  assert.equal((await fetch(`${app.origin}/v1/segments?${invalid}`)).status, 400);
});

test("pipe records allow explicit empty evidence and preserve it through shared round trips", async (t) => {
  const app = await fixture(t);
  const item = await candidate();
  item.payload.labels.segments[0].evidence_ids = [];
  item.payload.segments[0].evidence_ids = [];
  item.payload.segments[0].evidence = [];
  for (const version of ["ad-cues-v1", "ad-cues-v2-compact"]) {
    const legacy = structuredClone(item.payload);
    legacy.prompt_version = version;
    assert.throws(() => validateCandidate(legacy, payloadHash(legacy)), HttpError);
  }
  for (const version of [
    "ad-cues-v3-pipe",
    "ad-cues-v4-topic",
    "ad-cues-v5-obvious",
    "ad-cues-v6-json",
  ]) {
    const payload = structuredClone(item.payload);
    payload.prompt_version = version;
    assert.equal((await app.post(payload)).status, 201);
    const params = query(item.ctx);
    params.set("prompt_version", version);
    const response = await fetch(`${app.origin}/v1/segments?${params}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.prompt_version, version);
    assert.deepEqual(result.labels.segments[0].evidence_ids, []);
    assert.deepEqual(validateLabels(item.ctx, result.labels).segments[0].evidence, []);
    app.clock.value += 1001;
  }
});

test("v5 zero-ad records round trip, remain version-isolated and preserve idempotency", async (t) => {
  const app = await fixture(t);
  const item = await candidate();
  const payload = structuredClone(item.payload);
  payload.prompt_version = "ad-cues-v5-obvious";
  payload.labels.segments = [];
  payload.segments = [];
  const first = await app.post(payload);
  assert.equal(first.status, 201);
  const receipt = await first.json();
  const params = query(item.ctx);
  params.set("prompt_version", "ad-cues-v5-obvious");
  const response = await fetch(`${app.origin}/v1/segments?${params}`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).labels.segments, []);
  params.set("prompt_version", "ad-cues-v3-pipe");
  assert.equal((await fetch(`${app.origin}/v1/segments?${params}`)).status, 404);
  app.clock.value += 1001;
  const duplicate = await app.post(payload);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), receipt);
  const stats = app.store.publicStats(app.clock.value);
  assert.equal(stats.cached_records, 1);
  assert.equal(stats.cached_videos, 1);
  assert.equal(stats.saved_seconds, 0);
});

test("one IP gets one admitted submission per sliding 1000ms, including duplicate submissions", async (t) => {
  const app = await fixture(t);
  const item = await candidate();
  const first = await app.post(item.payload);
  assert.equal(first.status, 201);
  const receipt = await first.json();
  app.clock.value += 999;
  const blocked = await app.post(item.payload);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "1");
  assert.equal((await blocked.json()).error.code, "RATE_LIMITED");
  app.clock.value += 1;
  const retry = await app.post(item.payload);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), receipt);
  const [count] = app.store.stats();
  assert.deepEqual([count.attempts, count.limited, count.stored], [3, 1, 1]);
});

test("fresh model result automatically travels through HTTP into SQLite and a second client cache", async (t) => {
  const app = await fixture(t);
  const ctx = await context();
  const settings = { ...defaults, sharedRead: true, sharedUpload: true, autoUpload: true };
  let uploads = 0;
  const shared = new SharedClient(
    (url, init) => {
      const remote = new URL(url);
      if (init.method === "POST") {
        uploads++;
      }
      return fetch(`${app.origin}${remote.pathname}${remote.search}`, init);
    },
    async () => true,
  );
  const make = () => {
    const db = database();
    t.after(async () => (await db.open()).close());
    return new AnalysisService({
      db,
      bili: { load: async () => ctx },
      model: { analyze: async () => ({ labels: labels(ctx) }) },
      shared,
      settings: async () => settings,
    });
  };
  const producer = make();
  const result = await producer.analyze(ctx.video);
  assert.match(result.notice, /已自动上传/);
  assert.equal(uploads, 1);
  assert.equal(app.store.recent().length, 1);
  const consumer = make();
  assert.equal((await consumer.prepare(ctx.video)).record.source, "shared");
  assert.equal((await consumer.db.stats()).apiCalls, 0);
  await producer.upload(result.record.key);
  assert.equal(uploads, 1);
});

test("concurrent submissions from the same IP share one atomic SQLite limit", async (t) => {
  const app = await fixture(t);
  const item = await candidate();
  const responses = await Promise.all(Array.from({ length: 8 }, () => app.post(item.payload)));
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [201, 429, 429, 429, 429, 429, 429, 429],
  );
  await Promise.all(responses.map((response) => response.text()));
  assert.equal(app.store.stats()[0].attempts, 8);
});

test("invalid JSON and failed authentication consume the same submission interval", async (t) => {
  const app = await fixture(t, { token: "independent-test-token" });
  const item = await candidate();
  assert.equal((await app.post(item.payload)).status, 401);
  const auth = { Authorization: "Bearer independent-test-token" };
  assert.equal((await app.post(item.payload, auth)).status, 429);
  app.clock.value += 1000;
  assert.equal((await app.post("{broken", auth)).status, 400);
  assert.equal((await app.post(item.payload, auth)).status, 429);
  app.clock.value += 1000;
  assert.equal((await app.post(item.payload, auth)).status, 201);
  assert.equal((await fetch(`${app.origin}/v1/segments?${query(item.ctx)}`)).status, 401);
  assert.equal(
    (await fetch(`${app.origin}/v1/segments?${query(item.ctx)}`, { headers: auth })).status,
    200,
  );
});

test("direct clients cannot choose their IP through forwarding headers", async (t) => {
  const app = await fixture(t);
  const item = await candidate();
  assert.equal(
    (
      await app.post(item.payload, {
        "X-Real-IP": "198.51.100.1",
        "X-Forwarded-For": "198.51.100.2",
      })
    ).status,
    201,
  );
  assert.equal((await app.post(item.payload, { "X-Real-IP": "203.0.113.9" })).status, 429);
  assert.equal(app.store.stats()[0].ip, "127.0.0.1");
});

test("only configured proxy peers can provide a single X-Real-IP", async (t) => {
  const app = await fixture(t, { trustedProxies: [normalizeIp("127.0.0.1")] });
  const item = await candidate();
  assert.equal((await app.post(item.payload, { "X-Real-IP": "198.51.100.1" })).status, 201);
  assert.equal((await app.post(item.payload, { "X-Real-IP": "198.51.100.2" })).status, 200);
  assert.equal((await app.post(item.payload, { "X-Real-IP": "198.51.100.1" })).status, 429);
  assert.equal(
    (await app.post(item.payload, { "X-Real-IP": "198.51.100.3, 198.51.100.4" })).status,
    400,
  );
  assert.equal(app.store.stats().length, 2);
});

test("IP normalization merges IPv4-mapped addresses and rotating IPv6 /64 addresses", () => {
  assert.equal(normalizeIp("::ffff:c000:201"), "192.0.2.1");
  assert.equal(normalizeIp("::ffff:192.0.2.1"), "192.0.2.1");
  const get = (ip) => clientIp({ socket: { remoteAddress: ip }, headers: {} });
  assert.equal(get("2001:db8:1:2::1"), get("2001:0DB8:0001:0002::ffff"));
  assert.notEqual(get("2001:db8:1:2::1"), get("2001:db8:1:3::1"));
  assert.throws(() => normalizeIp("fe80::1%eth0"), HttpError);
});

test("a populated cache keeps its first record and supports local revocation", async (t) => {
  const app = await fixture(t);
  const item = await candidate();
  const first = await (await app.post(item.payload)).json();
  app.clock.value += 1000;
  const changed = structuredClone(item.payload);
  changed.labels.summary = "Different submission for the same cache identity";
  assert.equal((await app.post(changed)).status, 409);
  assert.deepEqual(
    (await (await fetch(`${app.origin}/v1/segments?${query(item.ctx)}`)).json()).labels,
    item.payload.labels,
  );
  assert.equal(app.store.revoke(first.submission_id), 1);
  assert.equal((await fetch(`${app.origin}/v1/segments?${query(item.ctx)}`)).status, 404);
  app.clock.value += 1000;
  assert.equal((await app.post(item.payload)).status, 410);
  assert.equal((await fetch(`${app.origin}/admin`)).status, 404);
});

test("candidate validation constrains fields, identity, versions, timestamps and evidence", async () => {
  const item = await candidate();
  assert.equal(payloadHash(item.payload), item.id);
  const patches = [
    (p) => {
      p.apiKey = "private-test-only";
    },
    (p) => {
      p.video.bvid = "invalid";
    },
    (p) => {
      p.video.page = 0;
    },
    (p) => {
      p.video.duration = 0;
    },
    (p) => {
      p.labels.transcript_sha256 = "a".repeat(64);
    },
    (p) => {
      p.model = "other";
    },
    (p) => {
      p.prompt_version = "other";
    },
    (p) => {
      p.labels.segments[0].brand = { injected: true };
    },
    (p) => {
      p.segments[0].start = -1;
    },
    (p) => {
      p.segments[0].end = 1000;
    },
    (p) => {
      p.labels.segments[0].confidence = 2;
    },
    (p) => {
      p.segments[0].reason = "conflicting reason";
    },
    (p) => {
      p.segments[0].evidence[0].id = 99;
    },
    (p) => {
      p.segments[0].evidence[0].to = 90;
    },
    (p) => {
      p.segments[0].evidence[0].content = "x".repeat(501);
    },
    (p) => {
      p.segments.push(p.segments[0]);
      p.labels.segments.push(p.labels.segments[0]);
    },
  ];
  for (const patch of patches) {
    const payload = structuredClone(item.payload);
    patch(payload);
    assert.throws(() => validateCandidate(payload, payloadHash(payload)), HttpError);
  }
  assert.throws(() => validateCandidate(item.payload, "a".repeat(64)), HttpError);
  const empty = structuredClone(item.payload);
  empty.labels.segments = [];
  empty.segments = [];
  assert.equal(typeof validateCandidate(empty, payloadHash(empty)), "string");
});

test("query validation rejects missing, duplicate and unknown cache dimensions", async (t) => {
  const app = await fixture(t);
  const item = await candidate();
  const base = query(item.ctx).toString();
  for (const value of [
    "",
    `${base}&page=1`,
    `${base}&extra=1`,
    base.replace("page=1", "page=01"),
    base.replace(MODEL, "unknown"),
  ]) {
    assert.equal((await fetch(`${app.origin}/v1/segments?${value}`)).status, 400);
  }
});

test("HTTP guards enforce content type, content encoding, body size and CORS", async (t) => {
  const app = await fixture(t);
  const item = await candidate();
  assert.equal((await app.post(item.payload, { "Content-Type": "text/plain" })).status, 415);
  app.clock.value += 1000;
  assert.equal((await app.post(item.payload, { "Content-Encoding": "gzip" })).status, 415);
  app.clock.value += 1000;
  assert.equal((await app.post("x".repeat(MAX_BODY_BYTES + 1))).status, 413);
  const preflight = await fetch(`${app.origin}/v1/candidates`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-headers"), /Idempotency-Key/);
  assert.equal((await fetch(`${app.origin}/healthz`)).status, 200);
  assert.equal((await fetch(`${app.origin}/v1/candidates`)).status, 405);
});

async function chunked(origin, body, finish = true) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${origin}/v1/candidates`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          request.destroy();
          resolve({ status: response.statusCode, data: JSON.parse(data) });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.write(body);
    if (finish) {
      request.end();
    }
  });
}

test("streamed oversized bodies and stalled uploads are bounded", async (t) => {
  // Isolate size rejection from the deliberately short timeout used by the stalled-body case.
  const app = await fixture(t);
  assert.equal((await chunked(app.origin, "x".repeat(MAX_BODY_BYTES + 1))).status, 413);
  const stalled = await fixture(t, { bodyTimeoutMs: 50 });
  assert.equal((await chunked(stalled.origin, "{", false)).status, 408);
});

test("SQLite preserves limits and cached records across restart and midnight", async () => {
  const root = fileURLToPath(new URL("../.tmp/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(path.join(root, "server-test-"));
  const filename = path.join(folder, "cache.sqlite");
  const item = await candidate();
  const key = validateCandidate(item.payload, item.id);
  const midnight = Math.floor(Date.now() / 86400000) * 86400000;
  let store;
  try {
    store = new CacheStore(filename);
    assert.equal(store.consume("192.0.2.1", midnight - 1).allowed, true);
    store.save(key, item.id, item.payload, "192.0.2.1", midnight - 1);
    store.close();
    store = new CacheStore(filename);
    assert.equal(store.consume("192.0.2.1", midnight).allowed, false);
    assert.equal(store.consume("192.0.2.1", midnight + 999).allowed, true);
    assert.deepEqual(store.lookup(key).labels, item.payload.labels);
  } finally {
    store?.close();
    assert.ok(path.resolve(folder).startsWith(path.resolve(root) + path.sep));
    rmSync(folder, { recursive: true });
  }
});

test("daily counts are informational and expire after seven UTC dates", () => {
  const store = new CacheStore(":memory:");
  const now = Math.floor(Date.now() / 86400000) * 86400000;
  try {
    for (let index = 0; index < 120; index++) {
      assert.equal(store.consume("192.0.2.1", now + index * 1000).allowed, true);
    }
    assert.equal(store.stats()[0].attempts, 120);
    store.prune(now + 7 * 86400000);
    assert.equal(store.stats().length, 0);
  } finally {
    store.close();
  }
});

test("server defaults isolate credentials and explicitly configure proxy trust", () => {
  const config = readConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.equal(config.token, "");
  assert.deepEqual(config.trustedProxies, []);
  assert.throws(() => readConfig({ BILISKIP_PORT: "123junk" }));
  assert.throws(() => readConfig({ BILISKIP_SHARED_TOKEN: "too-short" }));
  assert.throws(() => readConfig({ BILISKIP_TRUSTED_PROXIES: "*" }));
});
