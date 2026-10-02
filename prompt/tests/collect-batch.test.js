import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSamples, parseBucket, randomPrefixes, workers } from "../collect-batch.js";
import { digest } from "../data.js";

const bvid = "BV1eVaz6UENn";
const segment = {
  UUID: "synthetic",
  cid: "123",
  category: "sponsor",
  actionType: "skip",
  segment: [5, 10],
  votes: 1,
  locked: 0,
  videoDuration: 100,
};
test("random prefix sample is bounded and without replacement", () => {
  const prefixes = randomPrefixes();
  assert.equal(prefixes.length, 1000);
  assert.equal(new Set(prefixes).size, 1000);
  assert.ok(prefixes.every((p) => /^[0-9a-f]{4}$/.test(p)));
  assert.equal(new Set(randomPrefixes(65536)).size, 65536);
  assert.throws(() => randomPrefixes(65537));
});
test("bucket validation checks identity, prefix, CID, schema and sponsor skip", () => {
  const prefix = digest(bvid).slice(0, 4);
  const valid = { videoID: bvid, segments: [segment] };
  assert.equal(parseBucket([valid], prefix).accepted.length, 1);
  assert.equal(parseBucket([valid], "wrong").rejected.length, 1);
  assert.equal(
    parseBucket([{ ...valid, segments: [{ ...segment, cid: "bad" }] }], prefix).rejected.length,
    1,
  );
  assert.equal(
    parseBucket(
      [{ ...valid, segments: [{ ...segment, actionType: "full", segment: [0, 0] }] }],
      prefix,
    ).accepted.length,
    0,
  );
});
test("selection deduplicates BV and UUID and chooses a stable CID without time filtering", () => {
  const rows = [
    {
      bvid,
      prefix: "abc",
      segments: [segment, { ...segment, UUID: "second", cid: "456", videoDuration: 50 }],
    },
  ];
  const selected = chooseSamples([...rows, ...rows], "seed");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].segments.length, 2);
  assert.equal(selected[0].availableCids.length, 2);
  assert.ok(selected[0].communityRaw.every((s) => Number(s.cid) === selected[0].cid));
  assert.deepEqual(selected, chooseSamples(rows, "seed"));
});
test("worker pool bounds concurrency, visits each item once and stops new dispatch", async () => {
  let active = 0;
  let max = 0;
  const seen = [];
  await workers(
    Array.from({ length: 20 }, (_, i) => i),
    8,
    async (item) => {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(item);
      active--;
    },
  );
  assert.equal(max, 8);
  assert.equal(new Set(seen).size, 20);
  let stopped = false;
  let starts = 0;
  await workers(
    [1, 2, 3],
    8,
    async () => {
      starts++;
      stopped = true;
    },
    () => stopped,
  );
  assert.equal(starts, 1);
});
