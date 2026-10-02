import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { context, pipeOutput, usage } from "../../tests/extension/fixtures.js";
import { compactPromptData } from "../../extension/lib/prompt.js";
import { parseModelOutput } from "../../extension/lib/model-output.js";
import {
  prepareSummaryCandidateReview,
  parseSummaryCandidateReview,
  SUMMARY_CANDIDATE_REVIEW_PROMPT,
} from "../experiments/summary-candidate-review.js";
import { runBodyIslandExperiment } from "../experiments/body-islands-runner.js";

// Synthetic upstream records isolate paid calls and exercise real identity/output validation.
async function fixture() {
  const ctx = await context();
  const summary = "合成视频，正文中间出现推广，再恢复正文。";
  const source = {
    caseId: "00000000-0000-4000-8000-000000000014",
    repeat: 1,
    status: "done",
    video: ctx.video,
    transcriptSha256: ctx.transcript_sha256,
    summary,
    rawOutput: pipeOutput,
    segments: parseModelOutput(ctx, pipeOutput).segments,
    usage: { promptTokens: 2000, outputTokens: 200 },
    elapsedMs: 300,
    stages: [
      {
        status: "done",
        rawOutput: summary,
        request: {
          thinking: { type: "disabled" },
          messages: [
            { role: "system", content: "Synthetic summarizer" },
            { role: "user", content: compactPromptData(ctx) },
          ],
        },
      },
      { status: "done", rawOutput: pipeOutput, request: { thinking: { type: "disabled" } } },
    ],
  };
  return { ctx, source };
}

test("candidate review validates source identity and bounds final model intervals", async () => {
  const { ctx, source } = await fixture();
  const prepared = prepareSummaryCandidateReview(ctx, source);
  assert.deepEqual(prepared.cueIds, [1, 2, 3, 4]);
  assert.ok(prepared.input.includes(JSON.stringify(source.summary)));
  assert.deepEqual(
    parseSummaryCandidateReview(ctx, "2|2|合成|合成|0.9", prepared.candidates).segments.map((s) => [
      s.start_id,
      s.end_id,
    ]),
    [[2, 2]],
  );
  assert.deepEqual(parseSummaryCandidateReview(ctx, "NONE", prepared.candidates).segments, []);
  assert.throws(() => parseSummaryCandidateReview(ctx, "1|3|合成|合成|0.9", prepared.candidates));
  assert.throws(() =>
    prepareSummaryCandidateReview(ctx, { ...source, transcriptSha256: "changed" }),
  );
  assert.throws(() => prepareSummaryCandidateReview(ctx, { ...source, summary: "changed" }));
  assert.throws(() =>
    parseSummaryCandidateReview(ctx, "2|3|合成|合成|0.9", [
      { start_id: 2, end_id: 2 },
      { start_id: 3, end_id: 3 },
    ]),
  );
});

test("candidate review sends one new request and preserves upstream costs separately", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/candidate-review-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { ctx, source } = await fixture();
  const sample = {
    id: source.caseId,
    video: ctx.video,
    transcript: { status: "ready", context: ctx },
    community: { status: "missing", segments: [] },
  };
  let calls = 0;
  let request;
  const key = "synthetic-candidate-review-key";
  const run = await runBodyIslandExperiment({
    samples: [sample],
    variant: "summary-candidate-review",
    candidateSource: { id: "synthetic-source", results: [source] },
    key,
    dbRoot: root,
    runsRoot: root,
    fetcher: async (_url, options) => {
      calls++;
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
  assert.equal(calls, 1);
  assert.equal(run.status, "done");
  assert.equal(request.thinking.type, "disabled");
  assert.equal(request.messages[0].content, SUMMARY_CANDIDATE_REVIEW_PROMPT);
  assert.equal(run.results[0].apiCalls, 1);
  assert.equal(run.results[0].usage.promptTokens, usage.prompt_tokens);
  assert.equal(run.results[0].sourceUsage.promptTokens, 2000);
  assert.equal(run.results[0].sourceStages.length, 2);
  assert.equal(run.experiment.sourceReused, true);
  assert.equal((await readFile(path.join(root, `${run.id}.json`), "utf8")).includes(key), false);
});
