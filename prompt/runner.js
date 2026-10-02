import { randomUUID } from "node:crypto";
import path from "node:path";
import { INSTRUCTIONS, MAX_BYTES } from "../extension/lib/constants.js";
import { DeepSeekClient, deepseekRequest } from "../extension/lib/providers.js";
import { normalize } from "../extension/lib/core.js";
import { boundedBody } from "../extension/lib/bilibili.js";
import {
  saveJson,
  digest,
  validId,
  intervalDiff,
  communityReference,
  DEFAULT_RUNS,
  sampleVideo,
} from "./data.js";
import {
  METRIC_POLICY,
  referenceSnapshot,
  evaluationIdentity,
  evaluate,
  aggregateMetrics,
} from "./metrics.js";
import { ExclusionStore, exclusionFor, inTestSet } from "./datasets.js";
import { AdOnlyJsonClient } from "./experiments/ad-only-json-client.js";

export function validateRunOptions(options) {
  if (!options || options.consent !== true) {
    throw new Error("请确认本次将所选字幕发送至DeepSeek并按API用量计费。");
  }
  if (options.protocol !== undefined && !["pipe", "partition-ad-only"].includes(options.protocol)) {
    throw new Error("评测协议须为pipe或partition-ad-only。");
  }
  if (
    !Array.isArray(options.ids) ||
    !options.ids.length ||
    options.ids.length > 1000 ||
    !options.ids.every(validId) ||
    new Set(options.ids).size !== options.ids.length
  ) {
    throw new Error("请选择1至1000个独立样本。");
  }
  const calls = options.ids.length * options.repeats;
  if (
    !Number.isInteger(options.repeats) ||
    options.repeats < 1 ||
    options.repeats > 5 ||
    calls > 3000
  ) {
    throw new Error("重复次数为1至5，单批最多3000次请求。");
  }
  if (calls > 20 && options.confirmedCalls !== calls) {
    throw new Error(`大批次需明确确认本次 ${calls} 次模型调用。`);
  }
  if (
    typeof options.prompt !== "string" ||
    !options.prompt.trim() ||
    options.prompt.length > 30000
  ) {
    throw new Error("Prompt须为1至30000字符。");
  }
  if (options.allowAlternate !== undefined && typeof options.allowAlternate !== "boolean") {
    throw new Error("替代字幕授权格式异常。");
  }
  if (
    options.concurrency !== undefined &&
    (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8)
  ) {
    throw new Error("模型并发范围为1至8。");
  }
  if (
    options.name !== undefined &&
    (typeof options.name !== "string" || options.name.length > 100)
  ) {
    throw new Error("批次名称最多100字符。");
  }
  return options;
}

export async function sampleInput(sample, { allowAlternate = false } = {}) {
  if (!sample.transcript?.context) {
    throw new Error("样本缺少完整字幕，请先导入或采集字幕。");
  }
  const ctx = sample.transcript.context;
  const verified = await normalize(ctx.video, ctx.cues, ctx.source);
  if (verified.transcript_sha256 !== ctx.transcript_sha256) {
    throw new Error("本地字幕文件指纹校验失败。");
  }
  const video = sampleVideo(sample);
  if (
    verified.video.bvid !== video.bvid ||
    verified.video.page !== video.page ||
    verified.video.cid !== video.cid
  ) {
    throw new Error("字幕和样本视频身份不匹配。");
  }
  const exact =
    !sample.baseline || verified.transcript_sha256 === sample.baseline.transcript_sha256;
  if (!exact && !allowAlternate) {
    throw new Error("该字幕与原标记指纹不同，请明确允许替代字幕实验。");
  }
  return { context: verified, exact };
}

export class LabRunner {
  constructor({
    db,
    runsRoot = DEFAULT_RUNS,
    fetcher = fetch,
    keyProvider = () => process.env.DEEPSEEK_API_KEY || "",
  }) {
    Object.assign(this, { db, runsRoot, keyProvider });
    this.fetcher = fetcher.bind(globalThis);
    this.active = null;
    this.writeQueue = Promise.resolve();
  }

