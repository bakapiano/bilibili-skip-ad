import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { digest } from "../data.js";
import { aggregateMetrics } from "../metrics.js";

export function composeRuns({ sources, sampleIds, name, datasetRevision, reusedRunIds = [] }) {
  assert.ok(
    sources.length > 0 && sampleIds.length > 0 && new Set(sampleIds).size === sampleIds.length,
  );
  const wanted = new Set(sampleIds);
  const rows = new Map();
  const base = sources[0];
  const sourceRuns = [];
  for (const source of sources) {
    assert.ok(["done", "partial"].includes(source.status), "All source batches must be terminal");
    assert.equal(source.promptSha256, base.promptSha256);
    assert.equal(digest(source.settings), digest(base.settings));
    assert.equal(digest(source.metricPolicy), digest(base.metricPolicy));
    const picked = source.results.filter((row) => wanted.has(row.caseId));
    sourceRuns.push({
      id: source.id,
      status: source.status,
      picked: picked.length,
      reused: reusedRunIds.includes(source.id),
    });
    for (const row of picked) {
      assert.equal(row.repeat, 1);
      assert.ok(!rows.has(row.caseId), "Each frozen input must be supplied exactly once");
      rows.set(row.caseId, {
        ...row,
        sourceRunId: source.id,
        sourceReused: reusedRunIds.includes(source.id),
      });
    }
  }
  assert.equal(rows.size, sampleIds.length, "Composite covers the entire frozen dataset");
  const results = sampleIds.map((id) => rows.get(id));
  return {
    schemaVersion: 2,
    id: randomUUID(),
    name,
    startedAt: sources.map((source) => source.startedAt).sort()[0],
    finishedAt: sources
      .map((source) => source.finishedAt)
      .sort()
      .at(-1),
    status: results.some((row) => row.status !== "done") ? "partial" : "done",
    prompt: base.prompt,
    promptSha256: base.promptSha256,
    productionPromptSha256: base.productionPromptSha256,
    settings: base.settings,
    metricPolicy: base.metricPolicy,
    plannedCalls: sampleIds.length,
    repeats: 1,
    sampleIds,
    dataset: "community",
    datasetRevision,
    datasetSha256: digest(
      results
        .map(
          (row) => `${row.video.bvid}:${row.video.page}:${row.video.cid}:${row.transcriptSha256}`,
        )
        .sort(),
    ),
    experiment: {
      protocol: base.settings.experimentalProtocol || "pipe",
      derived: true,
      variant: "sharded-dataset-composite",
      sourceRuns,
      newApiCalls: 0,
      freshSourceCalls: results
        .filter((row) => !row.sourceReused)
        .reduce((sum, row) => sum + (row.apiCalls || 0), 0),
      reusedSourceCalls: results
        .filter((row) => row.sourceReused)
        .reduce((sum, row) => sum + (row.apiCalls || 0), 0),
    },
    results,
    metrics: aggregateMetrics(results),
  };
}
