import assert from "node:assert/strict";
import { parseModelOutput } from "../../extension/lib/model-output.js";

const escape = (text) =>
  String(text).replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", "\\n");

// Shared strict decoder for small experiments and the local full-dataset batch runner.
export function parsePartitionOutput(context, text, { adOnly = false } = {}) {
  const data = JSON.parse(text);
  assert.ok(
    typeof data.topic === "string" &&
      Array.isArray(data.blocks) &&
      data.blocks.length <= context.cues.length,
  );
  let next = 1;
  const ads = [];
  for (const block of data.blocks) {
    assert.ok(
      Number.isInteger(block.start) &&
        Number.isInteger(block.end) &&
        (adOnly ? block.start >= next : block.start === next) &&
        block.end >= block.start &&
        block.end <= context.cues.length,
      "Partition IDs must be ordered, bounded and nonoverlapping",
    );
    assert.ok((adOnly ? ["ad"] : ["body", "ad"]).includes(block.type));
    next = block.end + 1;
    if (block.type === "ad") {
      assert.ok(typeof block.subject === "string" && typeof block.reason === "string");
      ads.push(
        `${block.start}|${block.end}|${escape(block.subject)}|${escape(block.reason)}|${block.confidence}`,
      );
    }
  }
  if (!adOnly) {
    assert.equal(next, context.cues.length + 1, "Partition must cover all subtitle IDs");
  }
  return { ...parseModelOutput(context, ads.join("\n") || "NONE"), explanation: data };
}
