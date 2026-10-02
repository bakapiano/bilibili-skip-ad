import { createHash } from "node:crypto";

const OPTIONAL_EVIDENCE_PROMPT_VERSIONS = new Set([
  "ad-cues-v3-pipe",
  "ad-cues-v4-topic",
  "ad-cues-v5-obvious",
  "ad-cues-v6-json",
]);
const ACCEPTED_PROMPT_VERSIONS = new Set([
  "ad-cues-v1",
  "ad-cues-v2-compact",
  ...OPTIONAL_EVIDENCE_PROMPT_VERSIONS,
]);

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireValue(condition, message) {
  if (!condition) {
    throw new HttpError(400, "INVALID_INPUT", message);
  }
}

function exactKeys(value, keys) {
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join("|") === [...keys].sort().join("|"),
    "请求字段与共享协议不一致。",
  );
}

function text(value, limit, allowEmpty = false) {
  return typeof value === "string" && value.length <= limit && (allowEmpty || value.trim());
}

function positiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
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

export function payloadHash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function validateIdentity(value) {
  requireValue(
    typeof value.bvid === "string" && /^BV[0-9A-Za-z]{10}$/.test(value.bvid),
    "BV 号格式异常。",
  );
  requireValue(
    positiveInteger(value.page, 1000) && positiveInteger(value.cid),
    "分 P 或 CID 异常。",
  );
  requireValue(
    typeof value.transcript_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.transcript_sha256),
    "字幕指纹格式异常。",
  );
  requireValue(
    value.model === "deepseek-flash" && ACCEPTED_PROMPT_VERSIONS.has(value.prompt_version),
    "模型或提示词版本异常。",
  );
}

export function cacheIdentity(value) {
  return `${value.bvid}:p${value.page}:${value.cid}:${value.transcript_sha256}:${value.model}:${value.prompt_version}`;
}

export function validateQuery(searchParams) {
  const keys = ["bvid", "page", "cid", "transcript_sha256", "model", "prompt_version"];
  requireValue(
    searchParams.size === keys.length && keys.every((key) => searchParams.getAll(key).length === 1),
    "查询参数异常。",
  );
  const query = Object.fromEntries(searchParams);
  requireValue(/^[1-9]\d*$/.test(query.page) && /^[1-9]\d*$/.test(query.cid), "视频编号格式异常。");
  query.page = Number(query.page);
  query.cid = Number(query.cid);
  validateIdentity(query);
  return cacheIdentity(query);
}

export function validateCandidate(payload, idempotencyKey) {
  exactKeys(payload, [
    "schema_version",
    "video",
    "transcript_sha256",
    "model",
    "prompt_version",
    "labels",
    "segments",
  ]);
  requireValue(payload.schema_version === 1, "协议版本异常。");
  exactKeys(payload.video, ["bvid", "page", "cid", "duration", "title", "part"]);
  const { video, labels, segments } = payload;
  const identity = {
    ...video,
    transcript_sha256: payload.transcript_sha256,
    model: payload.model,
    prompt_version: payload.prompt_version,
  };
  validateIdentity(identity);
  requireValue(
    Number.isFinite(video.duration) && video.duration > 0 && video.duration <= 86400,
    "视频时长异常。",
  );
  requireValue(text(video.title, 500, true) && text(video.part, 500, true), "标题格式异常。");
  exactKeys(labels, ["video_key", "transcript_sha256", "summary", "segments"]);
  requireValue(
    labels.video_key === `${video.bvid}:p${video.page}:${video.cid}` &&
      labels.transcript_sha256 === payload.transcript_sha256,
    "视频或字幕绑定不一致。",
  );
  requireValue(text(labels.summary, 4000, true), "识别总结异常。");
  requireValue(
    Array.isArray(labels.segments) &&
      labels.segments.length <= 50 &&
      Array.isArray(segments) &&
      segments.length === labels.segments.length,
    "广告区间数量异常。",
  );
  const labelKeys = ["start_id", "end_id", "brand", "confidence", "reason", "evidence_ids"];
  let previousId = 0;
  let previousEnd = 0;
  for (const [index, label] of labels.segments.entries()) {
    exactKeys(label, labelKeys);
    const segment = segments[index];
    exactKeys(segment, [...labelKeys, "start", "end", "evidence"]);
    requireValue(
      positiveInteger(label.start_id, 10000) &&
        positiveInteger(label.end_id, 10000) &&
        label.start_id > previousId &&
        label.start_id <= label.end_id,
      "广告字幕编号异常或重叠。",
    );
    requireValue(text(label.brand, 200) && text(label.reason, 2000), "品牌或理由异常。");
    requireValue(
      Number.isFinite(label.confidence) && label.confidence >= 0 && label.confidence <= 1,
      "广告评分异常。",
    );
    requireValue(
      Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.start >= previousEnd &&
        segment.start < segment.end &&
        segment.end <= video.duration,
      "广告时间异常或重叠。",
    );
    requireValue(
      Array.isArray(label.evidence_ids) &&
        (OPTIONAL_EVIDENCE_PROMPT_VERSIONS.has(payload.prompt_version) ||
          label.evidence_ids.length > 0) &&
        label.evidence_ids.length <= 50 &&
        label.evidence_ids.every(
          (id) => positiveInteger(id) && id >= label.start_id && id <= label.end_id,
        ),
      "证据编号异常。",
    );
    requireValue(
      labelKeys
        .filter((key) => key !== "evidence_ids")
        .every((key) => label[key] === segment[key]) &&
        Array.isArray(segment.evidence_ids) &&
        segment.evidence_ids.length === label.evidence_ids.length &&
        segment.evidence_ids.every((id, evidenceIndex) => id === label.evidence_ids[evidenceIndex]),
      "区间与原始标记不一致。",
    );
    const expectedEvidence = [...new Set(label.evidence_ids)].slice(0, 10);
    requireValue(
      Array.isArray(segment.evidence) && segment.evidence.length === expectedEvidence.length,
      "证据数量异常。",
    );
    for (const [evidenceIndex, evidence] of segment.evidence.entries()) {
      exactKeys(evidence, ["id", "from", "to", "content"]);
      requireValue(evidence.id === expectedEvidence[evidenceIndex], "证据与编号不一致。");
      requireValue(
        Number.isFinite(evidence.from) &&
          Number.isFinite(evidence.to) &&
          evidence.from >= segment.start &&
          evidence.from < evidence.to &&
          evidence.to <= segment.end,
        "证据时间越界。",
      );
      requireValue(text(evidence.content, 500), "证据文本异常。");
    }
    previousId = label.end_id;
    previousEnd = segment.end;
  }
  requireValue(
    typeof idempotencyKey === "string" &&
      /^[a-f0-9]{64}$/.test(idempotencyKey) &&
      payloadHash(payload) === idempotencyKey,
    "Idempotency-Key 应为请求体的 canonical JSON SHA-256。",
  );
  return cacheIdentity(identity);
}

