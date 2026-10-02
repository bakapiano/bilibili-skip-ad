import "../extension/player-core.js";
import { communityReference, digest, intervalDiff, intervals, sampleVideo } from "./data.js";

export const METRIC_POLICY = Object.freeze({
  version: "time-rates-v1",
  confidenceThreshold: 0.9,
  protection: "all-raw-segment-duration>=50%",
  iouAggregation: "macro-positive-reference",
  rateAggregation: "summed-seconds",
});
const EPSILON = 0.001;
const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);
const ranges = (items, duration) => {
  if (
    !Array.isArray(items) ||
    items.some(
      (s) =>
        !Number.isFinite(s.start) ||
        !Number.isFinite(s.end) ||
        s.start < 0 ||
        s.end <= s.start ||
        s.end > duration,
    )
  ) {
    throw new Error("评测区间须在视频范围内，且起止时间有效。");
  }
  return intervals(items).map(([start, end]) => ({ start, end }));
};

export function referenceSnapshot(sample) {
  const video = sampleVideo(sample);
  const human = sample.review?.status === "complete";
  const reference = human ? sample.review.segments : communityReference(sample);
  const available = human || Boolean(reference?.length);
  return {
    kind: human ? "human" : "community",
    available,
    ranges: available ? ranges(reference, video.duration) : [],
    preserve: ranges(sample.review?.preserve || [], video.duration),
  };
}

export function evaluate(video, segments, reference) {
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    throw new Error("评测视频时长异常。");
  }
  ranges(segments, video.duration);
  if (
    segments.some((s) => !Number.isFinite(s.confidence) || s.confidence < 0 || s.confidence > 1)
  ) {
    throw new Error("评测预测区间评分异常。");
  }
  const protectedByCoverage =
    segments.reduce((sum, s) => sum + s.end - s.start, 0) >= video.duration * 0.5;
  // Reuse exactly the player's rule: low-score raw segments still contribute to the 50% guard.
  const effective = segments.filter((s) =>
    globalThis.BiliSkipPlayer.automatic({ video, segments }, s, METRIC_POLICY.confidenceThreshold),
  );
  const preserve = ranges(reference.preserve || [], video.duration);
  const bodyPreserveOverlap = intervalDiff(effective, preserve).overlapSeconds;
  if (!reference.available) {
    return {
      available: false,
      referenceKind: reference.kind,
      protectedByCoverage,
      effective,
      bodyPreserveOverlap,
      rawBodyPreserveOverlap: intervalDiff(segments, preserve).overlapSeconds,
    };
  }
  const target = ranges(reference.ranges, video.duration);
  const diff = intervalDiff(effective, target);
  const rawDiff = intervalDiff(segments, target);
  const bodySeconds = Math.max(0, video.duration - diff.secondSeconds);
  return {
    available: true,
    referenceKind: reference.kind,
    iou: diff.iou,
    bodySkipRate: ratio(diff.onlyFirstSeconds, bodySeconds),
    adMissRate: ratio(diff.onlySecondSeconds, diff.secondSeconds),
    adSeconds: diff.secondSeconds,
    bodySeconds,
    bodySkipSeconds: diff.onlyFirstSeconds,
    adMissSeconds: diff.onlySecondSeconds,
    overlapSeconds: diff.overlapSeconds,
    protectedByCoverage,
    effective,
    bodyPreserveOverlap,
    rawBodyPreserveOverlap: intervalDiff(segments, preserve).overlapSeconds,
    raw: rawDiff,
  };
}

export function aggregateMetrics(results) {
  const successful = results.filter((r) => r.status === "done");
  const scored = successful.filter((r) => r.evaluation?.available);
  const sum = (field) => scored.reduce((n, r) => n + r.evaluation[field], 0);
  const positive = scored.filter((r) => r.evaluation.adSeconds > 0);
  const negatives = scored.filter((r) => r.evaluation.adSeconds === 0);
  return {
    totalResults: results.length,
    successful: successful.length,
    failed: results.filter((r) => ["error", "cancelled"].includes(r.status)).length,
    scored: scored.length,
    unscored: successful.length - scored.length,
    positiveReferences: positive.length,
    zeroAdReferences: negatives.length,
    zeroAdFalseSkips: negatives.filter((r) => r.evaluation.bodySkipSeconds > 0).length,
    meanIou: positive.length
      ? positive.reduce((n, r) => n + r.evaluation.iou, 0) / positive.length
      : null,
    bodySkipRate: ratio(sum("bodySkipSeconds"), sum("bodySeconds")),
    adMissRate: ratio(sum("adMissSeconds"), sum("adSeconds")),
    bodySkipSeconds: sum("bodySkipSeconds"),
    bodySeconds: sum("bodySeconds"),
    adMissSeconds: sum("adMissSeconds"),
    adSeconds: sum("adSeconds"),
    protectedVideos: successful.filter((r) => r.evaluation?.protectedByCoverage).length,
    preserveViolations: successful.filter((r) => r.evaluation?.bodyPreserveOverlap > EPSILON)
      .length,
    referenceKinds: [...new Set(scored.map((r) => r.evaluation.referenceKind))],
  };
}

