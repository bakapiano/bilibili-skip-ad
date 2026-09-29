const media = document.getElementById("media"), first = "BV1pFUDBKE8X", second = "BV1WhE1zeEWH";
if (new URL(location.href).searchParams.get("video") === "two") media.src = "/fixture.wav?video=two";
const parse = globalThis.BiliSkipPlayer.parse;
// Explicit fixture-only identity adapter. Production code keeps its HTTPS Bili checks.
globalThis.BiliSkipPlayer.parse = url => parse(`https://www.bilibili.com/video/${new URL(url).searchParams.get("video") === "two" ? second : first}`);
let settings = { hasKey: true, consent: true, autoSkip: true, autoAnalyze: false, sharedUpload: false, confidenceThreshold: 0.9, buildVersion: "fixture" };
const listeners = new Set();
globalThis.chrome = { runtime: { id: "fixture", onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
  async sendMessage(message) {
    if (message.type === "SET_AUTO_SKIP") { settings = { ...settings, autoSkip: message.enabled }; return { ok: true, data: settings }; }
    const bvid = message.video?.bvid || first, switched = bvid === second;
    const record = { key: bvid, createdAt: 1, source: "local-cache", model: "fixture", cueCount: 4, elapsedMs: 0,
      video: { bvid, page: 1, cid: switched ? 2 : 1, duration: 100 },
      segments: [{ start: switched ? 30 : 10, end: switched ? 40 : 20, confidence: 0.98, brand: "合成广告", reason: "浏览器回归专用" }] };
    return { ok: true, data: { record, cueCount: 4, settings, metrics: { apiCalls: 0, cacheHits: 1 } } };
  },
} };
const script = document.createElement("script"); script.src = "/extension/content.js"; document.body.append(script);
document.getElementById("seek12").onclick = () => { media.currentTime = 12; };
document.getElementById("seek15").onclick = () => { media.currentTime = 15; };
document.getElementById("play8").onclick = () => { media.currentTime = 8; media.play(); };
document.getElementById("pause").onclick = () => media.pause();
document.querySelector(".bpx-player-progress-area").onclick = event => {
  const bounds = event.currentTarget.getBoundingClientRect();
  media.currentTime = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * media.duration;
};
document.getElementById("route").onclick = () => {
  const next = new URL(location.href).searchParams.get("video") === "two" ? "one" : "two";
  history.pushState({}, "", `?video=${next}`); media.src = `/fixture.wav?video=${next}`; media.load();
};
document.getElementById("remount").onclick = () => {
  const old = document.querySelector(".bpx-player-progress-schedule-wrap"); old.replaceWith(old.cloneNode(false));
};
setInterval(() => {
  for (const bar of document.querySelectorAll(".current")) bar.style.width = `${media.currentTime / (media.duration || 100) * 100}%`;
  const root = document.getElementById("biliskip-extension-root");
  document.getElementById("media-report").textContent = JSON.stringify({ time: media.currentTime, duration: media.duration, paused: media.paused,
    seeking: media.seeking, markers: Array.from(document.querySelectorAll(".biliskip-native-marker")).map(m => ({ start: m.dataset.start, end: m.dataset.end })),
    panel: root?.dataset, status: root?.shadowRoot?.querySelector(".status")?.textContent }, null, 2);
}, 100);