export function validateTranscript(payload, idempotencyKey) {
  exactKeys(payload, [
    "schema_version",
    "video",
    "asr_version",
    "client_version",
    "transcript_sha256",
    "cues",
  ]);
  requireValue(payload.schema_version === 1, "协议版本异常。");
  exactKeys(payload.video, ["bvid", "page", "cid", "duration", "title", "part"]);
  const { video, cues } = payload;
  requireValue(
    /^BV[0-9A-Za-z]{10}$/.test(video.bvid) &&
      positiveInteger(video.page, 1000) &&
      positiveInteger(video.cid),
    "视频身份异常。",
  );
  requireValue(
    Number.isFinite(video.duration) && video.duration > 0 && video.duration <= 3600,
    "转写视频时长应在60分钟以内。",
  );
  requireValue(text(video.title, 500, true) && text(video.part, 500, true), "标题格式异常。");
  requireValue(
    payload.asr_version === "sensevoice-int8-1.12.20-vad-04-12-cues-v2",
    "转写模型版本异常。",
  );
  requireValue(
    typeof payload.client_version === "string" &&
      /^\d{1,3}(?:\.\d{1,3}){2,3}$/.test(payload.client_version),
    "客户端版本异常。",
  );
  requireValue(
    Array.isArray(cues) &&
      cues.length > 0 &&
      cues.length <= 10000 &&
      JSON.stringify(cues).length <= 120000,
    "转写字幕数量或长度异常。",
  );
  let previous = -1;
  for (const [index, cue] of cues.entries()) {
    exactKeys(cue, ["id", "from", "to", "content"]);
    requireValue(cue.id === index + 1, "转写字幕编号应连续递增。");
    requireValue(
      Number.isFinite(cue.from) &&
        Number.isFinite(cue.to) &&
        cue.from >= 0 &&
        cue.from >= previous &&
        cue.from < cue.to &&
        cue.to <= video.duration &&
        Math.round(cue.from * 1000) / 1000 === cue.from &&
        Math.round(cue.to * 1000) / 1000 === cue.to,
      "转写字幕时间轴异常。",
    );
    requireValue(
      text(cue.content, 10000) && cue.content === cue.content.trim(),
      "转写字幕文本异常。",
    );
    previous = cue.from;
  }
  requireValue(
    typeof payload.transcript_sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(payload.transcript_sha256) &&
      payloadHash({ video, cues }) === payload.transcript_sha256,
    "转写字幕指纹不匹配。",
  );
  requireValue(
    typeof idempotencyKey === "string" &&
      /^[a-f0-9]{64}$/.test(idempotencyKey) &&
      payloadHash(payload) === idempotencyKey,
    "Idempotency-Key 应为请求体的 canonical JSON SHA-256。",
  );
  return `${video.bvid}:p${video.page}:${video.cid}:${payload.asr_version}:${payload.transcript_sha256}`;
}
