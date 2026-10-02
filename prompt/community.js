import { boundedBody } from "../extension/lib/bilibili.js";

export const COMMUNITY_ORIGIN = "https://bsbsb.top";
export const COMMUNITY_CATEGORIES = [
  "sponsor",
  "selfpromo",
  "exclusive_access",
  "interaction",
  "poi_highlight",
  "intro",
  "outro",
  "preview",
  "padding",
  "filler",
  "music_offtopic",
];
export function communityUrl(video) {
  if (
    !/^BV[A-Za-z0-9]{10}$/.test(video.bvid) ||
    !Number.isSafeInteger(video.cid) ||
    video.cid <= 0
  ) {
    throw new Error("视频身份异常。");
  }
  return `${COMMUNITY_ORIGIN}/api/skipSegments?${new URLSearchParams({ videoID: video.bvid, cid: String(video.cid), categories: JSON.stringify(COMMUNITY_CATEGORIES) })}`;
}
export function parseCommunity(raw, video) {
  if (!Array.isArray(raw) || raw.length > 500) {
    throw new Error("社区响应形状异常。");
  }
  return raw.map((row) => {
    if (
      !row ||
      !Array.isArray(row.segment) ||
      row.segment.length !== 2 ||
      !row.segment.every(Number.isFinite) ||
      row.segment[0] < 0 ||
      row.segment[1] < row.segment[0] ||
      typeof row.UUID !== "string" ||
      !COMMUNITY_CATEGORIES.includes(row.category) ||
      !Number.isFinite(row.videoDuration) ||
      row.videoDuration < 0 ||
      !Number.isFinite(row.votes) ||
      !Number.isInteger(row.locked) ||
      !["skip", "mute", "full", "poi", "chapter"].includes(row.actionType)
    ) {
      throw new Error("社区区间字段异常。");
    }
    const sameCid = String(row.cid) === String(video.cid);
    const durationKnown = row.videoDuration > 0;
    const durationMatches = durationKnown && Math.abs(row.videoDuration - video.duration) <= 2;
    const inBounds = row.segment[1] <= video.duration && row.segment[1] > row.segment[0];
    return {
      UUID: row.UUID,
      cid: String(row.cid),
      segment: [...row.segment],
      category: row.category,
      actionType: row.actionType,
      votes: row.votes,
      locked: row.locked,
      videoDuration: row.videoDuration,
      description: typeof row.description === "string" ? row.description.slice(0, 2000) : "",
      sameCid,
      durationKnown,
      durationMatches,
      comparable: sameCid && durationMatches && inBounds,
    };
  });
}
export async function fetchCommunity(video, fetcher = fetch) {
  const url = communityUrl(video);
  const start = Date.now();
  try {
    const response = await fetcher.call(globalThis, url, {
      method: "GET",
      headers: { Origin: "http://127.0.0.1:43820", "x-ext-version": "biliskip-prompt-lab/0.1" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
    const base = {
      fetchedAt: new Date().toISOString(),
      url,
      httpStatus: response.status,
      elapsedMs: Date.now() - start,
      source: "BilibiliSponsorBlock community labels; unreviewed reference",
    };
    if (response.status === 404) {
      return { ...base, status: "missing", segments: [] };
    }
    if (!response.ok) {
      return { ...base, status: "error", segments: [], error: `HTTP ${response.status}` };
    }
    const raw = JSON.parse(new TextDecoder().decode(await boundedBody(response, 1024 * 1024)));
    return { ...base, status: "ok", segments: parseCommunity(raw, video) };
  } catch {
    return {
      status: "error",
      fetchedAt: new Date().toISOString(),
      url,
      segments: [],
      error: "社区接口请求或响应校验失败。",
    };
  }
}
