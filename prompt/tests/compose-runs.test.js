import { test } from "node:test";
import assert from "node:assert/strict";
import { composeRuns } from "../experiments/compose-runs.js";

const source = (id, cases) => ({
  id,
  status: "done",
  startedAt: "2026-10-02T01:00:00Z",
  finishedAt: "2026-10-02T01:01:00Z",
  prompt: "synthetic",
  promptSha256: "synthetic-hash",
  settings: { model: "synthetic" },
  metricPolicy: { version: "test" },
  results: cases.map((caseId) => ({
    caseId,
    repeat: 1,
    status: "done",
    apiCalls: 1,
    transcriptSha256: "hash",
    video: { bvid: caseId, page: 1, cid: 1 },
  })),
});

test("composition keeps upstream billing provenance and complete frozen membership", () => {
  const sources = [source("old", ["a", "ignored"]), source("new", ["b"])];
  const before = structuredClone(sources);
  const result = composeRuns({
    sources,
    sampleIds: ["a", "b"],
    name: "test",
    datasetRevision: "revision",
    reusedRunIds: ["old"],
  });
  assert.equal(result.plannedCalls, 2);
  assert.equal(result.experiment.newApiCalls, 0);
  assert.equal(result.experiment.freshSourceCalls, 1);
  assert.equal(result.experiment.reusedSourceCalls, 1);
  assert.deepEqual(
    result.results.map((row) => row.sourceRunId),
    ["old", "new"],
  );
  assert.deepEqual(sources, before);
});

test("composition rejects duplicate, missing and incompatible source runs", () => {
  const options = { sampleIds: ["a", "b"], name: "test", datasetRevision: "revision" };
  assert.throws(() => composeRuns({ ...options, sources: [source("one", ["a"])] }));
  assert.throws(() =>
    composeRuns({ ...options, sources: [source("one", ["a"]), source("two", ["a", "b"])] }),
  );
  const bad = source("bad", ["b"]);
  bad.settings.model = "different";
  assert.throws(() => composeRuns({ ...options, sources: [source("one", ["a"]), bad] }));
});
