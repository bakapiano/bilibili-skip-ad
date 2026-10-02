import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { context, pipeOutput } from "../../tests/extension/fixtures.js";
import { usage } from "../../tests/extension/fixtures.js";
import { normalize } from "../../extension/lib/core.js";
import { INSTRUCTIONS } from "../variants/legacy-v5.js";
import {
  parseExperimentalOutput,
  runBodyIslandExperiment,
} from "../experiments/body-islands-runner.js";
import { parseLocalDecisions } from "../experiments/local-body-review.js";
import { repairBodyIslands } from "../experiments/repair-body-islands.js";
import {
  BODY_ISLAND_VARIANTS,
  PARTITION_V2_PROMPT,
  INTERNAL_CLASSIFICATION_STEPS,
  PARTITION_V2_AD_ONLY_PROMPT,
  PARTITION_AD_ONLY_OUTPUT_CHANGES,
  PARTITION_AD_ONLY_SUFFIX,
  PARTITION_V2_AD_PIPE_PROMPT,
  PARTITION_AD_PIPE_OUTPUT_CHANGES,
  PARTITION_V2_AD_PIPE_V2_PROMPT,
  PARTITION_AD_PIPE_V2_OUTPUT_CHANGES,
} from "../variants/body-islands.js";
import { EXPECTED_BASELINE_HASH } from "../variants/continuous-ad-blocks.js";
import { digest } from "../data.js";
import { summarizeExperimentRuns } from "../experiments/summarize-body-islands.js";
import { FULL_VIDEO_SUMMARY_PROMPT } from "../variants/summary-first.js";
import { compactPromptData } from "../../extension/lib/prompt.js";
import { UNMERGED_PARAGRAPH_RULES } from "../variants/promotion-content.js";

// Synthetic subtitle and model outputs keep the experiment regressions independent of paid APIs.
const block = (start, end, type) => ({
  start,
  end,
  type,
  subject: "合成对象",
  reason: "合成证据",
  confidence: 0.95,
});
const ids = (result) => result.segments.map((s) => [s.start_id, s.end_id]);

test("body-island prompts preserve the production snapshot and contain generic examples", () => {
  assert.equal(digest(INSTRUCTIONS), EXPECTED_BASELINE_HASH);
  for (const prompt of [
    PARTITION_V2_PROMPT,
    ...Object.values(BODY_ISLAND_VARIANTS).map((v) => v.prompt),
  ]) {
    assert.equal(/BV1Lmd2BAEad|BV1eVaz6UENn|370\.904|125\.970/.test(prompt), false);
  }
});

test("experimental pipe and outline formats retain strict delimiter validation", async () => {
  const ctx = await context();
  assert.deepEqual(ids(parseExperimentalOutput(ctx, pipeOutput, "pipe")), [[2, 3]]);
  assert.deepEqual(
    ids(parseExperimentalOutput(ctx, `分段表\n<ADS>\n${pipeOutput}`, "outline-pipe")),
    [[2, 3]],
  );
  assert.throws(() => parseExperimentalOutput(ctx, pipeOutput, "outline-pipe"));
  assert.throws(() => parseExperimentalOutput(ctx, `<ADS>\n<ADS>\n${pipeOutput}`, "outline-pipe"));
});

test("internal classification experiment adds the proposed steps and retains production protocol", () => {
  const variant = BODY_ISLAND_VARIANTS["internal-classify-pipe"];
  assert.equal(variant.protocol, "pipe");
  assert.equal(variant.prompt.replace(`${INTERNAL_CLASSIFICATION_STEPS}\n\n`, ""), INSTRUCTIONS);
  assert.equal(variant.prompt.split(INTERNAL_CLASSIFICATION_STEPS).length, 2);
  assert.equal(variant.prompt.split("输出规则：")[1], INSTRUCTIONS.split("输出规则：")[1]);
  assert.equal(digest(INSTRUCTIONS), EXPECTED_BASELINE_HASH);
});

