// Deterministic DOM/unit harness. Real Chrome E2E is tracked separately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { flush, deferred, ref } from "./fixtures.js";

const playerSource = readFileSync(new URL("../../extension/player-core.js", import.meta.url), "utf8");
const contentSource = readFileSync(new URL("../../extension/content.js", import.meta.url), "utf8");
const timelineSource = readFileSync(new URL("../../extension/timeline.js", import.meta.url), "utf8");
const sample = () => ({ key: "sample-key", createdAt: 1, source: "local-cache", cueCount: 4, model: "deepseek-flash", elapsedMs: 100,
  video: { ...ref, cid: 1, duration: 100 }, segments: [{ start: 10, end: 20, confidence: 0.98, brand: "测试", reason: "测试赞助" }] });

function fixture({ record = sample(), settings: initialSettings = {}, handler } = {}) {
  const elements = [], requests = [], listeners = new Set(); let tick, now = 1000;
  let settings = { hasKey: true, consent: true, autoSkip: false, autoAnalyze: false, confidenceThreshold: 0.9, ...initialSettings };
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.style = {}; this.dataset = {}; this.events = new Map();
      this.classList = { add() {}, toggle() {} }; this.textContent = ""; elements.push(this);
    }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this[name] = value; }
    attachShadow() { this.shadowRoot = new Element("shadow"); return this.shadowRoot; }
    addEventListener(name, callback) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(callback); }
    removeEventListener(name, callback) { this.events.get(name)?.delete(callback); }
    emit(name, event = {}) { for (const callback of this.events.get(name) || []) callback(event); }
    click(isTrusted = true) { if (!this.disabled) this.emit("click", { isTrusted }); }
    getBoundingClientRect() { return { width: 640, height: 360 }; }
    closest() { return null; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  }
  const video = new Element("video");
  Object.assign(video, { duration: 100, readyState: 4, currentSrc: "media-a", currentTime: 12, paused: false, seeking: false });
  const body = new Element("body"), document = new Element("document");
  Object.assign(document, { body, visibilityState: "visible", createElement: tag => new Element(tag), querySelectorAll: () => [video] });
  const location = { href: `https://www.bilibili.com/video/${ref.bvid}/` };
  const chrome = { runtime: { id: "extension", onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    async sendMessage(message) {
      requests.push(message);
      if (handler) { const result = await handler(message); if (result !== undefined) return result; }
      if (message.type === "SET_AUTO_SKIP") { settings = { ...settings, autoSkip: message.enabled }; return { ok: true, data: settings }; }
      return { ok: true, data: { record, cueCount: 4, settings } };
    } } };
  const sandbox = { document, location, chrome, URL, AbortController, Date: { now: () => now }, setTimeout,
    setInterval: fn => { tick = fn; return 1; }, clearInterval() {} };
  vm.createContext(sandbox); vm.runInContext(playerSource, sandbox); vm.runInContext(timelineSource, sandbox); vm.runInContext(contentSource, sandbox);
  const visibleElements = () => { const walk = node => [node, ...node.children.flatMap(walk), ...(node.shadowRoot ? walk(node.shadowRoot) : [])]; return walk(body); };
  return { video, document, location, requests, sandbox, host: elements.find(e => e.id === "biliskip-extension-root"),
    button: text => visibleElements().find(node => node.tag === "button" && node.textContent === text),
    tick: (advance = 1000) => { now += advance; tick(); },
    setRecord: value => { record = value; },
    externalSeek(time) { video.currentTime = time; video.seeking = true; video.emit("seeking"); video.seeking = false; video.emit("seeked"); },
    finishInternalSeek() { video.seeking = true; video.emit("seeking"); video.seeking = false; video.emit("seeked"); },
    broadcast(data) { for (const listener of listeners) listener(data, { id: chrome.runtime.id }, () => {}); } };
}
async function ready(options) { const f = fixture(options); await flush(); f.tick(); return f; }

