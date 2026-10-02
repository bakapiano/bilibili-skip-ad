import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { context, pipeOutput, usage } from "../../tests/extension/fixtures.js";
import { compactPromptData } from "../../extension/lib/prompt.js";
import {
  parsePromotionContent,
  PROMOTION_CONTENT_PROMPT,
  PROMOTION_LOCATION_PROMPT,
  PROMOTION_LOCATION_UNMERGED_PROMPT,
  UNMERGED_PARAGRAPH_RULES,
} from "../variants/promotion-content.js";
import { parseModelOutput } from "../../extension/lib/model-output.js";
import { runBodyIslandExperiment } from "../experiments/body-islands-runner.js";

test("compact promotion content validates two bounded columns and explicit empty output", () => {
  assert.deepEqual(parsePromotionContent("合成平台|介绍优惠；引导购买"), [
    { object: "合成平台", content: "介绍优惠；引导购买" },
  ]);
  assert.deepEqual(parsePromotionContent("NONE"), []);
  assert.throws(() => parsePromotionContent("推广对象|具体推广内容\n合成|内容"));
  assert.throws(() => parsePromotionContent(`品牌|${"长".repeat(61)}`, 60));
  for (const value of [
    "",
    "品牌",
    "品牌|",
    "|内容",
    "品牌|内容|额外",
    "品牌|内容\n品牌|重复",
    `品牌|${"长".repeat(121)}`,
    "```\n品牌|内容\n```",
    "品牌|内容\r伪造",
  ]) {
    assert.throws(() => parsePromotionContent(value));
  }
});

// Synthetic model replies test the two-stage protocol without network or real credentials.
async function fixture(t, extraction, variant = "promotion-content-first") {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/promotion-content-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = await context();
  const requests = [];
  const key = "synthetic-promotion-content-key";
  const run = await runBodyIslandExperiment({
    samples: [
      {
        id: "00000000-0000-4000-8000-000000000015",
        video: ctx.video,
        transcript: { status: "ready", context: ctx },
        community: { status: "missing", segments: [] },
      },
    ],
    variant,
    key,
    dbRoot: root,
    runsRoot: root,
    fetcher: async function (_url, options) {
      assert.equal(this, globalThis);
      assert.equal(options.redirect, "error");
      requests.push(JSON.parse(options.body));
      return new Response(
        JSON.stringify({
          model: "synthetic",
          usage,
          choices: [
            {
              finish_reason: "stop",
              message: { content: requests.length === 1 ? extraction : pipeOutput },
            },
          ],
        }),
      );
    },
  });
  assert.equal((await readFile(path.join(root, `${run.id}.json`), "utf8")).includes(key), false);
  return { ctx, run, requests, root };
}

test("promotion extraction and location each receive full transcript and both usages are counted", async (t) => {
  const { ctx, run, requests } = await fixture(t, "测试品牌|提供优惠并引导购买");
  assert.equal(run.status, "done");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages[0].content, PROMOTION_CONTENT_PROMPT);
  assert.equal(requests[1].messages[0].content, PROMOTION_LOCATION_PROMPT);
  assert.equal(requests[0].messages[1].content, compactPromptData(ctx));
  assert.ok(requests[1].messages[1].content.startsWith(compactPromptData(ctx)));
  assert.ok(requests[1].messages[1].content.endsWith("测试品牌|提供优惠并引导购买"));
  assert.ok(
    requests.every((request) => request.thinking.type === "disabled" && request.temperature === 0),
  );
  assert.equal(requests[0].max_tokens, 512);
  assert.equal(requests[1].max_tokens, 2048);
  assert.equal(run.plannedApiCalls, 2);
  const row = run.results[0];
  assert.equal(row.stages.length, 2);
  assert.equal(row.apiCalls, 2);
  assert.equal(row.usage.outputTokens, usage.completion_tokens * 2);
  assert.equal(row.rawOutput, pipeOutput);
  assert.equal(row.originalCandidates, undefined);
});