test("single-call production-paragraph experiment changes only appended paragraph rules", () => {
  const variant = BODY_ISLAND_VARIANTS["baseline-unmerged"];
  assert.equal(variant.protocol, "pipe");
  assert.equal(variant.prompt.replace(`${UNMERGED_PARAGRAPH_RULES}\n\n`, ""), INSTRUCTIONS);
  assert.equal(variant.prompt.split("输出规则：")[1], INSTRUCTIONS.split("输出规则：")[1]);
  assert.equal(digest(INSTRUCTIONS), EXPECTED_BASELINE_HASH);
  assert.equal(
    BODY_ISLAND_VARIANTS["baseline-unmerged-replace"].prompt.replace(
      "- 每个连续推广小段分别输出一个区间。",
      "- 同一段连续推广合并为一个区间。",
    ),
    variant.prompt,
  );
});

test("partition requires ordered, complete coverage and valid ad metadata", async () => {
  const ctx = await context();
  const parse = (blocks) =>
    parseExperimentalOutput(ctx, JSON.stringify({ topic: "合成", blocks }), "partition");
  assert.deepEqual(ids(parse([block(1, 1, "body"), block(2, 3, "ad"), block(4, 4, "body")])), [
    [2, 3],
  ]);
  assert.deepEqual(ids(parse([block(1, 4, "body")])), []);
  for (const blocks of [
    [block(2, 4, "body")],
    [block(1, 2, "body"), block(2, 4, "ad")],
    [block(1, 5, "body")],
    [block(1, 3, "body")],
    [block(1, 4, "unknown")],
    [{ ...block(1, 4, "ad"), confidence: 4 }],
    [{ ...block(1, 4, "ad"), subject: null }],
  ]) {
    assert.throws(() => parse(blocks));
  }
});

test("v2 ad-only changes only output selection and preserves definition, rules and examples", () => {
  let restored = PARTITION_V2_AD_ONLY_PROMPT.slice(0, -PARTITION_AD_ONLY_SUFFIX.length);
  for (const [before, after] of PARTITION_AD_ONLY_OUTPUT_CHANGES) {
    assert.equal(PARTITION_V2_PROMPT.split(before).length, 2);
    assert.equal(restored.split(after).length, 2);
    restored = restored.replace(after, before);
  }
  assert.equal(restored, PARTITION_V2_PROMPT);
  assert.equal(
    PARTITION_V2_AD_ONLY_PROMPT.split("边界复核规则：")[1].slice(
      0,
      -PARTITION_AD_ONLY_SUFFIX.length,
    ),
    PARTITION_V2_PROMPT.split("边界复核规则：")[1],
  );
  assert.equal(digest(INSTRUCTIONS), EXPECTED_BASELINE_HASH);
});

test("ad-only JSON accepts gaps and empty results and rejects body, overlap, ordering and invalid fields", async () => {
  const ctx = await context();
  const parse = (blocks) =>
    parseExperimentalOutput(ctx, JSON.stringify({ topic: "合成", blocks }), "partition-ad-only");
  assert.deepEqual(ids(parse([block(1, 1, "ad"), block(3, 3, "ad")])), [
    [1, 1],
    [3, 3],
  ]);
  assert.deepEqual(ids(parse([block(2, 2, "ad"), block(3, 3, "ad")])), [
    [2, 2],
    [3, 3],
  ]);
  assert.deepEqual(ids(parse([])), []);
  for (const blocks of [
    [block(1, 4, "body")],
    [block(1, 2, "ad"), block(2, 3, "ad")],
    [block(3, 3, "ad"), block(1, 1, "ad")],
    [block(0, 1, "ad")],
    [block(2, 5, "ad")],
    [{ ...block(2, 3, "ad"), confidence: 4 }],
    [{ ...block(2, 3, "ad"), subject: null }],
  ]) {
    assert.throws(() => parse(blocks));
  }
});

