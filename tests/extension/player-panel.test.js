import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { UserscriptRuntime } from "../../userscript/runtime.js";
import { gmFixture, lockFixture } from "../userscript/fixtures.js";
import { DEFAULT_SETTINGS } from "../../extension/lib/constants.js";
import { deferred, flush, ref } from "./fixtures.js";

const scripts = await Promise.all(
  [
    "player-core.js",
    "timeline.js",
    "content-controller.js",
    "popup-view.js",
    "player-assets.js",
    "player-panel.js",
    "pet-state.js",
    "pet-assets.js",
    "pet.js",
    "content.js",
  ].map(async (name) => readFile(new URL(`../../extension/${name}`, import.meta.url), "utf8")),
);

async function fixture(t, { petPreview = false, request } = {}) {
  // Entire production Chrome content stack with synthetic runtime transport and media geometry.
  const dom = new JSDOM(
    '<body><div class="bpx-player-container"><video></video><div class="bpx-player-control-bottom-right"></div></div></body>',
    {
      url: `https://www.bilibili.com/video/${ref.bvid}/`,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  t.after(() => {
    dom.window.__biliskipV1?.destroy();
    dom.window.close();
  });
  const { window } = dom;
  const { document } = window;
  // Test-only clock advances media identity settling without wall-clock sleeps.
  let now = 1000;
  window.Date.now = () => now;
  const shadows = new Map();
  const callbacks = new Map();
  const originalShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) {
    const root = originalShadow.call(this, options);
    shadows.set(this, root);
    return root;
  };
  const originalAdd = window.EventTarget.prototype.addEventListener;
  window.EventTarget.prototype.addEventListener = function (type, callback, options) {
    if (!callbacks.has(this)) {
      callbacks.set(this, new Map());
    }
    const types = callbacks.get(this);
    if (!types.has(type)) {
      types.set(type, []);
    }
    types.get(type).push(callback);
    return originalAdd.call(this, type, callback, options);
  };
  const timers = new Map();
  let nextTimer = 0;
  window.setInterval = (callback) => {
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  };
  window.clearInterval = (id) => timers.delete(id);
  const video = document.querySelector("video");
  video.getBoundingClientRect = () => ({ width: 720, height: 405 });
  for (const [name, value] of Object.entries({
    duration: 100,
    currentTime: 0,
    readyState: 4,
    seeking: false,
    paused: true,
    currentSrc: "synthetic-media",
  })) {
    Object.defineProperty(video, name, { value, writable: true, configurable: true });
  }
  const gm = gmFixture();
  gm.values.set("biliskip:v1:settings", { ...DEFAULT_SETTINGS, consent: true, autoAnalyze: true });
  gm.values.set("biliskip:v1:deepseekKey", "test-only-placeholder");
  const listeners = new Set();
  const runtime = new UserscriptRuntime({
    gm: gm.gm,
    location: window.location,
    locks: lockFixture(),
    openOptions() {},
  });
  runtime.subscribe((message) => {
    for (const listener of listeners) {
      listener(message, { id: "extension" });
    }
  });
  window.chrome = {
    runtime: {
      id: "extension",
      getURL: (path) => `chrome-extension://extension/${path}`,
      sendMessage: (message) => (request ? request(message) : runtime.request(message)),
      onMessage: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
      },
    },
  };
  for (const script of scripts) {
    window.eval(
      petPreview && script.includes("globalThis.BiliSkipPetAssets =")
        ? script.replace("enabled: false", "enabled: true")
        : script,
    );
  }
  await flush();
  const panel = () => shadows.get(document.getElementById("biliskip-extension-panel"));
  const emit = async (element, type, props = {}) => {
    for (const callback of callbacks.get(element)?.get(type) || []) {
      await callback({ isTrusted: true, stopPropagation() {}, preventDefault() {}, ...props });
    }
    await flush();
  };
  return {
    window,
    document,
    panel,
    emit,
    timers,
    tick: () => {
      now += 1000;
      for (const callback of timers.values()) {
        callback();
      }
    },
    runtime,
  };
}

async function waitForPetTitle(f, prefix) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const actual = f.document.querySelector(".biliskip-pet-title")?.textContent;
    if (prefix === "" ? actual === "" : actual?.startsWith(prefix)) {
      return;
    }
    await flush();
  }
  assert.fail(`Pet title did not reach ${prefix}`);
}

