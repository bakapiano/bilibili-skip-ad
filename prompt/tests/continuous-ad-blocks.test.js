import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTRUCTIONS } from "../variants/legacy-v5.js";
import { digest } from "../data.js";
import {
  continuousAdBlocksPrompt,
  EXPECTED_BASELINE_HASH,
  REVISED_BOUNDARIES,
} from "../variants/continuous-ad-blocks.js";

test("continuous-block experiment changes only boundaries and keeps production prompt intact", () => {
  const before = INSTRUCTIONS;
  const candidate = continuousAdBlocksPrompt();
  assert.equal(digest(before), EXPECTED_BASELINE_HASH);
  assert.equal(INSTRUCTIONS, before);
  assert.equal(candidate.split("第三步：")[0], before.split("第三步：")[0]);
  assert.equal(candidate.split("输出规则：")[1], before.split("输出规则：")[1]);
  assert.ok(candidate.includes(REVISED_BOUNDARIES));
  assert.ok(candidate.includes("之后再次进入商业推广时，另起一个广告区间"));
  assert.ok(candidate.includes("同一品牌、同一产品或同一次合作"));
  assert.equal(candidate.includes("BV1Lmd2BAEad"), false);
  assert.equal(candidate.includes("370.904"), false);
  assert.throws(() => continuousAdBlocksPrompt("changed baseline"));
});