test("v2 pipe changes output representation while retaining v2 boundaries and example", () => {
  let restored = PARTITION_V2_AD_PIPE_PROMPT;
  for (const [before, after] of PARTITION_AD_PIPE_OUTPUT_CHANGES) {
    assert.equal(PARTITION_V2_AD_ONLY_PROMPT.split(before).length, 2);
    assert.equal(restored.split(after).length, 2);
    restored = restored.replace(after, before);
  }
  assert.equal(restored, PARTITION_V2_AD_ONLY_PROMPT);
  assert.equal(
    PARTITION_V2_AD_PIPE_PROMPT.split("边界复核规则：")[1].split("\n\n最终")[0],
    PARTITION_V2_AD_ONLY_PROMPT.split("边界复核规则：")[1].split("\n\n最终")[0],
  );
  assert.equal(BODY_ISLAND_VARIANTS["partition-v2-ad-pipe"].protocol, "pipe");
  let clarified = PARTITION_V2_AD_PIPE_V2_PROMPT;
  for (const [before, after] of PARTITION_AD_PIPE_V2_OUTPUT_CHANGES) {
    assert.equal(PARTITION_V2_AD_PIPE_PROMPT.split(before).length, 2);
    assert.equal(clarified.split(after).length, 2);
    clarified = clarified.replace(after, before);
  }
  assert.equal(clarified, PARTITION_V2_AD_PIPE_PROMPT);
});

test("v2 pipe uses the production decoder with equal experimental output budget", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/partition-pipe-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = await context();
  let request;
  const run = await runBodyIslandExperiment({
    samples: [
      {
        id: "00000000-0000-4000-8000-000000000017",
        video: ctx.video,
        transcript: { status: "ready", context: ctx },
        community: { status: "missing", segments: [] },
      },
    ],
    variant: "partition-v2-ad-pipe",
    key: "synthetic-v2-pipe-key",
    dbRoot: root,
    runsRoot: root,
    maxOutputTokens: 8192,
    // Synthetic final output preserves the ordinary five-column protocol.
    fetcher: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          model: "synthetic",
          usage,
          choices: [{ finish_reason: "stop", message: { content: pipeOutput } }],
        }),
      );
    },
  });
  assert.equal(run.status, "done");
  assert.equal(request.messages[0].content, PARTITION_V2_AD_PIPE_PROMPT);
  assert.equal(request.messages[1].content, compactPromptData(ctx));
  assert.equal(request.thinking.type, "disabled");
  assert.equal(request.temperature, 0);
  assert.equal(request.max_tokens, 8192);
  assert.equal(request.response_format, undefined);
  assert.equal(run.results[0].apiCalls, 1);
  assert.deepEqual(ids(run.results[0]), [[2, 3]]);
});

test("ad-only experiment keeps original v2 model parameters, JSON mode and output budget", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/partition-ad-only-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = await context();
  let request;
  const key = "synthetic-partition-ad-only-key";
  const run = await runBodyIslandExperiment({
    samples: [
      {
        id: "00000000-0000-4000-8000-000000000016",
        video: ctx.video,
        transcript: { status: "ready", context: ctx },
        community: { status: "missing", segments: [] },
      },
    ],
    variant: "partition-v2-ad-only",
    key,
    dbRoot: root,
    runsRoot: root,
    // Synthetic response exercises the exact runtime path without a paid request.
    fetcher: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          model: "synthetic",
          usage,
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ topic: "合成", blocks: [block(2, 3, "ad")] }) },
            },
          ],
        }),
      );
    },
  });
  assert.equal(run.status, "done");
  assert.equal(request.messages[0].content, PARTITION_V2_AD_ONLY_PROMPT);
  assert.equal(request.messages[1].content, compactPromptData(ctx));
  assert.equal(request.thinking.type, "disabled");
  assert.equal(request.temperature, 0);
  assert.equal(request.response_format.type, "json_object");
  assert.equal(request.max_tokens, 8192);
  assert.equal(run.results[0].apiCalls, 1);
  assert.deepEqual(ids(run.results[0]), [[2, 3]]);
  assert.equal(run.results[0].usage.outputTokens, usage.completion_tokens);
  assert.equal((await readFile(path.join(root, `${run.id}.json`), "utf8")).includes(key), false);
});

