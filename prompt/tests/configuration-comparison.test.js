import { test } from "node:test";
import assert from "node:assert/strict";
import { compareConfigurations } from "../experiments/configuration-comparison.js";
import { METRIC_POLICY } from "../metrics.js";

// Synthetic matched snapshots check scheme comparisons independently of production datasets.
function run(id, valid = true) {
  return {
    id,
    status: valid ? "done" : "partial",
    plannedCalls: 1,
    settings: {
      model: "synthetic",
      thinking: "disabled",
      temperature: 0,
      max_tokens: id === "before" ? 2048 : 8192,
      ...(id === "after" ? { experimentalProtocol: "partition-ad-only" } : {}),
    },
    metricPolicy: METRIC_POLICY,
    results: [
      {
        caseId: "synthetic-case",
        bvid: "synthetic",
        title: "合成",
        repeat: 1,
        video: { bvid: "synthetic", cid: 1, page: 1, duration: 100 },
        transcriptSha256: "synthetic-hash",
        evaluationIdentity: "identical-input-and-reference",
        status: valid ? "done" : "error",
        returnedModel: "synthetic",
        referenceSnapshot: {
          available: true,
          kind: "community",
          ranges: [{ start: 10, end: 20 }],
          preserve: [],
        },
        ...(valid ? { segments: [{ start: 10, end: 20, confidence: 0.95 }] } : {}),
      },
    ],
  };
}

test("configuration comparison exposes changed output settings while pairing identical inputs", () => {
  const old = run("before");
  const fresh = run("after");
  const originals = structuredClone([old, fresh]);
  const result = compareConfigurations(old, fresh);
  assert.equal(result.status, "complete");
  assert.equal(result.paired, 1);
  assert.equal(result.after.meanIou, 1);
  assert.equal(result.settings.before.max_tokens, 2048);
  assert.equal(result.settings.after.max_tokens, 8192);
  assert.deepEqual([old, fresh], originals);
});

test("invalid output is excluded from paired accuracy and explicitly included as empty in operational metrics", () => {
  const result = compareConfigurations(run("before"), run("after", false));
  assert.equal(result.status, "incomplete");
  assert.equal(result.paired, 0);
  assert.equal(result.operational.count, 1);
  assert.equal(result.operational.after.adMissRate, 1);
  assert.equal(result.operational.failedAfter.length, 1);
  assert.equal(result.ownValidAfter.failed, 1);
});

test("input changes, duplicate rows, model setting changes and confirmed body regression remain visible", () => {
  const old = run("before");
  const changed = run("after");
  changed.results[0].evaluationIdentity = "changed";
  assert.equal(compareConfigurations(old, changed).paired, 0);
  const duplicate = run("after");
  duplicate.results.push(structuredClone(duplicate.results[0]));
  assert.throws(() => compareConfigurations(old, duplicate));
  const otherModel = run("after");
  otherModel.settings.model = "different";
  assert.throws(() => compareConfigurations(old, otherModel));
  const bad = run("after");
  old.results[0].referenceSnapshot.preserve = [{ start: 25, end: 30 }];
  bad.results[0].referenceSnapshot = structuredClone(old.results[0].referenceSnapshot);
  bad.results[0].segments[0].end = 30;
  assert.equal(compareConfigurations(old, bad).hardRegressions, 1);
});