test("empty or malformed promotion lists stop before location and retain charge accounting", async (t) => {
  const empty = await fixture(t, "NONE");
  assert.equal(empty.requests.length, 1);
  assert.equal(empty.run.status, "done");
  assert.deepEqual(empty.run.results[0].segments, []);
  assert.equal(empty.run.results[0].usage.outputTokens, usage.completion_tokens);
  const malformed = await fixture(t, "品牌|内容|额外字段");
  assert.equal(malformed.requests.length, 1);
  assert.equal(malformed.run.status, "partial");
  assert.equal(malformed.run.results[0].usage.outputTokens, usage.completion_tokens);
});

test("unmerged paragraph prompt adds only the paragraph rules and parser retains adjacent rows", async () => {
  assert.equal(
    PROMOTION_LOCATION_UNMERGED_PROMPT.replace(`${UNMERGED_PARAGRAPH_RULES}\n\n`, ""),
    PROMOTION_LOCATION_PROMPT,
  );
  const result = parseModelOutput(
    await context(),
    "2|2|品牌|介绍功能|0.95\n3|3|品牌|优惠引导|0.95",
  );
  assert.deepEqual(
    result.segments.map((segment) => [segment.start_id, segment.end_id]),
    [
      [2, 2],
      [3, 3],
    ],
  );
});

test("unmerged location reuses exact first-stage content with only one fresh paid request", async (t) => {
  const {
    ctx,
    run: upstream,
    root,
  } = await fixture(t, "测试品牌|提供优惠并引导购买", "promotion-content-first-v3");
  let calls = 0;
  let request;
  const run = await runBodyIslandExperiment({
    samples: [
      {
        id: upstream.sampleIds[0],
        video: ctx.video,
        transcript: { status: "ready", context: ctx },
        community: { status: "missing", segments: [] },
      },
    ],
    variant: "promotion-content-unmerged",
    promotionSource: upstream,
    key: "synthetic-reuse-key",
    dbRoot: root,
    runsRoot: root,
    fetcher: async (_url, options) => {
      calls++;
      request = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          model: "synthetic",
          usage,
          choices: [
            {
              finish_reason: "stop",
              message: { content: "2|2|品牌|介绍功能|0.95\n3|3|品牌|优惠引导|0.95" },
            },
          ],
        }),
      );
    },
  });
  assert.equal(run.status, "done");
  assert.equal(run.plannedApiCalls, 1);
  assert.equal(calls, 1);
  assert.equal(request.messages[0].content, PROMOTION_LOCATION_UNMERGED_PROMPT);
  assert.equal(
    request.messages[1].content,
    upstream.results[0].stages[1].request.messages[1].content,
  );
  assert.deepEqual(run.results[0].promotionContents, upstream.results[0].promotionContents);
  assert.equal(run.results[0].stages.length, 1);
  assert.equal(run.results[0].sourceStages.length, 1);
  assert.equal(run.results[0].apiCalls, 1);
  assert.equal(run.results[0].usage.outputTokens, usage.completion_tokens);
  assert.equal(run.results[0].sourceUsage.outputTokens, usage.completion_tokens);
  assert.equal(run.results[0].segments.length, 2);
  const mismatched = structuredClone(upstream);
  mismatched.results[0].stages[0].rawOutput = "其他品牌|变化的内容";
  await assert.rejects(
    runBodyIslandExperiment({
      samples: [
        {
          id: upstream.sampleIds[0],
          video: ctx.video,
          transcript: { status: "ready", context: ctx },
          community: { status: "missing", segments: [] },
        },
      ],
      variant: "promotion-content-unmerged",
      promotionSource: mismatched,
      key: "synthetic-reuse-key",
      dbRoot: root,
      runsRoot: root,
      fetcher: async () => {
        throw new Error("must reject before model fetch");
      },
    }),
  );
});