  async start(options, keyOverride) {
    validateRunOptions(options);
    if (this.active) {
      throw new Error("已有批次运行中，请完成或停止后再开始。");
    }
    const slot = {
      id: randomUUID(),
      cancelled: false,
      status: "preparing",
      controllers: new Set(),
    };
    this.active = slot;
    try {
      const suppliedKey = keyOverride || (await this.keyProvider());
      if (typeof suppliedKey !== "string") {
        throw new Error("API Key须为文本。");
      }
      const key = suppliedKey.trim();
      if (key.length < 12 || key.length > 2048 || /\s/.test(key)) {
        throw new Error("请提供DeepSeek API Key，或设置服务进程的DEEPSEEK_API_KEY。");
      }
      if (options.prompt.includes(key) || options.name?.includes(key)) {
        throw new Error("Prompt或批次名称包含API Key，请移除凭据后再运行。");
      }
      const inputs = [];
      const identities = new Set();
      const ledger = await new ExclusionStore(this.db.root).read();
      if (options.datasetRevision && options.datasetRevision !== ledger.revision) {
        throw new Error("有效测试集已更新，请刷新后重新确认调用范围。");
      }
      for (const id of options.ids) {
        const sample = await this.db.get(id);
        if (exclusionFor(sample, ledger)?.excluded) {
          throw new Error("所选样本已从有效测试集移除，请先恢复再运行。");
        }
        if (options.dataset && !inTestSet(sample, options.dataset)) {
          throw new Error("所选样本不在当前测试集中。");
        }
        const input = await sampleInput(sample, options);
        const reference = referenceSnapshot(sample);
        if (JSON.stringify(input.context).includes(key)) {
          throw new Error("字幕或标题中包含当前API Key，请先移除凭据。");
        }
        const identity = `${input.context.video_key}:${input.context.transcript_sha256}`;
        if (identities.has(identity)) {
          throw new Error("同一视频字幕输入存在重复，请按输入去重后运行。");
        }
        identities.add(identity);
        inputs.push({ sample, ...input, reference });
      }
      const report = {
        schemaVersion: 2,
        id: slot.id,
        name: options.name?.trim() || "未命名批次",
        startedAt: new Date().toISOString(),
        status: "running",
        prompt: options.prompt,
        promptSha256: digest(options.prompt),
        productionPromptSha256: digest(INSTRUCTIONS),
        settings: {
          model: "deepseek-flash",
          thinking: "disabled",
          temperature: 0,
          max_tokens: options.protocol === "partition-ad-only" ? 8192 : 2048,
          ...(options.protocol === "partition-ad-only"
            ? {
                experimentalProtocol: "partition-ad-only",
                response_format: { type: "json_object" },
              }
            : {}),
        },
        concurrency: options.concurrency || 1,
        metricPolicy: METRIC_POLICY,
        repeats: options.repeats,
        plannedCalls: inputs.length * options.repeats,
        sampleIds: options.ids,
        dataset: options.dataset || "all",
        datasetRevision: ledger.revision,
        datasetSha256: digest([...identities].sort()),
        results: [],
        ...(options.protocol === "partition-ad-only"
          ? {
              experiment: {
                protocol: "partition-ad-only",
                variant: "ad-only-json-batch",
                outputMaxTokens: 8192,
              },
            }
          : {}),
      };
      slot.report = report;
      slot.status = "running";
      await this.persist(report, key);
      slot.task = this.execute(slot, report, inputs, key)
        .catch(async (error) => {
          report.status = "error";
          report.error = "运行记录写入或执行异常，请检查本地磁盘。";
          report.executionErrors ||= [
            {
              code: error.code || error.name || "LAB_EXECUTION",
              message: String(error.message).replaceAll(key, "[REDACTED]").slice(0, 500),
            },
          ];
          report.finishedAt = new Date().toISOString();
          slot.cancelled = true;
          for (const controller of slot.controllers) {
            controller.abort();
          }
          await this.persist(report, key).catch(() => {});
        })
        .finally(() => {
          if (this.active === slot) {
            this.active = null;
          }
        });
      return structuredClone(report);
    } catch (error) {
      if (this.active === slot) {
        this.active = null;
      }
      throw error;
    }
  }