test("candidate review preserves identity and rejects out-of-candidate or mismatched body ranges", async () => {
  const ctx = await context();
  const candidates = parseExperimentalOutput(ctx, pipeOutput, "pipe").segments;
  assert.deepEqual(
    ids(parseExperimentalOutput(ctx, "内容\n<BODY>\n2|2", "review-body", candidates)),
    [[3, 3]],
  );
  for (const text of ["<BODY>\n1|2", "<BODY>\n2|3\n2|3", "<BODY>\n2|2\n</BODY>"]) {
    assert.throws(() => parseExperimentalOutput(ctx, text, "review-body", candidates));
  }
  const payload = {
    topic: "合成",
    blocks: [block(2, 2, "body"), block(3, 3, "ad")],
    body: [{ start: 2, end: 2 }],
  };
  assert.deepEqual(
    ids(parseExperimentalOutput(ctx, JSON.stringify(payload), "review-json", candidates)),
    [[3, 3]],
  );
  payload.body = [];
  assert.throws(() =>
    parseExperimentalOutput(ctx, JSON.stringify(payload), "review-json", candidates),
  );
});

test("per-ID protocols split discontinuous ads and validate complete disjoint classifications", async () => {
  const ctx = await context();
  const ad = { ids: [1, 3], brand: "合成", reason: "合成", confidence: 0.95 };
  const payload = {
    topic: "合成",
    ads: [ad],
    body: [
      { start: 2, end: 2 },
      { start: 4, end: 4 },
    ],
  };
  const parse = (p, protocol = "body-first-ids") =>
    parseExperimentalOutput(ctx, JSON.stringify(p), protocol);
  assert.deepEqual(ids(parse(payload)), [
    [1, 1],
    [3, 3],
  ]);
  assert.throws(() => parse({ ...payload, body: [{ start: 2, end: 4 }] }));
  assert.throws(() => parse({ ...payload, body: [] }));
  assert.throws(() => parse({ ...payload, ads: [{ ...ad, ids: [1, 1] }] }, "ad-ids"));
  assert.throws(() => parse({ ...payload, ads: [{ ...ad, brand: null }] }));
});

async function repairFixture(duration = 100) {
  const ctx = await normalize(
    { ...(await context()).video, duration },
    Array.from({ length: 10 }, (_, i) => ({
      from: i * 5,
      to: (i + 1) * 5,
      content: `合成字幕${i + 1}`,
    })),
  );
  const candidates = parseExperimentalOutput(ctx, "2|9|合成品牌|合成推广|0.91", "pipe").segments;
  return { ctx, candidates };
}

test("repair subtracts only internal islands, retains original scores and outer bounds", async () => {
  const { ctx, candidates } = await repairFixture();
  const blocks = [
    block(1, 1, "body"),
    block(2, 3, "ad"),
    block(4, 4, "body"),
    block(5, 6, "body"),
    block(7, 9, "ad"),
    block(10, 10, "body"),
  ];
  const before = structuredClone({ candidates, blocks });
  const result = repairBodyIslands(ctx, candidates, blocks);
  assert.deepEqual(ids(result), [
    [2, 3],
    [7, 9],
  ]);
  assert.deepEqual(result.removed, [{ start: 4, end: 6 }]);
  assert.ok(result.segments.every((s) => s.confidence === 0.91));
  assert.deepEqual({ candidates, blocks }, before);
  assert.deepEqual(
    ids(repairBodyIslands(ctx, candidates, [block(1, 5, "body"), block(6, 10, "ad")])),
    [[2, 9]],
  );
  assert.deepEqual(ids(repairBodyIslands(ctx, candidates, [block(1, 10, "body")])), [[2, 9]]);
  assert.deepEqual(ids(repairBodyIslands(ctx, [], blocks)), []);
  assert.throws(() => repairBodyIslands(ctx, candidates, [block(2, 10, "body")]));
});

test("repair retains the original 50 percent protection decision at equality", async () => {
  const { ctx, candidates } = await repairFixture(80);
  const result = repairBodyIslands(ctx, candidates, [
    block(1, 3, "ad"),
    block(4, 6, "body"),
    block(7, 10, "ad"),
  ]);
  assert.equal(result.originalProtected, true);
  assert.deepEqual(result.segments, candidates);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.proposedRemoved, [{ start: 4, end: 6 }]);
});

