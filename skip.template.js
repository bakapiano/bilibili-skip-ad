// ==UserScript==
// @name         BiliSkip · AI 广告标记 PoC
// @namespace    local.biliskip.poc
// @version      0.1.0
// @description  基于本地生成的字幕标记预览、跳过广告；结果仅保存在脚本内。
// @match        https://www.bilibili.com/video/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";
  const data = __BILISKIP_DATA__;

  function matchesVideo(url, duration) {
    const parsed = new URL(url);
    const bvid = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/)?.[1];
    const page = Number(parsed.searchParams.get("p") || 1);
    return parsed.hostname === "www.bilibili.com" && bvid === data.video.bvid &&
      page === data.video.page && Number.isFinite(duration) && duration > 0 &&
      Math.abs(duration - data.video.duration) <= 2;
  }

  function segmentAt(time, ignored) {
    return data.segments.find((segment, index) => !ignored.has(index) &&
      time >= segment.start && time < segment.end);
  }

  function autoEligible(segment) {
    const coverage = data.segments.reduce((total, item) => total + item.end - item.start, 0);
    return segment.confidence >= data.auto_threshold && coverage < data.video.duration * 0.5;
  }

  function stamp(seconds) {
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
  }

  // Allows the exact generated script to be exercised by Node's built-in test
  // runner with a lightweight DOM/video fixture; no browser installation needed.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { data, matchesVideo, segmentAt, autoEligible, stamp };
    return;
  }

  let video = null;
  let enabled = false; // Preview first; the user can opt into automatic skipping.
  let identityConfirmed = false;
  let identityEpoch = 0;
  let boundPage = "";
  let currentRoute = "";
  let lastSkip = null;
  const ignored = new Set();
  const completed = new Set();
  const host = document.createElement("div");
  host.id = "biliskip-poc";
  host.style.cssText = "position:fixed;right:16px;bottom:72px;z-index:2147483646;display:none";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { color-scheme:dark; }
    .panel { width:300px;background:#171d2a;color:#edf2fa;border:1px solid #586478;
      border-radius:12px;padding:14px;font:13px/1.6 system-ui,sans-serif;box-shadow:0 6px 24px #0005; }
    strong { display:block;font-size:14px; }
    .status { margin:8px 0;white-space:pre-wrap; }
    .actions { display:flex;gap:6px;flex-wrap:wrap; }
    button { color:#eef4ff;background:#2d3d59;border:1px solid #566681;border-radius:6px;
      cursor:pointer;padding:5px 8px;font:inherit; }
    button:disabled { opacity:.5;cursor:default; }
    details { margin-top:8px; }
    .segment { margin-top:8px;border-top:1px solid #455268;padding-top:8px; }
    .muted { color:#b9c7dc;font-size:12px; }
  `;
  shadow.append(style);
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.setAttribute("aria-label", "BiliSkip 广告标记");
  shadow.append(panel);
  const title = document.createElement("strong");
  const modelLabel = { "deepseek-api": "DeepSeek Flash", "local-llama": "本地 Qwen3-4B" }[data.detector?.backend] || "Codex";
  title.textContent = `BiliSkip · ${modelLabel} 字幕标记`;
  panel.append(title);
  const status = document.createElement("div");
  status.className = "status";
  panel.append(status);
  const actions = document.createElement("div");
  actions.className = "actions";
  panel.append(actions);

  function button(label, action, parent = actions) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", action);
    parent.append(element);
    return element;
  }

  function safeToSeek() {
    return video && identityConfirmed && !video.seeking &&
      matchesVideo(location.href, video.duration) && routeKey() === boundPage;
  }

  function jump(segment) {
    if (!safeToSeek()) return;
    const index = data.segments.indexOf(segment);
    lastSkip = { index, time: video.currentTime };
    completed.add(index);
    // A tiny guard avoids a precision-related re-entry at the end boundary.
    video.currentTime = Math.min(segment.end + 0.05, video.duration);
    update();
  }

  const toggle = button("开启自动跳过", () => {
    enabled = !enabled;
    if (enabled) {
      // A deliberate opt-in after listening to a boundary starts a fresh pass.
      ignored.clear();
      completed.clear();
      lastSkip = null;
    }
    toggle.textContent = enabled ? "自动跳过：开" : "开启自动跳过";
    update();
  });
  const skip = button("跳过当前广告", () => {
    const segment = video && segmentAt(video.currentTime, ignored);
    if (segment) jump(segment);
  });
  const undo = button("撤销跳过", () => {
    if (!lastSkip || !safeToSeek()) return;
    ignored.add(lastSkip.index);
    video.currentTime = Math.max(0, lastSkip.time);
    lastSkip = null;
    update();
  });
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `查看 ${data.segments.length} 个广告标记`;
  details.append(summary);
  for (const segment of data.segments) {
    const row = document.createElement("div");
    row.className = "segment";
    const text = document.createElement("div");
    text.textContent = `${stamp(segment.start)}–${stamp(segment.end)} · ${segment.brand}\n${segment.reason}`;
    row.append(text);
    button("试听边界", () => {
      if (!safeToSeek()) return;
      ignored.add(data.segments.indexOf(segment));
      video.currentTime = Math.max(0, segment.start - 2);
      update();
    }, row);
    details.append(row);
  }
  panel.append(details);
  const note = document.createElement("div");
  note.className = "muted";
  note.textContent = "先试听边界，再开启自动跳过。评分为模型自评。";
  panel.append(note);
  document.body.append(host);

  function routeKey() {
    const url = new URL(location.href);
    return `${url.pathname}:${url.searchParams.get("p") || "1"}`;
  }

  async function confirmIdentity(epoch, route) {
    try {
      // Bind the CID as well as BV/page/duration; a replaced upload may reuse a
      // BV identifier. This GET contains only the public video ID.
      const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${data.video.bvid}`,
        { credentials: "omit", signal: AbortSignal.timeout(10000) });
      const payload = await response.json();
      if (epoch !== identityEpoch || route !== routeKey()) return;
      const part = payload.data?.pages?.[data.video.page - 1];
      identityConfirmed = payload.code === 0 && part?.cid === data.video.cid;
      boundPage = route;
      if (!identityConfirmed) status.textContent = "视频内容标识已变化，请重新生成标记。";
    } catch {
      if (epoch === identityEpoch) status.textContent = "等待视频标识验证；刷新页面可重试。";
    }
  }

  function update() {
    if (!video || !matchesVideo(location.href, video.duration)) return;
    if (!identityConfirmed) {
      skip.disabled = true;
      undo.disabled = true;
      return;
    }
    const segment = segmentAt(video.currentTime, ignored);
    skip.disabled = !segment || video.seeking;
    undo.disabled = !lastSkip || video.seeking;
    if (enabled && segment && !video.paused && safeToSeek() && autoEligible(segment) &&
        !completed.has(data.segments.indexOf(segment))) {
      jump(segment);
      return;
    }
    status.textContent = segment
      ? `当前广告：${segment.brand}\n${stamp(segment.start)} → ${stamp(segment.end)} · 评分 ${segment.confidence.toFixed(2)}`
      : lastSkip ? `已跳过 ${data.segments[lastSkip.index].brand}；可撤销返回。`
        : `${data.segments.length} 个标记已就绪 · ${enabled ? "自动跳过已开启" : "预览模式"}`;
  }

  function tick() {
    const candidate = Array.from(document.querySelectorAll("video"))
      .find(element => element.getBoundingClientRect().width > 0 && matchesVideo(location.href, element.duration)) || null;
    const route = routeKey();
    if (candidate !== video || route !== currentRoute) {
      if (video) video.removeEventListener("timeupdate", update);
      video = candidate || null;
      currentRoute = route;
      identityConfirmed = false;
      identityEpoch += 1;
      lastSkip = null;
      ignored.clear();
      completed.clear();
      if (video) {
        video.addEventListener("timeupdate", update);
        status.textContent = "正在验证视频 CID…";
        confirmIdentity(identityEpoch, route);
      }
    }
    host.style.display = video ? "block" : "none";
    if (video) update();
  }
  tick();
  setInterval(tick, 250);
})();
