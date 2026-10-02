import { test } from "node:test";
import assert from "node:assert/strict";
import { context } from "../../tests/extension/fixtures.js";
import { assertExpansionResumable, buildExpandedSample } from "../expand-dataset.js";
import { sampleInput } from "../runner.js";

test("closed expansion checkpoints require a new explicit collection plan", () => {
  assertExpansionResumable(null);
  assertExpansionResumable({ status: "collecting" });
  assertExpansionResumable({ status: "paused" });
  for (const status of ["stopped", "superseded", "complete", "unknown"]) {
    assert.throws(() => assertExpansionResumable({ status }), /collection is closed/);
  }
});

// Synthetic collector records validate imports without contacting Bilibili or the community API.
async function fixture() {
  const ctx = await context();
  const record = {
    bvid: ctx.video.bvid,
    cid: ctx.video.cid,
    source: { prefix: "abcd" },
    fetchedAt: "2026-10-02",
    transcript: { status: "ready", sha256: ctx.transcript_sha256 },
    community: {
      raw: [
        {
          UUID: "synthetic",
          cid: String(ctx.video.cid),
          category: "sponsor",
          actionType: "skip",
          segment: [10, 20],
          votes: 1,
          locked: 0,
          videoDuration: ctx.video.duration,
        },
      ],
    },
  };
  return { ctx, record };
}

test("expansion importer creates independent unlabeled inputs with verified community references", async () => {
  const { ctx, record } = await fixture();
  const sample = await buildExpandedSample(record, ctx, "synthetic-batch", "2026-10-02");
  assert.equal(sample.baseline, null);
  assert.equal(sample.review, null);
  assert.deepEqual(sample.datasets, ["community-expanded"]);
  assert.equal(sample.community.segments[0].comparable, true);
  assert.equal((await sampleInput(sample)).context.transcript_sha256, ctx.transcript_sha256);
  assert.equal(sample.source.origins[0].batchId, "synthetic-batch");
});

test("expansion importer rejects wrong identity, fingerprints and noncomparable references", async () => {
  const { ctx, record } = await fixture();
  await assert.rejects(buildExpandedSample({ ...record, cid: 1 }, ctx, "batch", "date"));
  await assert.rejects(
    buildExpandedSample(
      { ...record, transcript: { status: "ready", sha256: "wrong" } },
      ctx,
      "batch",
      "date",
    ),
  );
  const bad = structuredClone(record);
  bad.community.raw[0].videoDuration += 10;
  await assert.rejects(buildExpandedSample(bad, ctx, "batch", "date"));
});
