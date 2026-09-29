import { MODEL, PROMPT_VERSION, LABEL_SCHEMA, INSTRUCTIONS, MAX_BYTES } from "./constants.js";
import {
  AppError,
  assert,
  canonical,
  hash,
  sharedOrigin,
  usageCost,
  parseOutput,
  validateLabels,
} from "./core.js";
import { boundedBody } from "./bilibili.js";

export function deepseekRequest(context) {
  const payload = Object.fromEntries(
    ["video_key", "transcript_sha256", "video", "cues"].map((key) => [key, context[key]]),
  );
  return {
    model: MODEL,
    messages: [
      { role: "system", content: `${INSTRUCTIONS}\nJSON Schema：${JSON.stringify(LABEL_SCHEMA)}` },
      { role: "user", content: JSON.stringify(payload) },
    ],
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 2048,
    stream: false,
  };
}
export class DeepSeekClient {
  constructor(fetcher = fetch) {
    this.fetcher = fetcher.bind(globalThis);
  }
  async analyze(context, key) {
    assert(
      typeof key === "string" && key.trim().length >= 12 && !/\s/.test(key),
      "KEY",
      "请先在设置中配置 DeepSeek API Key。",
    );
    const start = performance.now();
    let usage;
    try {
      const response = await this.fetcher("https://api.deepseek.com/chat/completions", {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(25000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(deepseekRequest(context)),
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
      const labels = parseOutput(choice.message?.content);
      const result = validateLabels(context, labels);
      return {
        labels,
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
    const result = await this.request(settings, "/v1/candidates", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": candidate.id,
      },
      body: JSON.stringify(candidate.payload),
    });
    assert(
      result?.schema_version === 1 &&
        ["pending", "accepted"].includes(result.status) &&
        typeof result.submission_id === "string",
      "SHARED_SCHEMA",
      "共享服务的上传回执格式异常。",
    );
    return result;
  }
}
