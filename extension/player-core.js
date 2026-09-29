(() => {
  "use strict";
  const api = {
    parse(value) {
      try {
        const url = new URL(value), match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/);
        const page = Number(url.searchParams.get("p") || 1);
        return url.protocol === "https:" && url.hostname === "www.bilibili.com" && match && Number.isSafeInteger(page) && page > 0 && page <= 1000
          ? { bvid: match[1], page, route: `${match[1]}:p${page}` } : null;
      } catch { return null; }
    },
    stamp(value) { return `${String(Math.floor(value / 60)).padStart(2, "0")}:${(value % 60).toFixed(1).padStart(4, "0")}`; },
    matches(record, ref, duration) {
      return Boolean(record && ref && record.video?.bvid === ref.bvid && record.video.page === ref.page &&
        Number.isFinite(duration) && duration > 0 && Math.abs(record.video.duration - duration) <= 2);
    },
    at(segments, time, ignored = new Set()) { return segments.find((segment, index) => !ignored.has(index) && time >= segment.start && time < segment.end); },
    automatic(record, segment, threshold) {
      return segment.confidence >= threshold && record.segments.reduce((sum, item) => sum + item.end - item.start, 0) < record.video.duration * 0.5;
    },
    sourceLabel(source) { return { "local-cache": "本地缓存", shared: "共享缓存", deepseek: "DeepSeek Flash" }[source] || "本地标记"; },
  };
  globalThis.BiliSkipPlayer = api;
})();
