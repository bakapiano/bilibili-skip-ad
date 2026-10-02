import { MODEL, PROMPT_VERSION, INSTRUCTIONS, MAX_BYTES, BUILD_VERSION } from "./constants.js";
import { ASR_VERSION } from "./asr-config.js";
import {
  AppError,
  assert,
  canonical,
  hash,
  sharedOrigin,
  usageCost,
  validateLabels,
} from "./core.js";
import { boundedBody } from "./bilibili.js";
import { compactPromptData } from "./prompt.js";
import { parseModelOutput, parseAdBlocksOutput } from "./model-output.js";

export function deepseekRequest(context, { protocol = "json" } = {}) {
  return {
    model: MODEL,
    messages: [
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: compactPromptData(context) },
    ],
    thinking: { type: "disabled" },
    temperature: 0,
    max_tokens: protocol === "pipe" ? 2048 : 8192,
    ...(protocol === "pipe" ? {} : { response_format: { type: "json_object" } }),
    stream: false,
  };
}
export class DeepSeekClient {
  constructor(fetcher = fetch, { protocol = "json" } = {}) {
    this.fetcher = fetcher.bind(globalThis);
    assert(["json", "pipe"].includes(protocol), "OUTPUT", "模型输出协议异常。");
    this.protocol = protocol;
  }
  async analyze(context, key) {
    assert(
      typeof key === "string" && key.trim().length >= 12 && !/\s/.test(key),
      "KEY",
      "请先在设置中配置 DeepSeek API Key。",
    );
    const requestContext = structuredClone(context);
    const start = performance.now();
    let usage;
    try {
      const response = await this.fetcher("https://api.deepseek.com/chat/completions", {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(25000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(deepseekRequest(requestContext, { protocol: this.protocol })),
      });
      const messages = {
        401: "DeepSeek Key 验证失败，请更新设置。",
        402: "DeepSeek 可用额度不足，请检查账户额度。",
        403: "DeepSeek 拒绝本次请求，请检查服务访问状态。",
        429: "DeepSeek 请求频率较高，请稍后手动重试。",
      };
      assert(
        response.ok,
        "DEEPSEEK_HTTP",
        messages[response.status] || `DeepSeek 返回 HTTP ${response.status}，请稍后重试。`,
      );
      const payload = JSON.parse(new TextDecoder().decode(await boundedBody(response, MAX_BYTES)));
      usage = usageCost(payload.usage);
      assert(
        Array.isArray(payload.choices) && payload.choices.length === 1,
        "OUTPUT",
        "DeepSeek 返回的选项格式异常。",
      );
      const choice = payload.choices[0];
      assert(
        choice.finish_reason === "stop" && !choice.message?.tool_calls?.length,
        "OUTPUT",
        "本轮输出未完整结束，用量已记录，请手动重试。",
      );
      const parse = this.protocol === "pipe" ? parseModelOutput : parseAdBlocksOutput;
      const result = parse(requestContext, choice.message?.content);
      return {
        ...result,
        usage,
        elapsedMs: Math.round(performance.now() - start),
        model: MODEL,
      };
    } catch (error) {
      if (error instanceof AppError) {
        error.details = { usage, elapsedMs: Math.round(performance.now() - start) };
        throw error;
      }
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new AppError(
        timeout ? "TIMEOUT" : "DEEPSEEK_NETWORK",
        timeout
          ? "模型请求超过 25 秒，已停止等待。此前可能产生用量，重试会发起新请求。"
          : "DeepSeek 请求或响应解析未完成，请手动重试。",
        { usage, elapsedMs: Math.round(performance.now() - start) },
      );
    }
  }
}

// Future self-hosted HTTPS API. Authentication is a separate server token;
// neither Bilibili cookies nor the DeepSeek key enter these methods.
export class SharedClient {
  constructor(fetcher = fetch, hasPermission = async () => false) {
    this.fetcher = fetcher.bind(globalThis);
    this.hasPermission = hasPermission;
    this.submissionTail = Promise.resolve();
    this.nextSubmissionAt = 0;
  }
  submit(task) {
    const pending = this.submissionTail
      .catch(() => {})
      .then(async () => {
        const delay = this.nextSubmissionAt - Date.now();
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        try {
          return await task();
        } finally {
          // Space from the response, so variable network latency cannot compress server arrivals.
          this.nextSubmissionAt = Date.now() + 1000;
        }
      });
    this.submissionTail = pending.catch(() => {});
    return pending;
  }
  async request(settings, path, options = {}) {
    const origin = sharedOrigin(settings.sharedBaseUrl);
    assert(origin, "SHARED_CONFIG", "请配置共享服务域名。");
    assert(
      await this.hasPermission(`${origin}/*`),
      "SHARED_PERMISSION",
      "请在设置页为共享域名授权。",
    );
    const headers = { Accept: "application/json", ...options.headers };
    if (settings.sharedToken) {
      headers.Authorization = `Bearer ${settings.sharedToken}`;
    }
    try {
      const response = await this.fetcher(`${origin}${path}`, {
        ...options,
        headers,
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 404) {
        return null;
      }
      assert(response.ok, "SHARED_HTTP", `共享服务返回 HTTP ${response.status}。`);
      return JSON.parse(new TextDecoder().decode(await boundedBody(response, 256 * 1024)));
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("SHARED_NETWORK", "共享服务暂时不可用，本地数据仍可使用。");
    }
  }
  async lookup(context, settings) {
    if (!settings.sharedRead) {
      return null;
    }
    const query = new URLSearchParams({
      bvid: context.video.bvid,
      page: context.video.page,
      cid: context.video.cid,
      transcript_sha256: context.transcript_sha256,
      model: MODEL,
      prompt_version: PROMPT_VERSION,
    });
    const payload = await this.request(settings, `/v1/segments?${query}`);
    if (!payload) {
      return null;
    }
    assert(
      payload.schema_version === 1 &&
        payload.status === "published" &&
        payload.model === MODEL &&
        payload.prompt_version === PROMPT_VERSION,
      "SHARED_SCHEMA",
      "共享数据版本或发布状态不匹配。",
    );
    validateLabels(context, payload.labels);
    return payload.labels;
  }
  async candidate(record) {
    const labelSegment = ({ start_id, end_id, brand, confidence, reason, evidence_ids }) => ({
      start_id,
      end_id,
      brand,
      confidence,
      reason,
      evidence_ids: [...evidence_ids],
    });
    const { bvid, page, cid, duration, title, part } = record.video;
    const payload = {
      schema_version: 1,
      video: { bvid, page, cid, duration, title, part },
      transcript_sha256: record.transcript_sha256,
      model: record.model,
      prompt_version: record.promptVersion,
      labels: {
        video_key: record.labels.video_key,
        transcript_sha256: record.labels.transcript_sha256,
        summary: record.labels.summary,
        segments: record.labels.segments.map(labelSegment),
      },
      segments: record.segments.map(
        ({ start_id, end_id, start, end, brand, confidence, reason, evidence_ids, evidence }) => ({
          start_id,
          end_id,
          start,
          end,
          brand,
          confidence,
          reason,
          evidence_ids,
          evidence: evidence
            .slice(0, 10)
            .map(({ id, from, to, content }) => ({ id, from, to, content: content.slice(0, 500) })),
        }),
      ),
    };
    return {
      id: await hash(canonical(payload)),
      payload,
      status: "pending",
      createdAt: Date.now(),
      recordKey: record.key,
    };
  }
  async upload(candidate, settings) {
    assert(settings.sharedUpload, "SHARED_DISABLED", "共享上传当前处于关闭状态。");
    const result = await this.submit(() =>
      this.request(settings, "/v1/candidates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": candidate.id,
        },
        body: JSON.stringify(candidate.payload),
      }),
    );
    assert(
      result?.schema_version === 1 &&
        ["pending", "accepted"].includes(result.status) &&
        typeof result.submission_id === "string",
      "SHARED_SCHEMA",
      "共享服务的上传回执格式异常。",
    );
    return result;
  }
  async transcript(context) {
    assert(
      context.source === `local-asr:${ASR_VERSION}`,
      "ASR_UPLOAD",
      "仅上传当前本地ASR生成的字幕。",
    );
    const { bvid, page, cid, duration, title, part } = context.video;
    const payload = {
      schema_version: 1,
      video: { bvid, page, cid, duration, title, part },
      asr_version: ASR_VERSION,
      client_version: BUILD_VERSION,
      transcript_sha256: context.transcript_sha256,
      cues: context.cues.map(({ id, from, to, content }) => ({ id, from, to, content })),
    };
    assert(
      (await hash({ video: payload.video, cues: payload.cues })) === payload.transcript_sha256,
      "ASR_UPLOAD",
      "转写字幕指纹异常。",
    );
    assert(
      new TextEncoder().encode(JSON.stringify(payload)).length <= 512 * 1024,
      "ASR_UPLOAD",
      "转写字幕超过提交上限。",
    );
    return {
      id: await hash(payload),
      payload,
      kind: "transcript",
      status: "pending",
      createdAt: Date.now(),
    };
  }
  async uploadTranscript(candidate, settings, stillEnabled = async () => true) {
    assert(settings.asrUpload, "SHARED_DISABLED", "转写字幕上传开关已关闭。");
    const body = JSON.stringify(candidate.payload);
    for (const secret of [settings.apiKey, settings.sharedToken]) {
      assert(
        !secret || !body.includes(secret),
        "ASR_UPLOAD",
        "字幕包含当前凭据特征，已保留在本地。",
      );
    }
    return this.submit(async () => {
      if (!(await stillEnabled())) {
        return null;
      }
      const result = await this.request(settings, "/v1/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": candidate.id },
        body,
      });
      assert(
        result?.schema_version === 1 &&
          result.status === "accepted" &&
          typeof result.submission_id === "string",
        "SHARED_SCHEMA",
        "转写字幕上传回执异常。",
      );
      return result;
    });
  }
}