test("Chrome pet waits for saved settings on startup and BFCache restoration", async (t) => {
  let pending = deferred();
  const f = await fixture(t, { petPreview: true, request: () => pending.promise });
  const ready = {
    ok: true,
    data: {
      cueCount: 0,
      settings: { ...DEFAULT_SETTINGS, petEnabled: true, petMirror: true },
    },
  };
  assert.equal(f.document.querySelector(".biliskip-pet"), null);
  f.tick();
  assert.equal(f.document.querySelector(".biliskip-pet"), null);
  pending.resolve(ready);
  await flush();
  let host = f.document.querySelector(".biliskip-pet");
  assert.ok(host);
  assert.equal(host.hidden, false);
  assert.equal(host.dataset.mirrored, "true");
  assert.equal(host.style.left, "0px");
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pagehide", { persisted: true }));
  pending = deferred();
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  assert.equal(f.document.querySelector(".biliskip-pet"), null);
  f.tick();
  assert.equal(f.document.querySelector(".biliskip-pet"), null);
  pending.resolve(ready);
  await flush();
  host = f.document.querySelector(".biliskip-pet");
  assert.equal(host.dataset.mirrored, "true");
  assert.equal(host.style.left, "0px");
  assert.equal(f.document.querySelectorAll(".biliskip-pet").length, 1);
});

test("Chrome pet remains pending after a settings request fails and recovers on settings broadcast", async (t) => {
  const f = await fixture(t, {
    petPreview: true,
    request: async () => ({ ok: false, error: { code: "MESSAGE", message: "测试读取失败" } }),
  });
  assert.equal(f.document.querySelector(".biliskip-pet"), null);
  f.tick();
  assert.equal(f.document.querySelector(".biliskip-pet"), null);
  f.runtime.emit({
    type: "BILISKIP_SETTINGS",
    settings: { ...DEFAULT_SETTINGS, petEnabled: true, petMirror: true },
  });
  const host = f.document.querySelector(".biliskip-pet");
  assert.ok(host);
  assert.equal(host.dataset.mirrored, "true");
  assert.equal(host.style.left, "0px");
});

test("pet observes the real controller and simulated provider result, then cache refresh stays silent", async (t) => {
  const f = await fixture(t, { petPreview: true });
  await waitForPetTitle(f, "大肥鱼吃了你");
  assert.match(
    f.document.querySelector(".biliskip-pet-title").textContent,
    /^大肥鱼吃了你 ¥[\d.]+$/,
  );
  assert.equal(f.document.querySelector(".biliskip-pet-detail"), null);
  await f.emit(f.document.querySelector(".biliskip-pet-open"), "click");
  await f.emit(f.panel().getElementById("refresh"), "click");
  await waitForPetTitle(f, "");
  assert.equal(f.document.querySelector(".biliskip-pet-bubble").hidden, true);
  assert.equal(f.document.querySelector(".biliskip-pet").hidden, false);
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pagehide", { persisted: true }));
  assert.equal(f.document.querySelector(".biliskip-pet"), null);
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  await waitForPetTitle(f, "");
  assert.equal(f.document.querySelectorAll(".biliskip-pet").length, 1);
});

test("Chrome pet announces automatic playback skips, undo and repeated explicit seeks", async (t) => {
  const f = await fixture(t, { petPreview: true });
  await waitForPetTitle(f, "大肥鱼吃了你");
  await f.emit(f.document.querySelector(".biliskip-pet-open"), "click");
  f.tick();
  const video = f.document.querySelector("video");
  video.currentTime = 12;
  video.paused = false;
  await f.emit(f.panel().getElementById("toggle"), "click");
  assert.equal(video.currentTime, 20.05);
  assert.equal(
    f.document.querySelector(".biliskip-pet-title").textContent,
    "跳过 8 秒恰饭片段~ 吃点白饭不过分吧！",
  );
  await f.emit(f.panel().getElementById("undo"), "click");
  assert.equal(video.currentTime, 12);
  assert.doesNotMatch(
    f.document.querySelector(".biliskip-pet-title").textContent,
    /跳过 \d+ 秒恰饭片段/,
  );
  video.paused = true;
  video.currentTime = 14;
  await f.emit(video, "seeking");
  await f.emit(video, "seeked");
  assert.equal(video.currentTime, 20.05);
  assert.equal(video.paused, true);
  assert.match(f.document.querySelector(".biliskip-pet-title").textContent, /跳过 6 秒恰饭片段/);
});

