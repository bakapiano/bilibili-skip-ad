import { assert, validateLabels } from "./core.js";

const MAX_OUTPUT_CHARACTERS = 64000;
const ESCAPES = Object.freeze({ "\\": "\\", "|": "|", n: "\n", r: "\r" });

function fields(line) {
  const result = [""];
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      assert(Object.hasOwn(ESCAPES, character), "OUTPUT", "模型输出包含异常转义。");
      result[result.length - 1] += ESCAPES[character];
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      result.push("");
    } else {
      result[result.length - 1] += character;
    }
  }
  assert(!escaped && result.length === 5, "OUTPUT", "模型每行应包含五个完整字段。");
  return result.map((value) => value.trim());
}

export function parseModelOutput(context, text, options = {}) {
  assert(
    typeof text === "string" && text.trim() && text.length <= MAX_OUTPUT_CHARACTERS,
    "OUTPUT",
    "模型返回的文本为空或超过上限。",
  );
  const normalized = text.trim().replaceAll("\r\n", "\n");
  assert(
    !/[\r\u2028\u2029]/u.test(normalized) && !normalized.includes(String.fromCharCode(0)),
    "OUTPUT",
    "模型输出换行格式异常。",
  );
  const lines = normalized === "NONE" ? [] : normalized.split("\n");
  assert(lines.length <= 50, "OUTPUT", "广告区间数量超过上限。");
  const firstId = options.startId ?? 1;
  const lastId = options.endId ?? context.cues.length;
  assert(
    Number.isSafeInteger(firstId) &&
      Number.isSafeInteger(lastId) &&
      firstId >= 1 &&
      firstId <= lastId &&
      lastId <= context.cues.length,
    "OUTPUT",
    "当前任务字幕窗口异常。",
  );
  const segments = lines.map((line) => {
    const [first, last, brand, reason, confidence] = fields(line);
    assert(
      /^[1-9]\d{0,4}$/.test(first) && /^[1-9]\d{0,4}$/.test(last),
      "OUTPUT",
      "广告字幕编号格式异常。",
    );
    const startId = Number(first);
    const endId = Number(last);
    assert(startId >= firstId && endId <= lastId, "OUTPUT", "模型引用了本窗口以外的字幕编号。");
    assert(
      /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(confidence),
      "OUTPUT",
      "广告评分须在0到1之间。",
    );
    assert(
      brand.length > 0 && brand.length <= 200 && reason.length > 0 && reason.length <= 120,
      "OUTPUT",
      "品牌或简短说明长度异常。",
    );
    return {
      start_id: startId,
      end_id: endId,
      brand,
      confidence: Number(confidence),
      reason,
      // The wire format supplies no evidence selection; keep it explicitly empty.
      evidence_ids: [],
    };
  });
  const labels = {
    // Bind exclusively to the request's local snapshot, never to the current tab.
    video_key: context.video_key,
    transcript_sha256: context.transcript_sha256,
    summary: `识别到 ${segments.length} 段广告（程序汇总）。`,
    segments,
  };
  return { labels, ...validateLabels(context, labels) };
}

export function parseAdBlocksOutput(context, text, options = {}) {
  assert(
    typeof text === "string" && text.trim() && text.length <= MAX_OUTPUT_CHARACTERS,
    "OUTPUT",
    "模型返回的JSON为空或超过上限。",
  );
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    assert(false, "OUTPUT", "模型返回的JSON格式异常。");
  }
  assert(
    data &&
      !Array.isArray(data) &&
      typeof data.topic === "string" &&
      data.topic.length <= 4000 &&
      Array.isArray(data.blocks) &&
      data.blocks.length <= Math.min(50, context.cues.length),
    "OUTPUT",
    "模型主题或广告分段格式异常。",
  );
  let next = options.startId ?? 1;
  const last = options.endId ?? context.cues.length;
  const escape = (value) =>
    value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", "\\n");
  const lines = data.blocks.map((block) => {
    assert(block && block.type === "ad", "OUTPUT", "广告结果只应包含ad分段。");
    assert(
      Number.isSafeInteger(block.start) &&
        Number.isSafeInteger(block.end) &&
        block.start >= next &&
        block.end >= block.start &&
        block.end <= last,
      "OUTPUT",
      "广告编号应有序、互不重叠且位于字幕范围内。",
    );
    assert(
      typeof block.subject === "string" &&
        typeof block.reason === "string" &&
        typeof block.confidence === "number",
      "OUTPUT",
      "广告品牌、理由或评分格式异常。",
    );
    next = block.end + 1;
    return `${block.start}|${block.end}|${escape(block.subject)}|${escape(block.reason)}|${block.confidence}`;
  });
  // Reuse the established identity, confidence and timestamp checks; preserve each block boundary.
  return { ...parseModelOutput(context, lines.join("\n") || "NONE", options), explanation: data };
}
