import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createCacheServer, MAX_TRANSCRIPT_BYTES } from "../server/app.js";
import { CacheStore } from "../server/store.js";
import { payloadHash, validateTranscript } from "../server/validation.js";
import { ASR_VERSION } from "../extension/lib/asr-config.js";
import { context } from "./extension/fixtures.js";

async function transcript() {
  const ctx = await context();
  return {
    schema_version: 1,
    video: ctx.video,
    asr_version: ASR_VERSION,
    client_version: "0.1.9",
    transcript_sha256: ctx.transcript_sha256,
    cues: ctx.cues,
  };
}
async function fixture(t, options = {}) {
  const store = new CacheStore(":memory:");
  const clock = { now: Date.now() };
  const server = createCacheServer({ store, now: () => clock.now, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (value, headers = {}) =>
    fetch(`${origin}/v1/transcripts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": payloadHash(value),
        ...headers,
      },
      body: JSON.stringify(value),
    });
  return { store, clock, origin, post };
}

test("transcript intake stores verified unreviewed text separately and deduplicates retries", async (t) => {
  const app = await fixture(t);
  const payload = await transcript();
  const first = await app.post(payload);
  assert.equal(first.status, 201);
  const receipt = await first.json();
  const row = app.store.db.prepare("SELECT * FROM transcripts").get();
  assert.equal(row.review_status, "unreviewed");
  assert.deepEqual(JSON.parse(row.payload), payload);
  assert.equal(app.store.publicStats().cached_records, 0);
  app.clock.now += 1000;
  const repeat = await app.post(payload);
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), receipt);
  app.clock.now += 1000;
  const nextClient = await app.post({ ...payload, client_version: "0.1.10" });
  assert.equal(nextClient.status, 200);
  assert.deepEqual(await nextClient.json(), receipt);
  assert.equal(app.store.transcriptStats().transcripts, 1);
  assert.equal(app.store.transcriptStats().videos, 1);
  assert.equal(app.store.stats()[0].stored, 1);
  assert.equal((await fetch(`${app.origin}/v1/transcripts`)).status, 405);
});

test("transcript intake shares the candidate IP budget and applies token and CORS guards", async (t) => {
  const app = await fixture(t, { token: "test-only-token" });
  const payload = await transcript();
  assert.equal((await app.post(payload)).status, 401);
  assert.equal((await fetch(`${app.origin}/v1/candidates`, { method: "POST" })).status, 429);
  app.clock.now += 1000;
  assert.equal((await app.post(payload, { Authorization: "Bearer test-only-token" })).status, 201);
  const limited = await app.post(payload, { Authorization: "Bearer test-only-token" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
  const preflight = await fetch(`${app.origin}/v1/transcripts`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Idempotency-Key/);
});

test("transcript validation binds the complete normalized text, timestamps and metadata", async () => {
  const value = await transcript();
  assert.ok(validateTranscript(value, payloadHash(value)).includes(ASR_VERSION));
  const mutations = [
    (p) => {
      p.apiKey = "synthetic";
    },
    (p) => {
      p.video.duration = 3601;
    },
    (p) => {
      p.video.cid = 0;
    },
    (p) => {
      p.asr_version = "unverified";
    },
    (p) => {
      p.client_version = "invalid";
    },
    (p) => {
      p.cues = [];
    },
    (p) => {
      p.cues[0].id = 2;
    },
    (p) => {
      p.cues[0].to = 0;
    },
    (p) => {
      p.cues[0].from = 0.0001;
    },
    (p) => {
      p.cues[0].to = p.video.duration + 1;
    },
    (p) => {
      p.cues[1].from = -1;
    },
    (p) => {
      p.cues[0].content = " ";
    },
    (p) => {
      p.cues[0].content += " ";
    },
    (p) => {
      p.cues[0].content += "tampered";
    },
    (p) => {
      p.cues[0].extra = 1;
    },
    (p) => {
      p.transcript_sha256 = "0".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const payload = structuredClone(value);
    mutate(payload);
    assert.throws(() => validateTranscript(payload, payloadHash(payload)), {
      code: "INVALID_INPUT",
    });
  }
  assert.throws(() => validateTranscript(value, "0".repeat(64)));
});

test("transcript body limit is bounded separately from candidate payloads", async (t) => {
  const app = await fixture(t);
  const value = await transcript();
  assert.equal((await app.post(value, { "Content-Type": "text/plain" })).status, 415);
  app.clock.now += 1000;
  assert.equal(
    (await app.post({ ...value, padding: "x".repeat(MAX_TRANSCRIPT_BYTES) })).status,
    413,
  );
  assert.equal(app.store.transcriptStats().transcripts, 0);
});
