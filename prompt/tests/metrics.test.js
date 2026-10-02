import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  aggregateMetrics,
  compareRuns,
  METRIC_POLICY,
  referenceSnapshot,
} from "../metrics.js";

const video = { bvid: "BV1eVaz6UENn", page: 1, cid: 123, title: "Synthetic", duration: 600 };
const prediction = (start, end, confidence = 0.95) => ({ start, end, confidence });
const reference = (ranges, kind = "community", preserve = []) => ({
  available: true,
  kind,
  ranges,
  preserve,
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test("time metrics use body duration and reference ad duration as distinct denominators", () => {
  const r = evaluate(video, [prediction(90, 120)], reference([{ start: 100, end: 130 }]));
  assert.equal(r.iou, 0.5);
  assert.equal(r.bodySkipSeconds, 10);
  assert.equal(r.adMissSeconds, 10);
  near(r.bodySkipRate, 10 / 570);
  near(r.adMissRate, 10 / 30);
});

test("interval unions avoid double counting and reject out-of-video ranges", () => {
  const r = evaluate(
    video,
    [prediction(100, 130)],
    reference([
      { start: 100, end: 120 },
      { start: 110, end: 130 },
    ]),
  );
  assert.equal(r.adSeconds, 30);
  assert.equal(r.iou, 1);
  assert.throws(() => evaluate(video, [prediction(-1, 20)], reference([])));
  assert.throws(() => evaluate(video, [prediction(10, 601)], reference([])));
  assert.throws(() => evaluate(video, [prediction(10, 20, NaN)], reference([])));
});

test("effective predictions exactly follow 0.90 and all-raw-segment 50% player policy", () => {
  const v = { ...video, duration: 100 };
  const ref = reference([{ start: 10, end: 20 }]);
  assert.equal(evaluate(v, [prediction(10, 20, 0.899)], ref).adMissRate, 1);
  assert.equal(evaluate(v, [prediction(10, 20, 0.9)], ref).iou, 1);
  const guarded = evaluate(v, [prediction(10, 20, 0.99), prediction(30, 70, 0.8)], ref);
  assert.equal(guarded.protectedByCoverage, true);
  assert.deepEqual(guarded.effective, []);
  assert.equal(guarded.adMissRate, 1);
  assert.equal(guarded.raw.overlapSeconds, 10);
});

test("zero-ad, all-ad and missing-reference cases expose defined denominators", () => {
  const empty = evaluate(video, [], reference([], "human"));
  assert.equal(empty.iou, null);
  assert.equal(empty.bodySkipRate, 0);
  assert.equal(empty.adMissRate, null);
  const falseSkip = evaluate(video, [prediction(1, 5)], reference([], "human"));
  near(falseSkip.bodySkipRate, 4 / 600);
  const allAd = evaluate(video, [], reference([{ start: 0, end: 600 }], "human"));
  assert.equal(allAd.bodySkipRate, null);
  assert.equal(allAd.adMissRate, 1);
  const missing = evaluate(video, [], {
    available: false,
    kind: "community",
    ranges: [],
    preserve: [],
  });
  assert.equal(missing.available, false);
  const partial = referenceSnapshot({
    video,
    community: { status: "missing" },
    review: { status: "partial", segments: null, preserve: [{ start: 30, end: 40 }] },
  });
  assert.equal(partial.available, false);
  assert.equal(evaluate(video, [prediction(30, 35)], partial).bodyPreserveOverlap, 5);
});

test("summary uses macro positive IoU and micro second-based error rates", () => {
  const first = evaluate(
    { ...video, duration: 100 },
    [prediction(10, 30)],
    reference([{ start: 10, end: 20 }]),
  );
  const second = evaluate({ ...video, duration: 1000 }, [], reference([{ start: 10, end: 20 }]));
  const summary = aggregateMetrics([
    { status: "done", evaluation: first },
    { status: "done", evaluation: second },
    { status: "error" },
  ]);
  assert.equal(summary.meanIou, 0.25);
  near(summary.bodySkipRate, 10 / 1080);
  assert.equal(summary.adMissRate, 0.5);
  assert.equal(summary.failed, 1);
});

function fixtureRun(segments, ref = reference([{ start: 100, end: 130 }])) {
  return {
    id: "synthetic-run",
    status: "done",
    plannedCalls: 1,
    metricPolicy: METRIC_POLICY,
    settings: { model: "synthetic", thinking: "disabled" },
    results: [
      {
        caseId: "synthetic-case",
        bvid: video.bvid,
        video,
        title: video.title,
        repeat: 1,
        status: "done",
        transcriptSha256: "input-hash",
        evaluationIdentity: "input-and-reference",
        returnedModel: "synthetic",
        segments,
        referenceSnapshot: ref,
      },
    ],
  };
}

test("paired comparisons flag per-video decline and preserve-range hard regression", () => {
  const ref = reference([{ start: 100, end: 130 }], "community", [{ start: 130, end: 150 }]);
  const before = fixtureRun([prediction(100, 130)], ref);
  const after = fixtureRun([prediction(100, 140)], ref);
  const compared = compareRuns(before, after);
  assert.equal(compared.verdict, "blocked");
  assert.equal(compared.hardRegressions, 1);
  assert.equal(compared.rows[0].preserveDelta, 10);
  assert.equal(compareRuns(before, before).verdict, "pass");
  const worse = compareRuns(fixtureRun([prediction(100, 130)]), fixtureRun([prediction(110, 130)]));
  assert.equal(worse.verdict, "review");
  assert.equal(worse.regressions, 1);
});

test("missing, failed, cancelled, duplicate and mismatched rows cannot pass regression", () => {
  const base = fixtureRun([prediction(100, 130)]);
  for (const mutate of [
    (r) => {
      r.status = "cancelled";
    },
    (r) => {
      r.results[0].status = "error";
    },
    (r) => {
      r.results = [];
    },
    (r) => {
      r.results[0].evaluationIdentity = "changed-title-or-reference";
    },
    (r) => {
      r.results[0].returnedModel = "another-model";
    },
    (r) => {
      r.metricPolicy = { ...METRIC_POLICY, confidenceThreshold: 0.8 };
    },
    (r) => {
      r.results.push(structuredClone(r.results[0]));
      r.plannedCalls = 2;
    },
  ]) {
    const candidate = structuredClone(base);
    mutate(candidate);
    assert.equal(compareRuns(base, candidate).verdict, "incomplete");
  }
  const legacy = structuredClone(base);
  delete legacy.metricPolicy;
  assert.equal(compareRuns(base, legacy).verdict, "incomplete");
});

test("human confirmed zero-ad videos have independent hard regression coverage", () => {
  const ref = reference([], "human");
  const comparison = compareRuns(fixtureRun([], ref), fixtureRun([prediction(10, 15)], ref));
  assert.equal(comparison.verdict, "blocked");
  assert.equal(comparison.after.meanIou, null);
  assert.equal(comparison.after.zeroAdFalseSkips, 1);
});
