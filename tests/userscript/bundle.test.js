import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { bundleUserscript, USERSCRIPT_VERSION } from "../../scripts/build-userscript.js";
import { DEFAULT_SETTINGS } from "../../extension/lib/constants.js";
import { ASR_ASSETS, asrAssetUrl } from "../../userscript/asr-assets.js";
import { SETTINGS_KEY } from "../../userscript/runtime.js";
import { gmFixture, lockFixture } from "./fixtures.js";
import { flush, ref } from "../extension/fixtures.js";

const bundle = await bundleUserscript();
const license = (await readFile(new URL("../../LICENSE", import.meta.url), "utf8")).trim();

async function settle(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "Expected the simulated userscript task to settle");
}

function browserFixture(options = {}) {
  const f = gmFixture(options.network);
  f.values.set(SETTINGS_KEY, {
    ...DEFAULT_SETTINGS,
    consent: true,
    autoAnalyze: true,
    autoSkip: true,
    ...options.settings,
  });
  f.values.set("biliskip:v1:deepseekKey", options.key ?? "test-only-placeholder");
  Object.assign(f.gm.info, options.info);
  Object.assign(f.gm, options.gm);
  const dom = new JSDOM(
    `<!doctype html><body>
    <div class="bpx-player-container"><video></video>
      <div class="bpx-player-progress-schedule-wrap" style="position:static"></div>
      <div class="bpx-player-shadow-progress-schedule-wrap" style="position:static"></div>
    </div>${options.extension ? '<div id="biliskip-extension-root" hidden></div>' : ""}</body>`,
    {
      url: `https://www.bilibili.com/video/${ref.bvid}/`,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const window = dom.window;
  const document = window.document;
  const video = document.querySelector("video");
  const shadows = new Map();
  const intervals = new Map();
  const clicks = new Map();
  let now = 1000;
  let nextTimer = 1;
  let nextPrompt = null;
  const alerts = [];
  const addEvent = window.EventTarget.prototype.addEventListener;
  window.EventTarget.prototype.addEventListener = function (type, callback, options) {
    // Test-only trusted-click stand-in. Real UI entry points still check isTrusted.
    if (type === "click") {
      if (!clicks.has(this)) {
        clicks.set(this, []);
      }
      clicks.get(this).push(callback);
    }
    return addEvent.call(this, type, callback, options);
  };
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) {
    const root = attachShadow.call(this, options);
    shadows.set(this, root);
    return root;
  };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };
  Object.assign(window, {
    GM: f.gm,
    TextEncoder,
    TextDecoder,
    Response,
    Headers,
    structuredClone,
    fetch: () => assert.fail("Bundle tests use GM fixtures and inline resource data"),
    alert: (value) => alerts.push(value),
    prompt: () => nextPrompt,
    confirm: () => true,
    setInterval(fn, ms) {
      const id = nextTimer++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
  });
  Object.defineProperty(window, "crypto", { value: webcrypto });
  Object.defineProperty(window.navigator, "locks", { value: lockFixture() });
  window.Date.now = () => now;
  for (const [name, value] of Object.entries({
    duration: 100,
    currentSrc: "media-first",
    readyState: 4,
    paused: false,
    seeking: false,
    currentTime: 0,
  })) {
    Object.defineProperty(video, name, { configurable: true, writable: true, value });
  }
  video.getBoundingClientRect = () => ({ width: 640, height: 360 });
  vm.runInContext(bundle.code, dom.getInternalVMContext());
  return {
    ...f,
    dom,
    window,
    document,
    video,
    intervals,
    alerts,
    async menu(name) {
      await settle(() => f.menus.has(name));
      f.menus.get(name)();
      await flush();
    },
    setPrompt(value) {
      nextPrompt = value;
    },
    tick() {
      now += 1000;
      for (const timer of [...intervals.values()]) {
        timer.fn();
      }
    },
    panel() {
      return shadows.get(document.getElementById("biliskip-userscript-panel"));
    },
    click(element) {
      for (const callback of clicks.get(element) || []) {
        callback({ isTrusted: true, preventDefault() {} });
      }
    },
    close() {
      window.dispatchEvent(new window.Event("pagehide"));
      window.close();
    },
  };
}

test("single-file artifact declares scoped grants and bundles shared business/player/view sources", () => {
  assert.ok(bundle.code.startsWith("// ==UserScript==\n"));
  assert.ok(bundle.code.includes(`// @version      ${USERSCRIPT_VERSION}\n`));
  assert.ok(Buffer.byteLength(bundle.code) < 2 * 1024 * 1024);
  for (const asset of ASR_ASSETS) {
    assert.ok(
      bundle.code.includes(
        `// @resource     ${asset.name} ${asrAssetUrl(asset)}#sha256=${asset.sha256}\n`,
      ),
    );
  }
  assert.match(bundle.code, /@grant\s+GM\.getResourceUrl/);
  assert.match(bundle.code, /^\/\/ @license\s+MIT$/m);
  assert.ok(bundle.code.includes(`/*\n${license}\n*/`));
  assert.doesNotMatch(bundle.code, /@sandbox|sandboxMode|DOM 隔离/);
  for (const grant of ["GM.getValue", "GM.setValue", "GM.xmlHttpRequest"]) {
    assert.ok(bundle.code.includes(`// @grant        ${grant}`));
  }
  assert.match(bundle.code, /@noframes/);
  assert.doesNotMatch(bundle.code, /@connect\s+\*|@require|@grant\s+unsafeWindow/);
  for (const domain of ["hf-mirror.com", "huggingface.co", "hf.co"]) {
    assert.ok(bundle.code.includes(`// @connect      ${domain}`));
  }
  assert.doesNotMatch(bundle.code, /\bsk-[a-zA-Z0-9]{24,}\b|\bchrome\.(runtime|tabs|storage)/);
  assert.doesNotThrow(() => new vm.Script(bundle.code));
  for (const file of [
    "extension/content-controller.js",
    "extension/popup-view.js",
    "extension/timeline.js",
    "extension/lib/service.js",
    "extension/lib/providers.js",
    "extension/lib/bilibili.js",
    "extension/popup.html",
    "extension/popup.css",
  ]) {
    assert.ok(bundle.inputs.includes(file), file);
  }
  assert.equal(bundle.inputs.includes("extension/background.js"), false);
  assert.equal(
    bundle.inputs.some((name) =>
      /asr-poc|qwen|sherpa|sensevoice|web-llm|biliskip:asr-assets/i.test(name),
    ),
    false,
  );
});

test("bundled userscript: subtitles/model/upload -> markers -> explicit seek skip -> undo/preview -> SPA", async (t) => {
  const f = browserFixture();
  t.after(() => f.close());
  await settle(
    () => f.document.getElementById("biliskip-userscript-root")?.dataset.state === "ready",
  );
  f.tick();
  assert.equal(f.document.querySelectorAll(".biliskip-native-marker").length, 2);
  assert.equal(f.document.getElementById("biliskip-userscript-panel"), null);
  assert.equal(
    f.requests.filter(({ details }) => details.url.includes("/chat/completions")).length,
    1,
  );
  assert.equal(
    f.requests.filter(({ details }) => details.url.includes("/v1/candidates")).length,
    1,
  );
  f.video.paused = true;
  f.video.currentTime = 12;
  f.video.seeking = true;
  f.video.dispatchEvent(new f.window.Event("seeking"));
  f.video.seeking = false;
  f.video.dispatchEvent(new f.window.Event("seeked"));
  assert.equal(f.video.currentTime, 20.05);
  assert.equal(f.video.paused, true);
  await f.menu("BiliSkip · 打开面板");
  await settle(() => f.panel()?.getElementById("source").textContent === "DeepSeek Flash");
  const root = f.panel();
  assert.equal(f.document.getElementById("biliskip-userscript-panel").shadowRoot, null);
  assert.doesNotMatch(root.textContent, /test-only-placeholder/);
  assert.match(root.getElementById("meta").textContent, /参考费用/);
  assert.equal(root.getElementById("analyze").disabled, false);
  root.getElementById("analyze").click();
  await flush();
  assert.equal(
    f.requests.filter(({ details }) => details.url.includes("/chat/completions")).length,
    1,
    "synthetic page click stays inert",
  );
  f.click(root.getElementById("undo"));
  await flush();
  assert.equal(f.video.currentTime, 12);
  f.tick();
  assert.equal(f.video.currentTime, 12);
  f.click(root.querySelector('[data-segment-action="preview"]'));
  await flush();
  assert.equal(f.video.currentTime, 8);
  f.click(root.getElementById("close-panel"));
  await flush();
  assert.equal(f.document.getElementById("biliskip-userscript-panel"), null);
  assert.equal(
    [...f.intervals.values()].some((timer) => timer.ms === 500),
    false,
  );
  f.window.history.pushState({}, "", "/video/BV1pFUDBKE8Y/");
  f.tick();
  assert.equal(f.document.querySelectorAll(".biliskip-native-marker").length, 0);
  await settle(
    () => f.document.getElementById("biliskip-userscript-root").dataset.state === "ready",
  );
  f.video.currentSrc = "media-second";
  f.video.dispatchEvent(new f.window.Event("loadedmetadata"));
  f.tick();
  assert.equal(f.document.querySelectorAll(".biliskip-native-marker").length, 2);
  assert.equal(
    f.document.getElementById("biliskip-userscript-root").dataset.video,
    "BV1pFUDBKE8Y:p1",
  );
  assert.equal(f.alerts.length, 0);
});

test("bundle menus configure a GM-only key and cleanup listeners/controllers on page exit", async () => {
  const f = browserFixture();
  try {
    await f.menu("BiliSkip · 设置");
    await settle(() => f.panel()?.getElementById("key-state").textContent.includes("已配置"));
    assert.equal(f.panel().getElementById("settings-panel").hidden, false);
    assert.equal(
      f.panel().getElementById("short-minutes").closest("section").id,
      "short-video-section",
    );
    assert.equal(
      f.panel().getElementById("setting-shortVideoExempt").closest("section").id,
      "short-video-section",
    );
    assert.notEqual(
      f.panel().getElementById("asr-concurrency").closest("section").id,
      "short-video-section",
    );
    f.setPrompt("different-synthetic-key");
    await f.menu("BiliSkip · 配置 DeepSeek Key");
    assert.equal(f.values.get("biliskip:v1:deepseekKey"), "different-synthetic-key");
    assert.equal(f.window.localStorage.length, 0);
    assert.doesNotMatch(f.panel().textContent, /different-synthetic-key/);
    await settle(() => f.changes.size === 2);
    f.window.dispatchEvent(new f.window.Event("pagehide"));
    assert.equal(f.intervals.size, 0);
    assert.equal(f.document.getElementById("biliskip-userscript-root"), null);
    assert.equal(f.document.getElementById("biliskip-userscript-panel"), null);
    assert.equal(f.changes.size, 0);
    assert.equal(f.menus.size, 0);
  } finally {
    f.dom.window.close();
  }
});

test("bundle starts in raw/default environments and yields playback ownership to an active Chrome extension", async (t) => {
  for (const sandboxMode of ["raw", undefined]) {
    const active = browserFixture({ info: { sandboxMode } });
    t.after(() => active.close());
    await settle(
      () => active.document.getElementById("biliskip-userscript-root")?.dataset.state === "ready",
    );
    await active.menu("BiliSkip · 打开面板");
    await settle(() => active.panel()?.getElementById("source").textContent === "DeepSeek Flash");
    assert.equal(active.menus.has("BiliSkip · 查看启动提示"), false);
    assert.equal(active.alerts.length, 0);
    assert.equal(active.values.get("biliskip:v1:deepseekKey"), "test-only-placeholder");
    assert.equal(
      active.requests.filter(({ details }) => details.url.includes("/chat/completions")).length,
      1,
    );
  }
  const existing = browserFixture({ extension: true });
  t.after(() => existing.close());
  await existing.menu("BiliSkip · 打开面板");
  await settle(() => existing.panel()?.getElementById("status").textContent.includes("Chrome 版"));
  assert.equal(existing.document.getElementById("biliskip-userscript-root"), null);
  assert.equal(existing.requests.length, 0);
});

test("BFCache restore recreates the userscript controller and reuses its saved model result", async (t) => {
  const f = browserFixture();
  t.after(() => f.close());
  await settle(
    () => f.document.getElementById("biliskip-userscript-root")?.dataset.state === "ready",
  );
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pagehide", { persisted: true }));
  assert.equal(f.intervals.size, 0);
  f.window.dispatchEvent(new f.window.PageTransitionEvent("pageshow", { persisted: true }));
  await settle(
    () => f.document.getElementById("biliskip-userscript-root")?.dataset.state === "ready",
  );
  f.tick();
  assert.equal(
    f.document.getElementById("biliskip-userscript-root").dataset.cacheSource,
    "local-cache",
  );
  assert.equal(
    f.requests.filter(({ details }) => details.url.includes("/chat/completions")).length,
    1,
  );
  assert.equal(f.document.querySelectorAll(".biliskip-native-marker").length, 2);
});

test("missing ASR resources leave the full subtitle, upload, marker, skip and cache paths working", async (t) => {
  let resourceReads = 0;
  const f = browserFixture({
    settings: { asrEnabled: true },
    gm: {
      getResourceUrl: async () => {
        resourceReads++;
        return undefined;
      },
    },
  });
  t.after(() => f.close());
  await settle(
    () => f.document.getElementById("biliskip-userscript-root")?.dataset.state === "ready",
  );
  assert.equal(resourceReads, 0, "subtitle analysis keeps optional resource reads lazy");
  await f.menu("BiliSkip · 设置");
  const root = f.panel();
  f.click(root.getElementById("check-asr-resources"));
  await settle(() => root.getElementById("asr-resource-status").dataset.state === "unavailable");
  assert.equal(resourceReads, 2);
  assert.equal(root.getElementById("setting-asrEnabled").disabled, true);
  assert.equal(root.getElementById("asr-resource-controls").disabled, true);
  assert.equal(root.getElementById("download-model").matches(":disabled"), true);
  assert.equal(root.getElementById("setting-asrUpload").disabled, false);
  assert.equal(root.getElementById("setting-consent").disabled, false);
  assert.equal(root.getElementById("setting-autoSkip").disabled, false);
  assert.equal(root.getElementById("setting-sharedRead").disabled, false);
  assert.equal(root.getElementById("check-asr-resources").disabled, false);
  assert.equal(f.values.get(SETTINGS_KEY).asrEnabled, true);
  assert.equal(f.menus.has("BiliSkip · 查看启动提示"), false);
  f.tick();
  assert.equal(f.document.querySelectorAll(".biliskip-native-marker").length, 2);
  f.video.currentTime = 12;
  f.video.dispatchEvent(new f.window.Event("seeked"));
  assert.equal(f.video.currentTime, 20.05);
  f.click(root.getElementById("undo"));
  await flush();
  assert.equal(f.video.currentTime, 12);
  f.click(root.getElementById("online"));
  await settle(() => {
    f.tick();
    return root.getElementById("source").textContent === "线上缓存";
  });
  assert.equal(
    f.requests.filter(({ details }) => details.url.includes("/chat/completions")).length,
    1,
  );
  f.window.history.pushState({}, "", "/video/BV1pFUDBKE8Y/");
  f.tick();
  await settle(
    () => f.document.getElementById("biliskip-userscript-root").dataset.state === "ready",
  );
  assert.equal(resourceReads, 2, "SPA subtitle reads keep the failed ASR dependency dormant");
  assert.equal(f.alerts.length, 0);

  // Test-only manager recovery using the real pinned assets, without an HTTP fallback.
  const urls = new Map();
  for (const asset of ASR_ASSETS) {
    const bytes = await readFile(
      new URL(`../../extension/asr/vendor/${asset.file}`, import.meta.url),
    );
    urls.set(asset.name, `data:application/octet-stream;base64,${bytes.toString("base64")}`);
  }
  f.gm.getResourceUrl = async (name) => urls.get(name);
  f.click(root.getElementById("check-asr-resources"));
  await settle(() => root.getElementById("asr-resource-status").dataset.state === "ready");
  assert.equal(root.getElementById("setting-asrEnabled").disabled, false);
  assert.equal(root.getElementById("setting-asrEnabled").checked, true);
  assert.equal(root.getElementById("asr-resource-controls").disabled, false);
  assert.equal(root.getElementById("download-model").matches(":disabled"), false);
  assert.equal(f.requests.filter(({ details }) => details.url.includes("/audio.m4a")).length, 0);
});

test("no-subtitle startup reports ASR-only degradation before audio or paid model requests", async (t) => {
  const f = browserFixture({
    settings: { asrEnabled: true },
    network: {
      handler: (details) =>
        new URL(details.url).pathname === "/x/player/wbi/v2"
          ? {
              status: 200,
              response: new TextEncoder().encode(
                JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }),
              ).buffer,
            }
          : undefined,
    },
  });
  t.after(() => f.close());
  await settle(
    () =>
      f.document.getElementById("biliskip-userscript-root")?.dataset.errorCode ===
      "ASR_UNAVAILABLE",
  );
  await f.menu("BiliSkip · 设置");
  assert.match(f.panel().getElementById("asr-resource-status").textContent, /当前页面暂停/);
  assert.equal(f.menus.has("BiliSkip · 查看启动提示"), false);
  assert.equal(
    f.requests.filter(({ details }) => /playurl|chat\/completions|audio\.m4a/.test(details.url))
      .length,
    0,
  );
  assert.equal(f.values.get(SETTINGS_KEY).asrEnabled, true);
});