  async persist(report, key) {
    const raw = JSON.stringify(report);
    if (raw.includes(key)) {
      throw new Error("运行记录包含凭据，停止保存。");
    }
    const snapshot = JSON.parse(raw);
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() => saveJson(path.join(this.runsRoot, `${report.id}.json`), snapshot));
    await this.writeQueue;
  }

  async execute(slot, report, inputs, key) {
    const jobs = [];
    for (let repeat = 1; repeat <= report.repeats; repeat++) {
      for (const input of inputs) {
        jobs.push({ ...input, repeat });
      }
    }
    let cursor = 0;
    const tasks = Array.from({ length: report.concurrency }, async () => {
      while (!slot.cancelled && cursor < jobs.length) {
        const { sample, context, exact, repeat, reference } = jobs[cursor++];
        const request = deepseekRequest(context, { protocol: "pipe" });
        request.messages[0].content = report.prompt;
        const jsonProtocol = report.settings.experimentalProtocol === "partition-ad-only";
        if (jsonProtocol) {
          request.max_tokens = 8192;
          request.response_format = { type: "json_object" };
        }
        const row = {
          caseId: sample.id,
          bvid: context.video.bvid,
          title: context.video.title,
          video: context.video,
          baselineVersion: sample.baseline?.prompt_version || null,
          split: sample.split,
          baseline: sample.baseline,
          repeat,
          startedAt: new Date().toISOString(),
          transcriptStatus: exact ? "exact" : "alternate",
          transcriptSha256: context.transcript_sha256,
          request,
          apiCalls: 0,
          referenceSnapshot: reference,
          evaluationIdentity: evaluationIdentity(context, reference, request.messages[1].content),
        };
        const controller = new AbortController();
        slot.controllers.add(controller);
        try {
          const Client = jsonProtocol ? AdOnlyJsonClient : DeepSeekClient;
          const client = new Client(
            async (url, options) => {
              if (url !== "https://api.deepseek.com/chat/completions") {
                throw new Error("Unexpected model destination");
              }
              row.apiCalls++;
              const response = await this.fetcher(url, {
                ...options,
                signal: AbortSignal.any([options.signal, controller.signal]),
                body: JSON.stringify(request),
              });
              row.httpStatus = response.status;
              if ([401, 402, 403, 429].includes(response.status)) {
                slot.cancelled = true;
                report.stopReason = `HTTP ${response.status}`;
                for (const pending of slot.controllers) {
                  if (pending !== controller) {
                    pending.abort();
                  }
                }
              }
              if (response.ok) {
                const payload = JSON.parse(
                  new TextDecoder().decode(await boundedBody(response.clone(), MAX_BYTES)),
                );
                row.rawOutput =
                  typeof payload.choices?.[0]?.message?.content === "string"
                    ? payload.choices[0].message.content.replaceAll(key, "[REDACTED]")
                    : "";
                row.finishReason = payload.choices?.[0]?.finish_reason;
                row.returnedModel = payload.model;
                row.apiUsage = payload.usage;
              }
              return response;
            },
            { protocol: "pipe" },
          );
          const result = await client.analyze(context, key);
          row.status = "done";
          row.segments = result.segments;
          if (result.explanation) {
            row.explanation = result.explanation;
          }
          row.usage = result.usage;
          row.elapsedMs = result.elapsedMs;
          row.evaluation = evaluate(context.video, result.segments, reference);
          row.comparisonToBaseline = sample.baseline
            ? intervalDiff(result.segments, sample.baseline.segments)
            : null;
          const community = communityReference(sample);
          row.comparisonToCommunity = community?.length
            ? intervalDiff(result.segments, community)
            : null;
          row.communityReference = sample.community;
          row.comparisonToHuman =
            reference.kind === "human" ? intervalDiff(result.segments, reference.ranges) : null;
          row.humanBodyOverlap = row.evaluation.bodyPreserveOverlap;
        } catch (error) {
          row.status = slot.cancelled ? "cancelled" : "error";
          row.error = {
            code: error.code || "LAB_RUN",
            message: slot.cancelled
              ? "已停止等待，已发出的请求可能计费。"
              : String(error.message).replaceAll(key, "[REDACTED]"),
          };
          row.usage = error.details?.usage || null;
          row.elapsedMs = error.details?.elapsedMs;
        }
        slot.controllers.delete(controller);
        report.results.push(row);
        report.metrics = aggregateMetrics(report.results);
        await this.persist(report, key);
      }
    });
    const completed = await Promise.allSettled(tasks);
    if (completed.some((result) => result.status === "rejected")) {
      report.executionErrors = completed
        .filter((result) => result.status === "rejected")
        .map(({ reason }) => ({
          code: reason?.code || reason?.name || "LAB_WORKER",
          message: String(reason?.message || "批次工作线程异常")
            .replaceAll(key, "[REDACTED]")
            .slice(0, 500),
        }));
      throw new Error("批次工作线程异常，请检查本地运行记录。");
    }
    report.status = slot.cancelled
      ? "cancelled"
      : report.results.some((r) => r.status !== "done")
        ? "partial"
        : "done";
    report.finishedAt = new Date().toISOString();
    report.metrics = aggregateMetrics(report.results);
    await this.persist(report, key);
  }

  cancel(id) {
    if (!this.active || this.active.id !== id) {
      throw new Error("当前批次已经结束。");
    }
    this.active.cancelled = true;
    for (const controller of this.active.controllers) {
      controller.abort();
    }
    return { cancelled: true };
  }
}
