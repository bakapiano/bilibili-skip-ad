import {
  DEFAULT_SETTINGS,
  DEFAULT_SHARED_URL,
  SETTINGS_VERSION,
  MODEL,
  PROMPT_VERSION,
  PRICING,
} from "./constants.js";
import { modelSource } from "./asr-config.js";
import { validatePetSettings } from "./pet-config.js";
import { selectUsagePrice } from "./pricing.js";

export class AppError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}
export function assert(condition, code, message) {
  if (!condition) {
    throw new AppError(code, message);
  }
}
export const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
export const isId = (value) => Number.isSafeInteger(value) && value > 0;
export function identity(input) {
  assert(input && /^BV[0-9A-Za-z]{10}$/.test(input.bvid), "VIDEO", "视频 BV 号异常。");
  const page = input.page ?? 1;
  assert(isId(page) && page <= 1000, "VIDEO", "分 P 参数异常。");
  return { bvid: input.bvid, page };
}
export function fromUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/);
    if (url.protocol !== "https:" || url.hostname !== "www.bilibili.com" || !match) {
      return null;
    }
    return identity({ bvid: match[1], page: Number(url.searchParams.get("p") || 1) });
  } catch {
    return null;
  }
}
export function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export async function hash(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(typeof value === "string" ? value : canonical(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function normalize(videoInput, body, source = "bilibili:ai-zh") {
  const id = identity(videoInput);
  assert(
    isId(videoInput.cid) && isNumber(videoInput.duration) && videoInput.duration > 0,
    "VIDEO",
    "视频身份或时长异常。",
  );
  const video = {
    ...id,
    cid: videoInput.cid,
    duration: videoInput.duration,
    title: String(videoInput.title || "").slice(0, 500),
    part: String(videoInput.part || "").slice(0, 500),
  };
  assert(
    Array.isArray(body) && body.length > 0 && body.length <= 10000,
    "SUBTITLE",
    "需要有效的带时间戳字幕。",
  );
  let previous = -1;
  const cues = body.map((cue, index) => {
    assert(cue && isNumber(cue.from) && isNumber(cue.to), "SUBTITLE", "字幕时间格式异常。");
    const start = Math.round(cue.from * 1000) / 1000;
    const end = Math.round(Math.min(cue.to, video.duration) * 1000) / 1000;
    assert(
      start >= 0 && start < end && start >= previous && cue.to <= video.duration + 1,
      "SUBTITLE",
      "字幕时间轴异常。",
    );
    assert(
      typeof cue.content === "string" && cue.content.trim() && cue.content.length <= 10000,
      "SUBTITLE",
      "字幕文本异常。",
    );
    previous = start;
    return { id: index + 1, from: start, to: end, content: cue.content.trim() };
  });
  assert(
    JSON.stringify(cues).length <= 120000,
    "TOO_LONG",
    "本版单次字幕上限为 12 万字符，请选择较短视频。",
  );
  return {
    version: 1,
    video,
    cues,
    source,
    video_key: `${video.bvid}:p${video.page}:${video.cid}`,
    transcript_sha256: await hash({ video, cues }),
  };
}
export function cacheKey(context) {
  return `${context.video_key}:${context.transcript_sha256}:${MODEL}:${PROMPT_VERSION}`;
}
function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...expected].sort().join("|")
  );
}
export function validateLabels(context, labels) {
  assert(
    exactKeys(labels, ["video_key", "transcript_sha256", "summary", "segments"]),
    "OUTPUT",
    "模型返回字段与约定不一致。",
  );
  assert(
    labels.video_key === context.video_key &&
      labels.transcript_sha256 === context.transcript_sha256,
    "BINDING",
    "标记与本次视频字幕不匹配。",
  );
  assert(
    typeof labels.summary === "string" &&
      labels.summary.length <= 4000 &&
      Array.isArray(labels.segments) &&
      labels.segments.length <= 50,
    "OUTPUT",
    "广告结果格式异常。",
  );
  let previous = 0;
  const segments = labels.segments.map((segment) => {
    assert(
      exactKeys(segment, ["start_id", "end_id", "brand", "confidence", "reason", "evidence_ids"]),
      "OUTPUT",
      "广告段字段异常。",
    );
    const { start_id: first, end_id: last, confidence, evidence_ids: evidence } = segment;
    assert(
      isId(first) && isId(last) && first <= last && last <= context.cues.length,
      "OUTPUT",
      "广告字幕编号越界。",
    );
    assert(isNumber(confidence) && confidence >= 0 && confidence <= 1, "OUTPUT", "广告评分异常。");
    assert(
      typeof segment.brand === "string" &&
        segment.brand.trim() &&
        segment.brand.length <= 200 &&
        typeof segment.reason === "string" &&
        segment.reason.trim() &&
        segment.reason.length <= 2000,
      "OUTPUT",
      "广告品牌或理由异常。",
    );
    assert(
      Array.isArray(evidence) &&
        evidence.length <= 50 &&
        evidence.every((i) => isId(i) && i >= first && i <= last),
      "OUTPUT",
      "广告证据须来自对应字幕区间。",
    );
    const start = context.cues[first - 1].from;
    const end = Math.max(...context.cues.slice(first - 1, last).map((cue) => cue.to));
    assert(
      start >= previous && start < end && end <= context.video.duration,
      "OUTPUT",
      "广告时间段发生重叠或越界。",
    );
    previous = end;
    return {
      ...segment,
      start,
      end,
      evidence_ids: [...new Set(evidence)],
      evidence: [...new Set(evidence)].slice(0, 10).map((i) => context.cues[i - 1]),
    };
  });
  return { summary: labels.summary, segments };
}
export function parseOutput(text) {
  assert(typeof text === "string" && text.trim(), "OUTPUT", "模型返回了空结果，请手动重试。");
  try {
    return JSON.parse(text.trim());
  } catch {
    throw new AppError("OUTPUT", "模型返回的 JSON 格式异常，本次用量已记录。");
  }
}
export function sharedOrigin(value) {
  if (!value) {
    return "";
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("SETTINGS", "共享服务地址应为 HTTPS 公开域名。");
  }
  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ["", "/"].includes(url.pathname) &&
      !url.port &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) &&
      !/^(?:\d+\.)+\d+$/.test(url.hostname) &&
      !/\.(local|localhost|internal)$/i.test(url.hostname),
    "SETTINGS",
    "请填写 HTTPS 公开域名根地址，例如 https://cache.example.com。",
  );
  return url.origin;
}
export function migrateSharedSettings(input = {}, version = 0) {
  if (version >= SETTINGS_VERSION || input.sharedBaseUrl) {
    return validateSettings(input);
  }
  return validateSettings({
    ...input,
    sharedBaseUrl: DEFAULT_SHARED_URL,
    sharedRead: true,
    sharedUpload: true,
  });
}

