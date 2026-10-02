export function clock(value) {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")},${String(milliseconds % 1000).padStart(3, "0")}`;
}

export function srt(segments) {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${clock(segment.start)} --> ${clock(segment.end)}\n${segment.text}\n`,
    )
    .join("\n");
}

export function cleanText(value) {
  return value.replace(/<\|[^|]*\|>/g, "").trim();
}

export const SEGMENTATION_VERSION = "asr-cues-v2";

const WORDS = new Intl.Segmenter("zh", { granularity: "word" });
const SPEECH = /[\p{L}\p{N}]/u;
const STRONG_END = /[。！？!?；;.][”’」』）》】\])]*\s*$/u;
const SOFT_END = /[，：,:][”’」』）》】\])]*\s*$/u;
const MAX_CHARACTERS = 36;
const MAX_SECONDS = 6;

function cue(segment, start, end, text, reason, timing = "model-token") {
  return {
    start: Math.max(segment.start, start),
    end: Math.min(segment.end, end),
    text: text.trim(),
    timing,
    splitReason: reason,
  };
}

export function tokenCues(segment) {
  const fallback = () =>
    SPEECH.test(segment.text)
      ? [cue(segment, segment.start, segment.end, segment.text, "fallback", "vad-segment")]
      : [];
  if (
    !Number.isFinite(segment.start) ||
    !Number.isFinite(segment.end) ||
    segment.end <= segment.start
  ) {
    throw new Error("Invalid segment bounds");
  }
  if (
    !segment.tokens?.length ||
    segment.timestamps?.length !== segment.tokens.length ||
    segment.timestamps.some(
      (time, index) =>
        !Number.isFinite(time) ||
        time < 0 ||
        time >= segment.end - segment.start ||
        (index > 0 && time < segment.timestamps[index - 1]),
    )
  ) {
    return fallback();
  }
  // Preserve model token times. Co-timed tokens stay together so every cue has a real boundary.
  const groups = [];
  let text = "";
  for (let index = 0; index < segment.tokens.length; index++) {
    const token = segment.tokens[index].replace(/<\|[^|]*\|>/g, "").replaceAll("▁", " ");
    if (!token) {
      continue;
    }
    const time = segment.start + segment.timestamps[index];
    const previous = groups.at(-1);
    if (previous && time === previous.start) {
      previous.text += token;
      previous.endOffset += token.length;
    } else {
      groups.push({
        start: time,
        text: token,
        beginOffset: text.length,
        endOffset: text.length + token.length,
      });
    }
    text += token;
  }
  if (!groups.length || !SPEECH.test(text)) {
    return fallback();
  }

  // Word boundaries protect Chinese words and Latin subword tokens. Number/version spans
  // additionally protect separators such as the decimal point and thousands comma.
  const wordEnds = new Set(
    [...WORDS.segment(text)].map((word) => word.index + word.segment.length),
  );
  const protectedSpans = [
    ...text.matchAll(
      /[A-Za-z0-9]+(?:[._:/+-][A-Za-z0-9]+)*(?:[%％])?|\d+(?:[,，]\d{3})+(?:\.\d+)?/gu,
    ),
  ].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  // Collect numeric spans separately, including ones nested inside a preceding Latin match.
  for (const match of text.matchAll(/\d+(?:[,，]\d{3})+(?:\.\d+)?/gu)) {
    protectedSpans.push({ start: match.index, end: match.index + match[0].length });
  }
  const boundaries = [];
  for (let index = 0; index < groups.length; index++) {
    const current = groups[index];
    const next = groups[index + 1];
    const position = current.endOffset;
    if (!next) {
      boundaries.push({
        index: index + 1,
        position,
        end: segment.end,
        reason: "segment-end",
        natural: true,
      });
      continue;
    }
    // Keep trailing punctuation/closing quotes with the preceding speech instead of emitting it alone.
    if (
      !SPEECH.test(next.text) ||
      !wordEnds.has(position) ||
      protectedSpans.some((span) => position > span.start && position < span.end)
    ) {
      continue;
    }
    const prefix = text.slice(0, position);
    const strong = STRONG_END.test(prefix);
    const soft = SOFT_END.test(prefix);
    // An onset gap is only a conservative pause hint, not a measured forced alignment duration.
    const pause = next.start - current.start >= 0.65;
    boundaries.push({
      index: index + 1,
      position,
      end: next.start,
      reason: strong ? "sentence" : soft ? "clause" : pause ? "pause" : "length",
      natural: strong || soft || pause,
    });
  }

  const pieces = [];
  let first = 0;
  while (first < groups.length) {
    const start = groups[first].start;
    const begin = groups[first].beginOffset;
    const candidates = boundaries.filter((boundary) => boundary.index > first);
    const fits = (boundary) =>
      boundary.position - begin <= MAX_CHARACTERS && boundary.end - start <= MAX_SECONDS;
    const natural = candidates.find(
      (boundary) =>
        boundary.natural &&
        (boundary.reason === "sentence" ||
          boundary.reason === "segment-end" ||
          boundary.position - begin >= 4),
    );
    // Prefer the next linguistic boundary; long spans fall back to a complete-word boundary.
    let selected = natural && fits(natural) ? natural : candidates.filter(fits).at(-1);
    selected ||= candidates[0];
    const content = text.slice(begin, selected.position);
    if (SPEECH.test(content)) {
      pieces.push(cue(segment, start, selected.end, content, selected.reason));
    } else if (pieces.length) {
      pieces.at(-1).text += content;
      pieces.at(-1).end = selected.end;
    }
    first = selected.index;
  }
  return pieces.length ? pieces : fallback();
}
