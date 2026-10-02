import assert from "node:assert/strict";
import { digest } from "../data.js";
import { inputKey } from "../datasets.js";
import { aggregateMetrics, evaluate, evaluateRun, METRIC_POLICY } from "../metrics.js";

function uniqueRows(run) {
  const rows = new Map();
  for (const row of run.results) {
    const key = `${inputKey(row)}:${row.repeat}`;
    assert.ok(!rows.has(key), "Duplicate input/repeat in comparison");
    rows.set(key, row);
  }
  return rows;
}

function operationalMetrics(rows) {
  // Explicit supplementary policy: an invalid model result contributes an empty skip decision.
  // Original statuses/outputs remain unchanged and are reported alongside these derived metrics.
  return aggregateMetrics(
    rows.map((row) => ({
      status: "done",
      evaluation: evaluate(
        row.video,
        row.status === "done" ? row.segments : [],
        row.referenceSnapshot,
      ),
    })),
  );
}

export function compareConfigurations(baseline, candidate) {
  const before = evaluateRun(baseline);
  const after = evaluateRun(candidate);
  for (const run of [before, after]) {
    assert.equal(digest(run.metricPolicy), digest(METRIC_POLICY));
  }
  // Output protocol and budget are allowed to differ, and are kept visible in the result.
  for (const field of ["model", "thinking", "temperature", "reasoning_effort"]) {
    assert.equal(
      before.settings[field],
      after.settings[field],
      `Generation setting differs: ${field}`,
    );
  }
  const oldRows = uniqueRows(before);
  const newRows = uniqueRows(after);
  const rows = [];
  const excluded = [];
  const pairedBefore = [];
  const pairedAfter = [];
  const scopedBefore = [];
  const scopedAfter = [];
  for (const key of new Set([...oldRows.keys(), ...newRows.keys()])) {
    const old = oldRows.get(key);
    const current = newRows.get(key);
    if (
      !old ||
      !current ||
      !old.evaluationIdentity ||
      old.evaluationIdentity !== current.evaluationIdentity
    ) {
      excluded.push({
        key,
        bvid: current?.bvid || old?.bvid,
        reason: "missing or mismatched input/reference",
      });
      continue;
    }
    scopedBefore.push(old);
    scopedAfter.push(current);
    if (
      old.status !== "done" ||
      current.status !== "done" ||
      old.returnedModel !== current.returnedModel
    ) {
      excluded.push({
        key,
        bvid: current.bvid,
        caseId: current.caseId,
        beforeStatus: old.status,
        afterStatus: current.status,
        reason: "invalid output or returned model differs",
      });
      continue;
    }
    pairedBefore.push(old);
    pairedAfter.push(current);
    const x = old.evaluation;
    const y = current.evaluation;
    const delta = (field) =>
      Number.isFinite(x[field]) && Number.isFinite(y[field]) ? y[field] - x[field] : null;
    const hardRegression =
      delta("bodyPreserveOverlap") > 0.001 ||
      (y.referenceKind === "human" && y.adSeconds === 0 && delta("bodySkipSeconds") > 0.001);
    rows.push({
      key,
      bvid: current.bvid,
      caseId: current.caseId,
      title: current.title,
      repeat: current.repeat,
      before: x,
      after: y,
      iouDelta: delta("iou"),
      bodySkipRateDelta: delta("bodySkipRate"),
      bodySecondsDelta: delta("bodySkipSeconds"),
      adMissRateDelta: delta("adMissRate"),
      adMissSecondsDelta: delta("adMissSeconds"),
      preserveDelta: delta("bodyPreserveOverlap"),
      beforeSegments: old.segments,
      afterSegments: current.segments,
      hardRegression,
      regression:
        hardRegression ||
        delta("bodySkipSeconds") > 2 ||
        delta("adMissRate") > 0.1 ||
        delta("iou") < -0.05,
    });
  }
  const pairedMetricsBefore = aggregateMetrics(pairedBefore);
  const pairedMetricsAfter = aggregateMetrics(pairedAfter);
  const complete =
    !excluded.length &&
    [before, after].every(
      (run) => ["done", "partial"].includes(run.status) && run.results.length === run.plannedCalls,
    );
  const hard = rows.filter((row) => row.hardRegression).length;
  const regressed = rows.filter((row) => row.regression).length;
  const worse =
    pairedMetricsAfter.meanIou < pairedMetricsBefore.meanIou ||
    pairedMetricsAfter.bodySkipRate > pairedMetricsBefore.bodySkipRate ||
    pairedMetricsAfter.adMissRate > pairedMetricsBefore.adMissRate;
  return {
    kind: "configuration-comparison",
    baselineId: baseline.id,
    candidateId: candidate.id,
    settings: { before: baseline.settings, after: candidate.settings },
    scope: "same input/reference/model; output protocol and output budget differ explicitly",
    paired: rows.length,
    scoped: scopedAfter.length,
    excluded,
    status: complete ? "complete" : "incomplete",
    verdict: !complete
      ? "incomplete"
      : hard || pairedMetricsAfter.preserveViolations || pairedMetricsAfter.zeroAdFalseSkips
        ? "blocked"
        : regressed || worse
          ? "review"
          : pairedMetricsAfter.scored
            ? "pass"
            : "unscored",
    before: pairedMetricsBefore,
    after: pairedMetricsAfter,
    ownValidBefore: before.metrics,
    ownValidAfter: after.metrics,
    operational: {
      policy: "invalid result => empty skip, same matched input/reference population",
      count: scopedAfter.length,
      before: operationalMetrics(scopedBefore),
      after: operationalMetrics(scopedAfter),
      failedBefore: scopedBefore
        .filter((row) => row.status !== "done")
        .map((row) => ({ caseId: row.caseId, bvid: row.bvid, status: row.status })),
      failedAfter: scopedAfter
        .filter((row) => row.status !== "done")
        .map((row) => ({ caseId: row.caseId, bvid: row.bvid, status: row.status })),
    },
    hardRegressions: hard,
    regressions: regressed,
    delta: Object.fromEntries(
      ["meanIou", "bodySkipRate", "adMissRate"].map((field) => [
        field,
        Number.isFinite(pairedMetricsBefore[field]) && Number.isFinite(pairedMetricsAfter[field])
          ? pairedMetricsAfter[field] - pairedMetricsBefore[field]
          : null,
      ]),
    ),
    rows: rows.sort(
      (a, b) =>
        Number(b.hardRegression) - Number(a.hardRegression) ||
        Number(b.regression) - Number(a.regression) ||
        (a.iouDelta ?? 0) - (b.iouDelta ?? 0),
    ),
  };
}
