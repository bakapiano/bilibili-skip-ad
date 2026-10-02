import assert from "node:assert/strict";
import { validateLabels } from "../../extension/lib/core.js";

export function repairBodyIslands(context, candidates, blocks) {
  let next = 1;
  const grouped = [];
  for (const block of blocks) {
    assert.ok(
      Number.isInteger(block.start) &&
        Number.isInteger(block.end) &&
        block.start === next &&
        block.end >= block.start &&
        block.end <= context.cues.length &&
        ["body", "ad"].includes(block.type),
    );
    next = block.end + 1;
    const last = grouped.at(-1);
    if (last?.type === block.type) {
      last.end = block.end;
    } else {
      grouped.push({ start: block.start, end: block.end, type: block.type });
    }
  }
  assert.equal(next, context.cues.length + 1);
  const removed = [];
  const segments = candidates.flatMap((candidate) => {
    const islands = grouped.filter(
      (block, index) =>
        block.type === "body" &&
        block.start > candidate.start_id &&
        block.end < candidate.end_id &&
        grouped[index - 1]?.type === "ad" &&
        grouped[index + 1]?.type === "ad",
    );
    const pieces = [];
    let start = candidate.start_id;
    for (const island of islands) {
      pieces.push({ start_id: start, end_id: island.start - 1 });
      removed.push({ start: island.start, end: island.end });
      start = island.end + 1;
    }
    pieces.push({ start_id: start, end_id: candidate.end_id });
    return pieces.map((piece) => ({
      ...piece,
      brand: candidate.brand,
      confidence: candidate.confidence,
      reason: islands.length ? "原始广告内的独立正文已切出" : candidate.reason,
      evidence_ids: [],
    }));
  });
  const labels = {
    video_key: context.video_key,
    transcript_sha256: context.transcript_sha256,
    summary: "内部正文岛修复",
    segments,
  };
  const result = validateLabels(context, labels);
  const originalProtected =
    candidates.reduce((sum, s) => sum + s.end - s.start, 0) >= context.video.duration * 0.5;
  // Keep the original safety decision. Trimming a protected >50% result must not enable skipping.
  if (originalProtected) {
    return {
      segments: candidates,
      removed: [],
      originalProtected,
      withheldRepair: result.segments,
      proposedRemoved: removed,
    };
  }
  return { segments: result.segments, removed, originalProtected };
}
