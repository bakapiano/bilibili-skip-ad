import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelOutput, parseAdBlocksOutput } from "../../extension/lib/model-output.js";
import { context, pipeOutput, jsonOutput, jsonZeroOutput } from "./fixtures.js";

test("production JSON preserves separate ad blocks and exact local subtitle binding", async () => {
  const ctx = await context();
  assert.deepEqual(
    parseAdBlocksOutput(ctx, jsonOutput).segments,
    parseModelOutput(ctx, pipeOutput).segments,
  );
  assert.deepEqual(parseAdBlocksOutput(ctx, jsonZeroOutput).segments, []);
  const block = { start: 1, end: 1, type: "ad", subject: "品牌", reason: "测试", confidence: 0.95 };
  assert.equal(
    parseAdBlocksOutput(
      ctx,
      JSON.stringify({ topic: "主题", blocks: [block, { ...block, start: 3, end: 3 }] }),
    ).segments.length,
    2,
  );
  for (const output of [
    "NONE",
    "```json\n{}\n```",
    "null",
    JSON.stringify({ topic: "主题", blocks: [{ ...block, type: "body" }] }),
    JSON.stringify({ topic: "主题", blocks: [block, block] }),
    JSON.stringify({ topic: "主题", blocks: [{ ...block, end: 99 }] }),
    JSON.stringify({ topic: "主题", blocks: [{ ...block, confidence: "0.95" }] }),
  ]) {
    assert.throws(() => parseAdBlocksOutput(ctx, output), { code: "OUTPUT" });
  }
});

test("pipe output maps local timestamps and binds identity without fabricated evidence", async () => {
  const ctx = await context();
  const result = parseModelOutput(ctx, pipeOutput);
  assert.equal(result.labels.video_key, ctx.video_key);
  assert.equal(result.labels.transcript_sha256, ctx.transcript_sha256);
  assert.match(result.summary, /程序汇总/);
  assert.equal(result.segments[0].start, 10);
  assert.equal(result.segments[0].end, 20);
  assert.deepEqual(result.segments[0].evidence_ids, []);
  assert.deepEqual(result.segments[0].evidence, []);
});

test("NONE is the sole zero-ad marker and separate lines describe multiple ads", async () => {
  const ctx = await context();
  assert.deepEqual(parseModelOutput(ctx, "NONE\n").segments, []);
  const result = parseModelOutput(ctx, "1|1|品牌甲|简短说明|0.9\r\n3|3|品牌乙|说明|1");
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[1].start, 15);
});

test("escaped delimiters, backslashes and line breaks round-trip within text columns", async () => {
  const ctx = await context();
  const result = parseModelOutput(ctx, String.raw`2|3|甲\|乙\\品牌|第一句\n第二句\r第三句|0.97`);
  assert.equal(result.segments[0].brand, "甲|乙\\品牌");
  assert.equal(result.segments[0].reason, "第一句\n第二句\r第三句");
});

test("malformed, fabricated, overlong, overlapping and out-of-window results fail closed", async () => {
  const ctx = await context();
  for (const invalid of [
    "",
    " ",
    "none",
    "NONE\n" + pipeOutput,
    "[]",
    '{"segments":[]}',
    "```\n" + pipeOutput + "\n```",
    pipeOutput + "\n\n" + pipeOutput,
    "0|3|品牌|说明|0.9",
    "2.0|3|品牌|说明|0.9",
    "2|10001|品牌|说明|0.9",
    "3|2|品牌|说明|0.9",
    "2|3|品牌|说明|NaN",
    "2|3|品牌|说明|1.1",
    "2|3|品牌|说明|9e-1",
    "2|3|品牌|说明|-0.1",
    "2|3|品牌|说明|0.9|额外字段",
    "2|3||说明|0.9",
    "2|3|品牌||0.9",
    "2|3|品牌|" + "字".repeat(121) + "|0.9",
    String.raw`2|3|品牌|异常\t转义|0.9`,
    pipeOutput + "\\",
    pipeOutput + "\n" + pipeOutput,
    "2|3|品牌|真实\n换行|0.9",
    "2|3|品牌|真实\u2028换行|0.9",
    "x".repeat(64001),
  ]) {
    assert.throws(() => parseModelOutput(ctx, invalid), { code: "OUTPUT" });
  }
  assert.throws(() => parseModelOutput(ctx, pipeOutput, { startId: 3, endId: 4 }), {
    code: "OUTPUT",
  });
  assert.throws(() => parseModelOutput(ctx, "NONE", { startId: 0, endId: 4 }), { code: "OUTPUT" });
});
