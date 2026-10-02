export const BADGE_METRICS = Object.freeze(["videos", "segments", "saved-time"]);

function durationLabel(seconds) {
  if (seconds >= 3600) {
    return `${(seconds / 3600).toFixed(1)} 小时`;
  }
  if (seconds >= 60) {
    return `${(seconds / 60).toFixed(1)} 分钟`;
  }
  return `${Math.floor(seconds)} 秒`;
}

// Shields endpoint data: fixed metric names, aggregate values and project-owned text only.
export function statsBadge(metric, stats) {
  const definitions = {
    videos: ["缓存视频", `${stats.cached_videos.toLocaleString("en-US")} 个`],
    segments: ["广告片段", `${stats.ad_segments.toLocaleString("en-US")} 段`],
    "saved-time": ["节省时间", durationLabel(stats.saved_seconds)],
  };
  if (!BADGE_METRICS.includes(metric)) {
    throw new Error("Unknown badge metric");
  }
  const [label, message] = definitions[metric];
  return { schemaVersion: 1, label, message, color: "3b82f6", cacheSeconds: 300 };
}
