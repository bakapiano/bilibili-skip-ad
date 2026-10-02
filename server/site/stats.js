async function loadStatistics() {
  const videos = document.getElementById("stats-videos");
  const saved = document.getElementById("stats-saved");
  const status = document.getElementById("stats-status");
  try {
    const response = await fetch("/v1/stats", {
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      throw new Error("Statistics unavailable");
    }
    const data = await response.json();
    if (
      data.schema_version !== 1 ||
      data.basis !== "latest-active-per-video-part-ad-duration" ||
      !Number.isSafeInteger(data.cached_videos) ||
      data.cached_videos < 0 ||
      !Number.isFinite(data.saved_seconds) ||
      data.saved_seconds < 0 ||
      data.saved_seconds > Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("Invalid statistics");
    }
    videos.textContent = `${data.cached_videos.toLocaleString("zh-CN")} 个`;
    const total = Math.floor(data.saved_seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const parts = [];
    if (hours) {
      parts.push(`${hours.toLocaleString("zh-CN")} 小时`);
    }
    if (minutes) {
      parts.push(`${minutes} 分`);
    }
    if (seconds || parts.length === 0) {
      parts.push(`${seconds} 秒`);
    }
    saved.textContent = parts.join(" ");
    status.textContent = "按缓存广告总时长统计；每个视频分 P 取最新有效记录，各计一次。";
  } catch {
    videos.textContent = "—";
    saved.textContent = "—";
    status.textContent = "统计暂时不可用，稍后刷新即可重试。";
  }
}

loadStatistics();