test("local review requires one ordered, typed decision for every requested ID", () => {
  const items = [2, 3].map((id) => ({ id, subject: "合成", type: "body" }));
  const parse = (list) => parseLocalDecisions(JSON.stringify({ items: list }), 2, 3);
  assert.deepEqual(parse(items), items);
  assert.throws(() => parse(items.slice(0, 1)));
  assert.throws(() => parse(items.toReversed()));
  assert.throws(() => parse([items[0], { ...items[1], type: "maybe" }]));
  assert.throws(() => parse([items[0], { ...items[1], subject: null }]));
});

test("experiment runner records strict failures and usage while isolating credentials", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/body-islands-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = await context();
  const key = "synthetic-experiment-secret";
  const sample = {
    id: "00000000-0000-4000-8000-000000000010",
    video: ctx.video,
    transcript: { status: "ready", context: ctx },
    community: { status: "missing", segments: [] },
  };
  const requests = [];
  const run = await runBodyIslandExperiment({
    samples: [sample],
    variant: "partition-v2",
    key,
    repeats: 2,
    dbRoot: root,
    runsRoot: root,
    fetcher: async function (url, options) {
      assert.equal(this, globalThis);
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      assert.equal(options.redirect, "error");
      requests.push(JSON.parse(options.body));
      return new Response(
        JSON.stringify({
          model: "synthetic",
          usage,
          choices: [
            {
              finish_reason: "stop",
              message: {
                content:
                  requests.length === 1
                    ? JSON.stringify({ topic: "合成", blocks: [block(1, 4, "body")] })
                    : "invalid JSON",
              },
            },
          ],
        }),
      );
    },
  });
  assert.equal(run.status, "partial");
  assert.deepEqual(
    run.results.map((r) => r.status),
    ["done", "error"],
  );
  assert.ok(
    run.results.every((r) => r.usage.promptTokens === usage.prompt_tokens && r.apiCalls === 1),
  );
  assert.equal(requests[0].thinking.type, "disabled");
  assert.equal(requests[0].max_tokens, 8192);
  assert.equal(requests[0].response_format.type, "json_object");
  const stored = await readFile(path.join(root, `${run.id}.json`), "utf8");
  assert.equal(stored.includes(key), false);
  assert.equal(run.productionPromptSha256, EXPECTED_BASELINE_HASH);
});

test("experiment cost audit deduplicates source runs and derived pipelines", () => {
  const source = {
    id: "source",
    name: "正文岛-synthetic",
    results: [
      {
        apiCalls: 1,
        status: "error",
        usage: {
          promptTokens: 100,
          outputTokens: 10,
          cacheHit: 20,
          cacheMiss: 80,
          offPeakCny: 0.01,
          peakCny: 0.02,
        },
      },
    ],
  };
  const derived = { ...source, id: "derived", experiment: { derived: true } };
  const pipeline = { ...source, id: "pipeline", experiment: { variant: "repair-only-frozen" } };
  const local = {
    ...source,
    id: "local",
    experiment: { pipeline: true, primaryReused: true, variant: "local-review" },
  };
  const result = summarizeExperimentRuns([source, source, derived, pipeline, local]);
  assert.deepEqual(result.countedRuns, ["source", "local"]);
  assert.deepEqual(result.excludedDerivedRuns, ["derived", "pipeline"]);
  assert.equal(result.totals.apiCalls, 2);
  assert.equal(result.totals.promptTokens, 200);
  assert.equal(result.totals.failedResults, 2);
});