export function evaluateRun(run) {
  const results = run.results.map((row) => {
    if (row.status !== "done" || !row.referenceSnapshot || !row.video) {
      return row;
    }
    return { ...row, evaluation: evaluate(row.video, row.segments, row.referenceSnapshot) };
  });
  return { ...run, results, metrics: aggregateMetrics(results) };
}

export function evaluationIdentity(context, reference, input) {
  return digest({
    video: context.video,
    transcriptSha256: context.transcript_sha256,
    reference,
    input,
  });
}

export function compareRuns(baseline, candidate) {
  const a = evaluateRun(baseline);
  const b = evaluateRun(candidate);
  const key = (r) =>
    `${r.bvid}:${r.video?.cid || r.baseline?.video?.cid}:${r.transcriptSha256}:${r.repeat}`;
  const previous = new Map(a.results.map((r) => [key(r), r]));
  const next = new Map(b.results.map((r) => [key(r), r]));
  const oldRows = [];
  const newRows = [];
  const rows = [];
  const excluded = [];
  const settingsMatch =
    digest(a.settings || null) === digest(b.settings || null) &&
    digest(a.metricPolicy || null) === digest(METRIC_POLICY) &&
    digest(b.metricPolicy || null) === digest(METRIC_POLICY);
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const old = previous.get(id);
    const current = next.get(id);
    if (
      !old ||
      !current ||
      old.status !== "done" ||
      current.status !== "done" ||
      !settingsMatch ||
      !old.evaluationIdentity ||
      old.evaluationIdentity !== current.evaluationIdentity ||
      old.returnedModel !== current.returnedModel
    ) {
      excluded.push({
        key: id,
        reason: !old || !current ? "样本/轮次未配对" : "状态、输入、参考标注或模型配置不一致",
      });
      continue;
    }
    oldRows.push(old);
    newRows.push(current);
    const x = old.evaluation;
    const y = current.evaluation;
    const difference = (name) =>
      !Number.isFinite(x?.[name]) || !Number.isFinite(y?.[name]) ? null : y[name] - x[name];
    const bodySecondsDelta = difference("bodySkipSeconds");
    const adMissRateDelta = difference("adMissRate");
    const iouDelta = difference("iou");
    const preserveDelta = difference("bodyPreserveOverlap");
    const hardRegression =
      preserveDelta > EPSILON ||
      (y?.referenceKind === "human" && y.adSeconds === 0 && bodySecondsDelta > EPSILON);
    rows.push({
      key: id,
      bvid: current.bvid,
      title: current.title,
      caseId: current.caseId,
      repeat: current.repeat,
      before: x,
      after: y,
      iouDelta,
      bodySkipRateDelta: difference("bodySkipRate"),
      bodySecondsDelta,
      adMissRateDelta,
      preserveDelta,
      hardRegression,
      regression:
        hardRegression || bodySecondsDelta > 2 || adMissRateDelta > 0.1 || iouDelta < -0.05,
    });
  }
  const before = aggregateMetrics(oldRows);
  const after = aggregateMetrics(newRows);
  const delta = Object.fromEntries(
    ["meanIou", "bodySkipRate", "adMissRate"].map((name) => [
      name,
      !Number.isFinite(before[name]) || !Number.isFinite(after[name])
        ? null
        : after[name] - before[name],
    ]),
  );
  const complete =
    a.status === "done" &&
    b.status === "done" &&
    a.results.length === a.plannedCalls &&
    b.results.length === b.plannedCalls &&
    !excluded.length &&
    rows.length > 0 &&
    previous.size === a.results.length &&
    next.size === b.results.length;
  const hard = rows.filter((r) => r.hardRegression).length;
  const regressed = rows.filter((r) => r.regression).length;
  const worse =
    delta.meanIou < -0.000001 || delta.bodySkipRate > 0.000001 || delta.adMissRate > 0.000001;
  return {
    baselineId: a.id,
    candidateId: b.id,
    metricPolicy: METRIC_POLICY,
    verdict: !complete
      ? "incomplete"
      : hard || after.preserveViolations || after.zeroAdFalseSkips
        ? "blocked"
        : regressed || worse
          ? "review"
          : after.scored
            ? "pass"
            : "unscored",
    paired: rows.length,
    excluded,
    before,
    after,
    delta,
    hardRegressions: hard,
    regressions: regressed,
    rows: rows.sort(
      (x, y) =>
        Number(y.hardRegression) - Number(x.hardRegression) ||
        Number(y.regression) - Number(x.regression) ||
        (x.iouDelta ?? 0) - (y.iouDelta ?? 0),
    ),
  };
}