export function validateSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...input };
  const settings = Object.fromEntries(
    Object.keys(DEFAULT_SETTINGS).map((key) => [key, merged[key]]),
  );
  for (const key of [
    "consent",
    "autoAnalyze",
    "autoSkip",
    "sharedRead",
    "sharedUpload",
    "autoUpload",
    "asrEnabled",
    "asrUpload",
    "shortVideoExempt",
  ]) {
    assert(typeof settings[key] === "boolean", "SETTINGS", "设置项类型异常。");
  }
  assert(
    isNumber(settings.confidenceThreshold) &&
      settings.confidenceThreshold >= 0.75 &&
      settings.confidenceThreshold <= 1,
    "SETTINGS",
    "自动跳过阈值应介于 0.75 和 1 之间。",
  );
  settings.sharedBaseUrl = sharedOrigin(settings.sharedBaseUrl);
  assert(modelSource(settings.asrModelSource), "SETTINGS", "请选择内置的模型下载源。");
  assert(
    [1, 2, 4, 6, 8].includes(settings.asrConcurrency),
    "SETTINGS",
    "本地转写并发可选1、2、4、6、8。",
  );
  assert(
    Number.isFinite(settings.shortVideoMinutes) &&
      settings.shortVideoMinutes >= 0 &&
      settings.shortVideoMinutes <= 180,
    "SETTINGS",
    "豁免时长应为0至180分钟，可填写小数。",
  );
  assert(!settings.autoAnalyze || settings.consent, "SETTINGS", "自动分析需要先确认字幕发送授权。");
  assert(
    !(settings.sharedRead || settings.sharedUpload || settings.asrUpload) || settings.sharedBaseUrl,
    "SETTINGS",
    "共享功能需要配置公开服务域名。",
  );
  return {
    ...settings,
    ...validatePetSettings(input, (condition, message) => assert(condition, "SETTINGS", message)),
  };
}
export function usageCost(raw, timestamp = Date.now()) {
  assert(
    raw &&
      Number.isSafeInteger(raw.prompt_tokens) &&
      raw.prompt_tokens >= 0 &&
      Number.isSafeInteger(raw.completion_tokens) &&
      raw.completion_tokens >= 0,
    "USAGE",
    "API 用量格式异常。",
  );
  const hit = raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = raw.prompt_cache_miss_tokens ?? raw.prompt_tokens - hit;
  assert(
    Number.isSafeInteger(hit) &&
      hit >= 0 &&
      Number.isSafeInteger(miss) &&
      miss >= 0 &&
      hit + miss === raw.prompt_tokens,
    "USAGE",
    "API 缓存用量与总数不一致。",
  );
  const output = raw.completion_tokens;
  const calculate = (rates) =>
    Number(((hit * rates.hit + miss * rates.miss + output * rates.output) / 1e6).toFixed(8));
  return selectUsagePrice(
    {
      promptTokens: raw.prompt_tokens,
      outputTokens: output,
      cacheHit: hit,
      cacheMiss: miss,
      offPeakCny: calculate(PRICING.offPeak),
      peakCny: calculate(PRICING.peak),
      asOf: PRICING.asOf,
      cacheBasis:
        raw.prompt_cache_hit_tokens !== undefined ||
        raw.prompt_tokens_details?.cached_tokens !== undefined
          ? "measured"
          : "all-miss-estimate",
    },
    timestamp,
  );
}
export function publicRecord(record, source = record.source) {
  return {
    key: record.key,
    video: record.video,
    video_key: record.video_key,
    transcript_sha256: record.transcript_sha256,
    source,
    summary: record.summary,
    segments: record.segments,
    model: record.model,
    promptVersion: record.promptVersion,
    createdAt: record.createdAt,
    cueCount: record.cueCount,
    usage:
      record.usage && Object.hasOwn(record.usage, "costCny")
        ? record.usage
        : selectUsagePrice(record.usage, record.createdAt, "record-created"),
    elapsedMs: record.elapsedMs,
  };
}
export function safeError(error) {
  return {
    code: error instanceof AppError ? error.code : "INTERNAL",
    message: error instanceof AppError ? error.message : "操作暂未完成，请重试或查看扩展错误日志。",
  };
}