test("Chrome native entry opens a private right drawer with safe settings navigation and trusted actions", async (t) => {
  const f = await fixture(t);
  const button = f.document.querySelector(".biliskip-player-button");
  assert.ok(button);
  assert.equal(f.panel(), undefined);
  button.click();
  assert.equal(f.panel(), undefined);
  await f.emit(button, "click");
  assert.equal(f.panel().querySelector("[role=dialog]").getAttribute("aria-modal"), null);
  assert.equal(f.document.getElementById("biliskip-extension-panel").shadowRoot, null);
  assert.equal(f.panel().querySelectorAll(".project-links a").length, 2);
  const projectIcons = f.panel().querySelectorAll(".project-links a svg");
  assert.equal(projectIcons.length, 2);
  assert.equal(projectIcons[0].getAttribute("viewBox"), "0 0 24 24");
  assert.equal(projectIcons[1].getAttribute("viewBox"), "0 0 16 16");
  assert.doesNotMatch(f.panel().textContent, /test-only-placeholder/);
  const messages = [];
  const request = f.runtime.request.bind(f.runtime);
  f.runtime.request = (message) => {
    messages.push(message);
    return request(message);
  };
  await f.emit(f.panel().getElementById("options"), "click");
  assert.equal(messages.at(-1).type, "OPEN_OPTIONS");
  await f.emit(f.panel(), "keydown", { key: "Escape" });
  assert.equal(f.panel(), undefined);
  assert.equal(button.getAttribute("aria-expanded"), "false");
});

test("player entry matches the native 22px control row without baseline or padding drift", async (t) => {
  const f = await fixture(t);
  const button = f.document.querySelector(".biliskip-player-button");
  const icon = button.querySelector("svg");
  assert.equal(button.style.height, "22px");
  assert.equal(button.style.padding, "0px");
  assert.equal(button.style.boxSizing, "border-box");
  assert.equal(button.style.lineHeight, "0");
  assert.equal(button.style.alignItems, "center");
  assert.equal(button.style.justifyContent, "center");
  assert.equal(icon.style.display, "block");
  assert.equal(icon.style.width, "22px");
  assert.equal(icon.style.height, "22px");
  const controls = f.document.querySelector(".bpx-player-control-bottom-right");
  const native = f.document.createElement("div");
  native.className = "bpx-player-ctrl-quality";
  native.style.lineHeight = "32px";
  native.style.height = "43px";
  controls.append(native);
  f.tick();
  assert.equal(button.style.height, "32px", "follow the native fullscreen line box");
  assert.equal(icon.style.height, "22px");
  native.style.lineHeight = "22px";
  f.tick();
  assert.equal(button.style.height, "22px");
});

test("drawer survives fullscreen and SPA, controls remount once and BFCache restores lifecycle", async (t) => {
  const f = await fixture(t);
  await f.emit(f.document.querySelector(".biliskip-player-button"), "click");
  const player = f.document.querySelector(".bpx-player-container");
  Object.defineProperty(f.document, "fullscreenElement", { value: player, configurable: true });
  f.document.dispatchEvent(new f.window.Event("fullscreenchange"));
  assert.equal(f.document.getElementById("biliskip-extension-panel").parentElement, player);
  Object.defineProperty(f.document, "fullscreenElement", { value: null, configurable: true });
  f.document.dispatchEvent(new f.window.Event("fullscreenchange"));
  assert.equal(
    f.document.getElementById("biliskip-extension-panel").parentElement,
    f.document.body,
  );
  const controls = f.document.querySelector(".bpx-player-control-bottom-right");
  controls.replaceWith(controls.cloneNode(false));
  f.window.history.pushState({}, "", "/video/BV1pFUDBKE8Y/");
  f.tick();
  await flush();
  f.tick();
  await flush();
  assert.equal(f.document.querySelectorAll(".biliskip-player-button").length, 1);
  assert.equal(
    f.document.getElementById("biliskip-extension-root").dataset.video,
    "BV1pFUDBKE8Y:p1",
  );
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pagehide", { persisted: true }));
  assert.equal(f.timers.size, 0);
  assert.equal(f.document.getElementById("biliskip-extension-panel"), null);
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  await flush();
  assert.equal(f.document.querySelectorAll(".biliskip-player-button").length, 1);
});