test("model pre-download checks optional resources first and keeps cached-model inspection available", async (t) => {
  const f = browserFixture();
  t.after(() => f.close());
  await f.menu("BiliSkip · 设置");
  const root = f.panel();
  f.click(root.getElementById("download-model"));
  await settle(
    () =>
      root.getElementById("asr-resource-status").dataset.state === "unavailable" &&
      root.getElementById("model-status").textContent.includes("当前页面暂停"),
  );
  assert.equal(root.getElementById("download-model").matches(":disabled"), true);
  assert.equal(root.getElementById("check-model-cache").disabled, false);
  assert.equal(root.getElementById("cancel-model-download").hidden, true);
  assert.equal(
    f.requests.some(({ details }) => /\.onnx|\.wasm|support\.bin/.test(details.url)),
    false,
  );
});

test("combined shared-service and ASR-resource outages preserve analysis, local skip and keyless playback", async (t) => {
  for (const key of ["test-only-placeholder", ""]) {
    const f = browserFixture({
      key,
      settings: { asrEnabled: true },
      network: {
        handler: (details) =>
          new URL(details.url).hostname === "biliskipad.bakapiano.com"
            ? { status: 503, response: new ArrayBuffer(0) }
            : undefined,
      },
    });
    t.after(() => f.close());
    await settle(
      () =>
        f.document.getElementById("biliskip-userscript-root")?.dataset.state ===
        (key ? "ready" : "idle"),
    );
    await f.menu("BiliSkip · 设置");
    const root = f.panel();
    f.click(root.getElementById("check-asr-resources"));
    await settle(() => root.getElementById("asr-resource-status").dataset.state === "unavailable");
    assert.match(root.getElementById("status").textContent, /503/);
    assert.equal(f.menus.has("BiliSkip · 查看启动提示"), false);
    assert.equal(f.video.paused, false);
    assert.equal(root.getElementById("toggle").disabled, false);
    assert.equal(root.getElementById("setting-sharedRead").disabled, false);
    assert.equal(
      f.requests.filter(({ details }) => details.url.includes("/chat/completions")).length,
      key ? 1 : 0,
    );
    f.tick();
    if (key) {
      assert.equal(root.getElementById("source").textContent, "DeepSeek Flash");
      assert.equal(f.document.querySelectorAll(".biliskip-native-marker").length, 2);
      f.video.currentTime = 12;
      f.video.dispatchEvent(new f.window.Event("seeked"));
      assert.equal(f.video.currentTime, 20.05);
      f.click(root.getElementById("online"));
      await settle(() => {
        f.tick();
        return root.getElementById("source").textContent === "本地缓存";
      });
      assert.match(root.getElementById("status").textContent, /503/);
      assert.equal(f.document.querySelectorAll(".biliskip-native-marker").length, 2);
    } else {
      assert.equal(root.getElementById("source").textContent, "缓存模式");
      assert.equal(f.document.querySelectorAll(".biliskip-native-marker").length, 0);
      f.video.currentTime = 12;
      f.video.dispatchEvent(new f.window.Event("seeked"));
      assert.equal(f.video.currentTime, 12);
    }
    assert.equal(f.alerts.length, 0);
  }
});