test("extension preview -> opt-in -> auto skip -> undo -> cache refresh preserves undo", async () => {
  const f = await ready(); assert.equal(f.video.currentTime, 12);
  f.button("试听第 1 段边界").click(); assert.equal(f.video.currentTime, 8);
  f.video.currentTime = 12; f.button("开启自动跳过").click(); await flush();
  assert.equal(f.video.currentTime, 20.05); assert.equal(f.host.dataset.lastJump, "12.000:20.050");
  f.button("撤销跳过").click(); assert.equal(f.video.currentTime, 12); f.tick(); assert.equal(f.video.currentTime, 12);
  f.button("读取缓存").click(); await flush(); f.tick();
  assert.equal(f.video.currentTime, 12, "same record refresh keeps ignored segments");
  assert.equal(f.host.dataset.lastAction, "undo");
});
test("automatic player honors pause, seeking, confidence and extreme coverage", async () => {
  const f = await ready(); f.video.paused = true; f.button("开启自动跳过").click(); await flush();
  assert.equal(f.video.currentTime, 12); f.video.paused = false; f.video.seeking = true; f.tick(); assert.equal(f.video.currentTime, 12);
  f.video.seeking = false; f.tick(); assert.equal(f.video.currentTime, 20.05);
  const low = sample(); low.segments[0].confidence = 0.7;
  const l = await ready({ record: low, settings: { autoSkip: true } }); assert.equal(l.video.currentTime, 12);
  const high = sample(); high.segments[0].end = 90;
  const h = await ready({ record: high, settings: { autoSkip: true } }); assert.equal(h.video.currentTime, 12);
});
test("untrusted clicks cannot seek or send analysis", async () => {
  const f = await ready(); const count = f.requests.length;
  f.button("跳过当前广告").click(false); f.button("重新分析（再次计费）").click(false);
  await flush(); assert.equal(f.video.currentTime, 12); assert.equal(f.requests.length, count);
});
test("SPA route change clears prior record and stale async response is discarded", async () => {
  const gate = deferred(); let calls = 0;
  const f = fixture({ handler: async m => {
    if (m.type !== "GET_PAGE_STATE") return;
    calls++; if (calls === 1) return gate.promise;
    return { ok: true, data: { record: null, cueCount: 0, settings: { autoSkip: true } } };
  } });
  f.location.href = "https://www.bilibili.com/video/BV1pFUDBKE8Y/"; f.tick(); await flush();
  gate.resolve({ ok: true, data: { record: sample(), settings: { autoSkip: true, confidenceThreshold: 0.9 } } });
  await flush(); f.tick(); assert.equal(f.video.currentTime, 12); assert.equal(f.host.dataset.cacheSource, "");
  assert.equal(f.host.dataset.video, "BV1pFUDBKE8Y:p1");
  f.location.href = "https://www.bilibili.com/"; f.tick(); assert.equal(f.host.style.display, "none");
});
test("same media source during SPA transition holds auto seek until new media loads", async () => {
  const f = await ready();
  const next = sample(); next.video.bvid = "BV1pFUDBKE8Y"; next.key = "second";
  f.setRecord(next); f.location.href = "https://www.bilibili.com/video/BV1pFUDBKE8Y/"; f.tick(); await flush();
  f.button("开启自动跳过").click(); await flush(); f.tick(); assert.equal(f.video.currentTime, 12);
  f.video.currentSrc = "media-b"; f.video.emit("loadedmetadata"); f.tick(); assert.equal(f.video.currentTime, 20.05);
});
test("metadata arriving before the SPA polling tick is associated with the new route", async () => {
  const f = await ready({ settings: { autoSkip: true } }); f.finishInternalSeek();
  const next = sample(); next.video.bvid = "BV1WhE1zeEWH"; next.key = "next"; f.setRecord(next);
  f.location.href = "https://www.bilibili.com/video/BV1WhE1zeEWH/";
  f.video.currentSrc = "media-b"; f.video.currentTime = 12; f.video.emit("loadedmetadata");
  f.tick(); await flush(); f.tick();
  assert.equal(f.host.dataset.video, "BV1WhE1zeEWH:p1"); assert.equal(f.video.currentTime, 20.05);
});
test("duration mismatch and exclusive segment end prevent accidental seek", async () => {
  const record = sample(); record.video.duration = 200;
  const f = await ready({ record, settings: { autoSkip: true } }); assert.equal(f.video.currentTime, 12);
  const g = await ready(); g.video.currentTime = 20; g.button("开启自动跳过").click(); await flush(); g.tick(); assert.equal(g.video.currentTime, 20);
});
test("automatic analysis runs once per route only in visible opted-in pages", async () => {
  const f = fixture({ record: null, settings: { autoAnalyze: true } }); f.document.visibilityState = "hidden";
  await flush(); f.tick(); assert.equal(f.requests.filter(r => r.type === "ANALYZE").length, 0);
  f.document.visibilityState = "visible"; f.document.emit("visibilitychange"); await flush(); f.tick();
  assert.equal(f.requests.filter(r => r.type === "ANALYZE").length, 1);
  assert.equal(f.requests.find(r => r.type === "ANALYZE").automatic, true);
});
test("new result version resets suppression and permits applying the updated marker", async () => {
  const f = await ready(); f.button("开启自动跳过").click(); await flush(); f.button("撤销跳过").click();
  const updated = sample(); updated.createdAt = 2; f.setRecord(updated);
  f.button("读取缓存").click(); await flush(); f.tick(); assert.equal(f.video.currentTime, 20.05);
});
test("subtitle error preserves public key status and remains a visible error", async () => {
  const f = await ready({ handler: async message => message.type === "GET_PAGE_STATE" ? {
    ok: true, data: { record: null, cueCount: 0, error: { code: "BILI_NETWORK", message: "视频元数据接口连接失败" },
      settings: { hasKey: true, consent: true, autoSkip: false, autoAnalyze: true, confidenceThreshold: 0.9 } },
  } : undefined });
  assert.equal(f.host.dataset.state, "error"); assert.equal(f.host.dataset.errorCode, "BILI_NETWORK");
  assert.ok(f.button("分析当前视频"));
  assert.equal(f.button("设置 Key 与授权"), undefined);
  assert.equal(f.requests.filter(r => r.type === "ANALYZE").length, 0);
  assert.equal(f.button("跳过当前广告").disabled, true);
});
test("clicking back into an already-skipped ad skips again", async () => {
  const f = await ready({ settings: { autoSkip: true } }); assert.equal(f.video.currentTime, 20.05);
  f.finishInternalSeek(); f.externalSeek(13); assert.equal(f.video.currentTime, 20.05);
  f.finishInternalSeek(); f.button("撤销跳过").click(); f.finishInternalSeek(); f.tick();
  assert.equal(f.video.currentTime, 13);
  f.externalSeek(14); assert.equal(f.video.currentTime, 20.05);
});
test("explicit seek skips while paused and preserves the paused state", async () => {
  const f = fixture({ settings: { autoSkip: true } }); f.video.paused = true;
  await flush(); f.tick(); assert.equal(f.video.currentTime, 12);
  f.externalSeek(14); assert.equal(f.video.currentTime, 20.05); assert.equal(f.video.paused, true);
  f.finishInternalSeek(); f.button("撤销跳过").click(); f.finishInternalSeek(); f.tick();
  assert.equal(f.video.currentTime, 14); assert.equal(f.video.paused, true);
});
test("external seeking respects disabled auto mode and low-confidence safeguards", async () => {
  const f = await ready(); f.externalSeek(14); assert.equal(f.video.currentTime, 14);
  const low = sample(); low.segments[0].confidence = 0.7;
  const g = await ready({ record: low, settings: { autoSkip: true } }); g.externalSeek(14); assert.equal(g.video.currentTime, 14);
});
test("seeking through intermediate drag positions waits for the settled seek", async () => {
  const f = fixture({ settings: { autoSkip: true } }); f.video.paused = true; await flush(); f.tick();
  f.video.currentTime = 11; f.video.seeking = true; f.video.emit("seeking");
  for (const time of [12, 15, 18]) { f.video.currentTime = time; f.tick(); assert.equal(f.video.currentTime, time); }
  f.video.seeking = false; f.video.emit("seeked"); assert.equal(f.video.currentTime, 20.05);
});
test("preview and slow internal undo retain suppression until an external seek", async () => {
  const f = await ready({ settings: { autoSkip: true } }); f.finishInternalSeek();
  f.button("试听第 1 段边界").click(); f.finishInternalSeek(); f.video.currentTime = 12; f.tick(); assert.equal(f.video.currentTime, 12);
  f.externalSeek(14); f.finishInternalSeek(); f.button("撤销跳过").click();
  f.video.seeking = true; f.tick(10000); f.video.emit("seeking"); f.video.seeking = false; f.video.emit("seeked");
  f.tick(); assert.equal(f.video.currentTime, 14);
});
test("SPA identity propagation retries are bounded and recover a transient sender mismatch", async () => {
  let calls = 0;
  const f = fixture({ handler: async message => {
    if (message.type === "GET_PAGE_STATE" && ++calls <= 2) return { ok: false, error: { code: "SENDER", message: "正在切换" } };
  } });
  await new Promise(resolve => setTimeout(resolve, 700)); f.tick();
  assert.equal(calls, 3); assert.equal(f.host.dataset.state, "ready");
  let failures = 0;
  const g = fixture({ handler: async message => {
    if (message.type === "GET_PAGE_STATE") { failures++; return { ok: false, error: { code: "SENDER", message: "错误来源" } }; }
  } });
  await new Promise(resolve => setTimeout(resolve, 700)); g.tick();
  assert.equal(failures, 3); assert.equal(g.host.dataset.state, "error");
});