test("thinking experiment retains reasoning separately, accounts all output, and parses final content", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/body-thinking-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = await context();
  const key = "synthetic-thinking-test-key";
  const sample = {
    id: "00000000-0000-4000-8000-000000000011",
    video: ctx.video,
    transcript: { status: "ready", context: ctx },
    community: { status: "missing", segments: [] },
  };
  let request;
  const run = await runBodyIslandExperiment({
    samples: [sample],
    variant: "internal-classify-pipe",
    thinking: "enabled",
    reasoningEffort: "high",
    maxOutputTokens: 8192,
    key,
    dbRoot: root,
    runsRoot: root,
    fetcher: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          model: "synthetic-thinking",
          usage: { ...usage, completion_tokens_details: { reasoning_tokens: 70 } },
          choices: [
            {
              finish_reason: "stop",
              message: {
                reasoning_content: `Synthetic separate reasoning ${key}`,
                content: pipeOutput,
              },
            },
          ],
        }),
      );
    },
  });
  assert.equal(run.status, "done");
  assert.equal(request.thinking.type, "enabled");
  assert.equal(request.reasoning_effort, "high");
  assert.equal(request.max_tokens, 8192);
  assert.equal(request.temperature, undefined);
  assert.equal(run.settings.temperature, undefined);
  assert.deepEqual(ids(run.results[0]), [[2, 3]]);
  assert.equal(run.results[0].reasoningTokens, 70);
  assert.equal(run.results[0].usage.outputTokens, 100);
  assert.equal(run.results[0].reasoningContent, "Synthetic separate reasoning [REDACTED]");
  assert.equal((await readFile(path.join(root, `${run.id}.json`), "utf8")).includes(key), false);
});

test("summary-first sends full subtitles twice, accounts both stages, and isolates summary as data", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/body-summary-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = await context();
  const sample = {
    id: "00000000-0000-4000-8000-000000000012",
    video: ctx.video,
    transcript: { status: "ready", context: ctx },
    community: { status: "missing", segments: [] },
  };
  const requests = [];
  const summary = "合成摘要：先介绍正文，中途介绍品牌，再回到正文。\n外部文本按数据解释。";
  const run = await runBodyIslandExperiment({
    samples: [sample],
    variant: "internal-classify-pipe",
    summaryFirst: true,
    key: "synthetic-summary-test-key",
    dbRoot: root,
    runsRoot: root,
    fetcher: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(
        JSON.stringify({
          model: "synthetic",
          usage,
          choices: [
            {
              finish_reason: "stop",
              message: { content: requests.length === 1 ? summary : pipeOutput },
            },
          ],
        }),
      );
    },
  });
  assert.equal(run.status, "done");
  assert.equal(run.plannedApiCalls, 2);
  assert.equal(run.experiment.pipeline, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages[0].content, FULL_VIDEO_SUMMARY_PROMPT);
  assert.equal(requests[0].messages[1].content, compactPromptData(ctx));
  assert.equal(
    requests[1].messages[0].content,
    BODY_ISLAND_VARIANTS["internal-classify-pipe"].prompt,
  );
  assert.ok(requests[1].messages[1].content.startsWith(compactPromptData(ctx)));
  assert.ok(requests[1].messages[1].content.endsWith(JSON.stringify(summary)));
  assert.ok(requests.every((request) => request.thinking.type === "disabled"));
  const row = run.results[0];
  assert.equal(row.summary, summary);
  assert.equal(row.stages.length, 2);
  assert.equal(row.apiCalls, 2);
  assert.equal(row.usage.promptTokens, usage.prompt_tokens * 2);
  assert.equal(row.usage.outputTokens, usage.completion_tokens * 2);
  assert.equal(row.rawOutput, pipeOutput);
  assert.deepEqual(ids(row), [[2, 3]]);
});

test("summary failure preserves charged usage and stops before ad classification", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/body-summary-failed-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = await context();
  let calls = 0;
  const run = await runBodyIslandExperiment({
    samples: [
      {
        id: "00000000-0000-4000-8000-000000000013",
        video: ctx.video,
        transcript: { status: "ready", context: ctx },
        community: { status: "missing", segments: [] },
      },
    ],
    variant: "internal-classify-pipe",
    summaryFirst: true,
    key: "synthetic-summary-test-key",
    dbRoot: root,
    runsRoot: root,
    fetcher: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          model: "synthetic",
          usage,
          choices: [{ finish_reason: "length", message: { content: "partial summary" } }],
        }),
      );
    },
  });
  assert.equal(run.status, "partial");
  assert.equal(calls, 1);
  assert.equal(run.results[0].stages[0].status, "error");
  assert.equal(run.results[0].usage.outputTokens, usage.completion_tokens);
  assert.equal(run.results[0].segments, undefined);
});
