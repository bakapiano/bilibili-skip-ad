import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { petAssetsSource } from "../../scripts/build-pet-assets.js";
import { PET_DIALOGUES } from "../../extension/lib/pet-config.js";

const read = (name) => readFile(new URL(`../../extension/${name}`, import.meta.url), "utf8");
const stateSource = await read("pet-state.js");
const petSource = await read("pet.js");
const preset = await petAssetsSource();
const preview = preset.replace("enabled: false", "enabled: true");
const base = () => ({ video: { route: "video-a:p1" }, activityId: 1, busy: false, stage: "idle" });
const usage = { offPeakCny: 0.00075476, peakCny: 0.00150952, costCny: 0.00075476 };

function projector() {
  const sandbox = {};
  vm.runInNewContext(preset, sandbox);
  vm.runInNewContext(stateSource, sandbox);
  return sandbox.BiliSkipPetState();
}

test("pet assets reproduce the checked-in character and duck sounds for ordinary builds", async () => {
  assert.equal(await read("pet-assets.js"), preset);
  const sandbox = {};
  vm.runInNewContext(preset, sandbox);
  assert.equal(sandbox.BiliSkipPetAssets.enabled, false);
  assert.match(sandbox.BiliSkipPetAssets.image, /^data:image\/png;base64,/);
  const imageBytes = await readFile(new URL("../../assets/pet/character.png", import.meta.url));
  assert.equal(
    sandbox.BiliSkipPetAssets.image,
    `data:image/png;base64,${imageBytes.toString("base64")}`,
  );
  assert.equal(sandbox.BiliSkipPetAssets.soundName, "小黄鸭");
  for (const [index, name] of ["press.mp3", "release.mp3"].entries()) {
    const bytes = await readFile(new URL(`../../assets/pet/${name}`, import.meta.url));
    assert.equal(
      sandbox.BiliSkipPetAssets.sounds[index],
      `data:audio/mpeg;base64,${bytes.toString("base64")}`,
    );
  }
  assert.equal(
    await read("PET-ASSETS-NOTICE.md"),
    await readFile(new URL("../../assets/pet/NOTICE.md", import.meta.url), "utf8"),
  );
  assert.equal(sandbox.BiliSkipPetAssets.css, await read("pet.css"));
  assert.equal(sandbox.BiliSkipPetAssets.bubble, await read("icons/pet-bubble.svg"));
  assert.equal(sandbox.BiliSkipPetAssets.panelIcon, await read("icons/icon.svg"));
  assert.doesNotMatch(
    sandbox.BiliSkipPetAssets.bubble,
    /<script|<foreignObject|https?:\/\/(?!www.w3.org)/,
  );
});

test("pet costs only a newly observed job and cache refresh retains zero-call semantics", () => {
  const project = projector();
  const job = { id: "request-a", status: "running", stage: "model" };
  assert.equal(project({ ...base(), busy: true, analyzing: true, job }).mood, "working");
  const done = { ...job, status: "done", stage: "done", usage };
  const finished = project({ ...base(), job: done });
  assert.equal(finished.title, "大肥鱼吃了你 ¥0.00075476");
  assert.equal(finished.key, project({ ...base(), job: done }).key);
  const cache = project({
    ...base(),
    activityId: 2,
    job: done,
    record: { key: "r", source: "local-cache", usage },
  });
  assert.equal(cache.title, "");
  assert.doesNotMatch(cache.title, /0\.001510/);
  const restart = projector()({
    ...base(),
    job: done,
    record: { key: "r", source: "shared", usage },
  });
  assert.equal(restart.title, "");
});

test("pet isolates route changes, new jobs, exemptions, missing usage and safe text", () => {
  const project = projector();
  project({ ...base(), busy: true, job: { id: "a", status: "running", stage: "model" } });
  const changed = project({
    ...base(),
    video: { route: "video-b:p1" },
    record: { key: "r", source: "shared", usage },
    job: { id: "a", status: "done", stage: "done", usage },
  });
  assert.equal(changed.title, "");
  assert.equal(project({ video: null }).visible, false);
  assert.equal(project({ ...base(), exempt: true }).title, "");
  const busy = {
    ...base(),
    busy: true,
    job: { id: "b", status: "running", stage: "asr-transcribe" },
  };
  assert.equal(project(busy).title, "恰饭片段寻找中...");
  const error = project({
    ...base(),
    stage: "error",
    message: "<script>secret</script>",
    job: { id: "b", status: "error" },
  });
  assert.equal(error.title, "搞不定啦！打开面板自己看一下~");
  assert.doesNotMatch(error.title, /secret|script/);
  assert.equal(
    project({
      ...base(),
      job: { id: "b", status: "done", stage: "done", usage: { offPeakCny: NaN, peakCny: -1 } },
    }).title,
    "",
  );
});

const automaticSkip = (id = 1, seconds = 8) => ({
  id,
  automatic: true,
  route: "video-a:p1",
  seconds,
});

test("pet announces each new automatic skip after a model result and ignores repeated snapshots", () => {
  const project = projector();
  const job = { id: "request-a", status: "running", stage: "model" };
  project({ ...base(), busy: true, job });
  const done = { ...base(), job: { ...job, status: "done", stage: "done", usage } };
  assert.match(project(done).title, /^大肥鱼吃了你 ¥/);
  const skipped = { ...done, player: { lastSkip: automaticSkip() } };
  const first = project(skipped);
  assert.equal(first.title, "跳过 8 秒恰饭片段~ 吃点白饭不过分吧！");
  assert.equal(Object.hasOwn(first, "detail"), false);
  assert.equal(first.persistent, false);
  assert.equal(project(skipped).key, first.key);
  const second = project({ ...done, player: { lastSkip: automaticSkip(2, 49.73) } });
  assert.notEqual(second.key, first.key);
  assert.match(second.title, /49\.7 秒/);
});

test("skip dialogue isolates manual actions, old routes, refresh, undo and later task states", () => {
  const skipped = { ...base(), player: { lastSkip: automaticSkip() } };
  assert.notEqual(projector()(skipped).scene, "skip");
  const project = projector();
  project(base());
  assert.equal(project(skipped).scene, "skip");
  assert.notEqual(project({ ...skipped, activityId: 2 }).scene, "skip");
  assert.notEqual(project({ ...skipped, video: { route: "video-b:p1" } }).scene, "skip");
  project(base());
  const invalid = [
    { ...automaticSkip(2), automatic: false },
    { ...automaticSkip(3), route: "video-b:p1" },
    automaticSkip(4, NaN),
    automaticSkip(5, -1),
    automaticSkip(6, 0),
  ];
  for (const lastSkip of invalid) {
    assert.notEqual(project({ ...base(), player: { lastSkip } }).scene, "skip");
  }
  assert.equal(project(skipped).scene, "skip");
  assert.notEqual(project(base()).scene, "skip", "undo clears the notice");
  project(skipped);
  assert.equal(project({ ...skipped, stage: "error" }).mood, "error");
  assert.notEqual(project(skipped).scene, "skip");
  project({ ...base(), player: { lastSkip: automaticSkip(10) } });
  assert.equal(
    project({ ...base(), player: { lastSkip: automaticSkip(10) }, busy: true, analyzing: true })
      .mood,
    "working",
  );
});

test("automatic skip during cache application survives task completion", () => {
  const project = projector();
  project({ ...base(), busy: true, stage: "loading" });
  const skipped = {
    ...base(),
    record: { key: "cached", source: "shared" },
    player: { lastSkip: automaticSkip() },
  };
  const first = project({ ...skipped, busy: true });
  assert.equal(first.title, "跳过 8 秒恰饭片段~ 吃点白饭不过分吧！");
  assert.equal(project({ ...skipped, busy: true }).key, first.key);
  assert.equal(project(skipped).key, first.key);
  assert.equal(project({ ...skipped, busy: true, analyzing: true }).mood, "working");
});

function fixture(t, enabled = true, { ResizeObserver, initialState = base() } = {}) {
  const dom = new JSDOM("<body><main>视频页面</main></body>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "https://www.bilibili.com/video/BV1Lmd2BAEad/",
  });
  const { window } = dom;
  if (ResizeObserver) {
    window.ResizeObserver = ResizeObserver;
  }
  const callbacks = new Map();
  // Test-only clock keeps bubble dismissal and pointer races deterministic.
  let clock = 0;
  let nextTimer = 0;
  const timers = new Map();
  window.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: clock + delay });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  const original = window.EventTarget.prototype.addEventListener;
  window.EventTarget.prototype.addEventListener = function (type, callback, options) {
    // Test-only trusted-input stand-in; real production handlers inspect browser isTrusted.
    if (!callbacks.has(this)) {
      callbacks.set(this, new Map());
    }
    const map = callbacks.get(this);
    if (!map.has(type)) {
      map.set(type, []);
    }
    map.get(type).push(callback);
    return original.call(this, type, callback, options);
  };
  for (const code of [enabled ? preview : preset, stateSource, petSource]) {
    window.eval(code);
  }
  let listener;
  let unsubscribed = 0;
  let opened = 0;
  const api = window.BiliSkipPet({
    observe(fn) {
      listener = fn;
      fn(initialState);
      return () => {
        unsubscribed++;
      };
    },
    openPanel() {
      opened++;
    },
  });
  t.after(() => {
    api.destroy();
    window.close();
  });
  const emit = (node, type, fields = {}) => {
    for (const fn of callbacks.get(node)?.get(type) || []) {
      fn({
        isTrusted: true,
        button: 0,
        pointerId: 1,
        clientX: 600,
        clientY: 600,
        stopPropagation() {},
        ...fields,
      });
    }
  };
  return {
    window,
    api,
    emit,
    update: (state) => listener(state),
    opened: () => opened,
    unsubscribed: () => unsubscribed,
    tick(ms) {
      clock += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

test("pet trusted press/release, dragging, panel action, fullscreen and teardown", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const host = doc.querySelector(".biliskip-pet");
  const body = doc.querySelector(".biliskip-pet-body");
  const open = doc.querySelector(".biliskip-pet-open");
  host.getBoundingClientRect = () => ({ left: 500, top: 500, width: 160, height: 160 });
  f.emit(body, "pointerdown", { isTrusted: false });
  assert.equal(host.dataset.pressed, "false");
  f.emit(body, "pointerdown");
  assert.equal(host.dataset.pressed, "false");
  f.emit(body, "pointermove", { clientX: 300, clientY: 450 });
  assert.equal(host.style.left, "200px");
  assert.equal(host.dataset.left, "true");
  f.emit(body, "pointerup");
  assert.equal(host.dataset.pressed, "false");
  open.click();
  assert.equal(f.opened(), 0);
  f.emit(open, "click");
  assert.equal(f.opened(), 1);
  Object.defineProperty(doc, "fullscreenElement", { value: doc.body, configurable: true });
  doc.dispatchEvent(new f.window.Event("fullscreenchange"));
  assert.equal(host.hidden, true);
  Object.defineProperty(doc, "fullscreenElement", { value: null, configurable: true });
  doc.dispatchEvent(new f.window.Event("fullscreenchange"));
  assert.equal(host.hidden, false);
  f.update({ video: null });
  assert.equal(host.hidden, true);
  f.update(base());
  f.emit(doc.querySelector(".biliskip-pet-hide"), "click");
  assert.equal(host.hidden, true);
  f.update({ ...base(), record: { key: "cache", source: "shared" } });
  assert.equal(host.hidden, true);
  f.api.destroy();
  assert.equal(doc.querySelector(".biliskip-pet"), null);
  assert.equal(f.unsubscribed(), 1);
});

test("disabled preset can be enabled live from settings", (t) => {
  const f = fixture(t, false);
  assert.equal(f.window.document.querySelector(".biliskip-pet"), null);
  assert.equal(f.unsubscribed(), 0);
  f.update({ ...base(), settings: { petEnabled: true } });
  assert.equal(f.window.document.querySelectorAll(".biliskip-pet").length, 1);
  f.update({ ...base(), settings: { petEnabled: false } });
  assert.equal(f.window.document.querySelector(".biliskip-pet"), null);
});

test("pending settings keep the preview hidden and the first reveal uses the saved mirror layout", (t) => {
  const pending = { ...base(), settingsReady: false, settings: { petEnabled: true } };
  const f = fixture(t, true, { initialState: pending });
  const doc = f.window.document;
  assert.equal(doc.querySelector(".biliskip-pet"), null);
  f.update({ ...pending, busy: true, stage: "loading" });
  f.update({ ...pending, stage: "error" });
  assert.equal(doc.querySelector(".biliskip-pet"), null);
  const appended = [];
  const append = doc.body.append.bind(doc.body);
  // Test-only insertion observation catches a visible default layout before the first render.
  doc.body.append = (...nodes) => {
    for (const node of nodes) {
      if (node.className === "biliskip-pet") {
        appended.push(node.hidden);
      }
    }
    append(...nodes);
  };
  f.update({
    ...base(),
    settingsReady: true,
    settings: { petEnabled: true, petMirror: true, petPanelLabel: "查看结果" },
  });
  const host = doc.querySelector(".biliskip-pet");
  assert.deepEqual(appended, [true]);
  assert.equal(host.hidden, false);
  assert.equal(host.dataset.mirrored, "true");
  assert.equal(host.style.left, "0px");
  assert.equal(host.style.bottom, "0px");
  assert.equal(host.querySelector(".biliskip-pet-panel-label").textContent, "查看结果");
  assert.equal(host.querySelector(".biliskip-pet-panel-icon").getAttribute("aria-hidden"), "true");
  assert.equal(
    host.querySelector(".biliskip-pet-panel-icon svg").getAttribute("viewBox"),
    "0 0 256 256",
  );
});

test("loaded disabled settings keep the preview absent until a later explicit enable", (t) => {
  const f = fixture(t, true, { initialState: { ...base(), settingsReady: false } });
  const doc = f.window.document;
  assert.equal(doc.querySelector(".biliskip-pet"), null);
  f.update({ ...base(), settingsReady: true, settings: { petEnabled: false, petMirror: true } });
  assert.equal(doc.querySelector(".biliskip-pet"), null);
  f.update({ ...base(), settingsReady: true, settings: { petEnabled: true, petMirror: true } });
  assert.equal(doc.querySelectorAll(".biliskip-pet").length, 1);
  assert.equal(doc.querySelector(".biliskip-pet").dataset.mirrored, "true");
});

test("thought bubble uses an oval and two decorative dots with centered live text", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const bubble = doc.querySelector(".biliskip-pet-bubble");
  const svg = bubble.querySelector("svg");
  assert.equal(svg.getAttribute("viewBox"), "0 0 300 220");
  assert.equal(svg.getAttribute("aria-hidden"), "true");
  assert.equal(svg.getAttribute("stroke"), "#7298ca");
  assert.equal(svg.getAttribute("stroke-width"), "2");
  assert.equal(svg.querySelectorAll("path").length, 1);
  assert.equal(svg.querySelectorAll("ellipse").length, 2);
  assert.ok(svg.querySelector(".biliskip-pet-bubble-main"));
  assert.ok(svg.querySelector(".biliskip-pet-bubble-dot-small"));
  assert.ok(svg.querySelector(".biliskip-pet-bubble-dot-large"));
  assert.equal(bubble.getAttribute("role"), "status");
  assert.equal(
    bubble.querySelector(".biliskip-pet-title").parentElement.className,
    "biliskip-pet-bubble-content",
  );
});

test("panel logo and label share a centered row with matching single-line heights", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const style = (selector) => f.window.getComputedStyle(doc.querySelector(selector));
  assert.equal(style(".biliskip-pet-open").width, "100%");
  assert.equal(style(".biliskip-pet-open").justifyContent, "center");
  assert.equal(style(".biliskip-pet-open").alignItems, "center");
  assert.equal(style(".biliskip-pet-panel-label").lineHeight, "16px");
  assert.equal(style(".biliskip-pet-panel-label").textAlign, "center");
  assert.equal(style(".biliskip-pet-panel-icon").flexShrink, "0");
  assert.equal(style(".biliskip-pet-panel-icon").height, "16px");
});

test("thought bubble remains inside a narrow viewport while the pet is dragged", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const host = doc.querySelector(".biliskip-pet");
  const bubble = doc.querySelector(".biliskip-pet-bubble");
  const body = doc.querySelector(".biliskip-pet-body");
  Object.defineProperty(f.window, "innerWidth", { value: 360, configurable: true });
  host.getBoundingClientRect = () => ({
    left: Number.parseFloat(host.style.left) || 176,
    top: Number.parseFloat(host.style.top) || 500,
    width: 160,
    height: 160,
  });
  f.emit(body, "pointerdown");
  f.emit(body, "pointermove", { clientX: 570, clientY: 280 });
  const rect = host.getBoundingClientRect();
  assert.ok(rect.left + Number.parseFloat(bubble.style.left) >= 12);
  assert.ok(rect.left + Number.parseFloat(bubble.style.left) + 260 <= 348);
  assert.ok(rect.top + Number.parseFloat(bubble.style.top) >= 12);
});

test("bubble prefers the right in both mirror modes and switches only when the right cannot fit", (t) => {
  const f = fixture(t);
  const host = f.window.document.querySelector(".biliskip-pet");
  const bubble = host.querySelector(".biliskip-pet-bubble");
  Object.defineProperty(f.window, "innerWidth", { value: 1000, configurable: true });
  let left = 200;
  host.getBoundingClientRect = () => ({ left, top: 500, width: 160, height: 160 });
  for (const petMirror of [false, true]) {
    f.update({ ...base(), settings: { petMirror } });
    for (const [position, side, offset] of [
      [200, "right", "24px"],
      [704, "right", "24px"],
      [705, "left", "-124px"],
      [0, "right", "24px"],
    ]) {
      left = position;
      f.emit(f.window, "resize");
      assert.equal(host.dataset.bubbleSide, side);
      assert.equal(bubble.style.left, offset);
    }
  }
  left = 100;
  Object.defineProperty(f.window, "innerWidth", { value: 360, configurable: true });
  f.emit(f.window, "resize");
  assert.equal(host.dataset.bubbleSide, "left");
  assert.ok(left + Number.parseFloat(bubble.style.left) >= 12);
  assert.ok(left + Number.parseFloat(bubble.style.left) + 260 <= 348);
});

test("thought bubble gives a full six seconds after dragging and can be reopened", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const body = doc.querySelector(".biliskip-pet-body");
  const bubble = doc.querySelector(".biliskip-pet-bubble");
  f.tick(5000);
  f.emit(body, "pointerdown");
  f.emit(body, "pointermove", { clientX: 300 });
  f.tick(10000);
  assert.equal(bubble.hidden, false);
  f.emit(body, "pointerup");
  f.tick(5999);
  assert.equal(bubble.hidden, false);
  f.tick(1);
  assert.equal(bubble.hidden, true);
  f.emit(body, "pointerdown");
  f.emit(body, "pointerup");
  f.emit(body, "click");
  assert.equal(bubble.hidden, false);
  f.tick(6000);
  assert.equal(bubble.hidden, true);
});

test("completion during dragging starts its dismissal timer on pointer release", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const body = doc.querySelector(".biliskip-pet-body");
  const bubble = doc.querySelector(".biliskip-pet-bubble");
  const job = { id: "dragged-job", status: "running", stage: "model" };
  f.update({ ...base(), busy: true, analyzing: true, job });
  f.tick(10000);
  assert.equal(bubble.hidden, false);
  f.emit(body, "pointerdown");
  f.emit(body, "pointermove", { clientX: 300 });
  f.update({ ...base(), job: { ...job, status: "done", stage: "done", usage } });
  assert.match(bubble.textContent, /大肥鱼吃了你/);
  f.tick(10000);
  assert.equal(bubble.hidden, false);
  f.emit(body, "pointercancel");
  f.tick(5999);
  assert.equal(bubble.hidden, false);
  // Browser capture cleanup follows release and keeps the original deadline.
  f.emit(body, "lostpointercapture");
  f.tick(1);
  assert.equal(bubble.hidden, true);
});

test("automatic skip reopens the bubble once, expires after six seconds and repeats for a new skip", (t) => {
  const f = fixture(t);
  const bubble = f.window.document.querySelector(".biliskip-pet-bubble");
  f.tick(6000);
  assert.equal(bubble.hidden, true);
  const skipped = { ...base(), player: { lastSkip: automaticSkip() } };
  f.update(skipped);
  assert.equal(bubble.hidden, false);
  assert.match(bubble.textContent, /跳过 8 秒/);
  f.tick(5000);
  f.update(skipped);
  f.tick(1000);
  assert.equal(bubble.hidden, true);
  f.update(skipped);
  assert.equal(bubble.hidden, true);
  f.update({ ...base(), player: { lastSkip: automaticSkip(2) } });
  assert.equal(bubble.hidden, false);
});

test("custom captions cover every scene, substitute runtime values and preserve task identities", () => {
  const project = projector();
  const petDialogues = Object.fromEntries(
    Object.keys(PET_DIALOGUES).map((scene) => [scene, { title: `自定义 ${scene}` }]),
  );
  const state = (extra = {}) => ({ ...base(), settings: { petDialogues }, ...extra });
  for (const [scene, extra] of [
    ["idle", {}],
    ["loading", { busy: true }],
    ["analyzing", { busy: true, analyzing: true }],
    ["asr", { busy: true, stage: "asr-transcribe" }],
    ["exempt", { exempt: true }],
    ["record", { record: { key: "r", source: "manual" } }],
    ["error", { stage: "error" }],
  ]) {
    assert.equal(project(state(extra)).title, `自定义 ${scene}`);
  }
  project(state({ busy: true, job: { id: "custom", status: "running" } }));
  for (const [scene, extra] of [
    ["done", { status: "done", stage: "done", usage }],
    ["doneUnknown", { status: "done", stage: "done" }],
    ["error", { status: "error", usage }],
    ["error", { status: "error" }],
  ]) {
    assert.equal(project(state({ job: { id: "custom", ...extra } })).title, `自定义 ${scene}`);
  }
  petDialogues.skip.title = "已经跳过 {seconds} 秒！";
  const first = project(state({ player: { lastSkip: automaticSkip(20, 35.7) } }));
  assert.equal(first.title, "已经跳过 35.7 秒！");
  petDialogues.skip.title = "新标题";
  const second = project(state({ player: { lastSkip: automaticSkip(20, 35.7) } }));
  assert.equal(second.key, first.key);
  assert.equal(second.title, "新标题");
});

test("pet live preferences mirror placement, change image and render captions strictly as text", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const settings = {
    petMirror: true,
    petImage: "data:image/png;base64,invalid-test-image",
    petPanelLabel: "查看结果",
    petDialogues: { idle: { title: "<img src=x>" } },
  };
  f.update({ ...base(), settings });
  const host = doc.querySelector(".biliskip-pet");
  assert.equal(host.style.left, "0px");
  assert.equal(host.dataset.mirrored, "true");
  assert.equal(doc.querySelector(".biliskip-pet-title img"), null);
  assert.equal(doc.querySelector(".biliskip-pet-title").textContent, "<img src=x>");
  assert.equal(doc.querySelector(".biliskip-pet-panel-label").textContent, "查看结果");
  assert.ok(doc.querySelector(".biliskip-pet-panel-icon svg"));
  const portrait = doc.querySelector(".biliskip-pet-image");
  assert.equal(portrait.src, settings.petImage);
  f.emit(portrait, "error");
  assert.equal(portrait.src, f.window.BiliSkipPetAssets.image);
  f.update({ ...base(), settings: { ...settings, petMirror: false } });
  assert.equal(host.style.right, "24px");
  assert.equal(host.dataset.mirrored, "false");
});

test("mirroring moves the close button to the left and every task state keeps the bottom anchor", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const host = doc.querySelector(".biliskip-pet");
  const hide = doc.querySelector(".biliskip-pet-hide");
  const states = [
    {},
    { busy: true, analyzing: true },
    { busy: true, stage: "asr-transcribe" },
    { stage: "error" },
    { record: { key: "cached", source: "shared" } },
    { exempt: true },
    { player: { lastSkip: automaticSkip() } },
  ];
  for (const petMirror of [false, true, false]) {
    for (const state of states) {
      f.update({ ...base(), ...state, settings: { petMirror } });
      const style = f.window.getComputedStyle(hide);
      assert.equal(style.left, petMirror ? "0px" : "auto");
      assert.equal(style.right, petMirror ? "auto" : "0px");
      assert.equal(host.style.bottom, "0px");
      assert.equal(host.style.left, petMirror ? "0px" : "auto");
    }
  }
  const imageStyle = f.window.getComputedStyle(doc.querySelector(".biliskip-pet-image"));
  assert.equal(imageStyle.transformOrigin, "50% 100%");
  assert.equal(imageStyle.objectPosition, "center bottom");
});

test("dragging reaches both screen edges and keeps a bottom-docked pet aligned after resize", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const host = doc.querySelector(".biliskip-pet");
  const body = doc.querySelector(".biliskip-pet-body");
  Object.defineProperty(f.window, "innerWidth", { value: 360, configurable: true });
  Object.defineProperty(f.window, "innerHeight", { value: 640, configurable: true });
  host.getBoundingClientRect = () => ({ left: 100, top: 300, width: 160, height: 160 });
  for (const [clientX, expectedLeft] of [
    [-1000, "0px"],
    [2000, "200px"],
  ]) {
    f.emit(body, "pointerdown");
    f.emit(body, "pointermove", { clientX, clientY: 2000 });
    f.emit(body, "pointerup");
    assert.equal(host.style.left, expectedLeft);
    assert.equal(host.style.top, "auto");
    assert.equal(host.style.bottom, "0px");
  }
  Object.defineProperty(f.window, "innerHeight", { value: 900, configurable: true });
  f.emit(f.window, "resize");
  assert.equal(host.style.top, "auto");
  assert.equal(host.style.bottom, "0px");
  Object.defineProperty(f.window, "innerHeight", { value: 250, configurable: true });
  f.emit(f.window, "resize");
  assert.equal(host.style.bottom, "0px");
  const bubble = doc.querySelector(".biliskip-pet-bubble");
  assert.ok(Number.parseFloat(bubble.style.height) <= 226);
});

function audioFixture(window) {
  const sources = [];
  const gains = [];
  let closed = 0;
  // Test-only Web Audio graph: tracks scheduling/cleanup without hardware playback.
  window.AudioContext = class {
    currentTime = 10;
    async resume() {}
    async decodeAudioData() {
      return { duration: 0.1 };
    }
    createGain() {
      const node = {
        gain: { value: 0 },
        connect() {},
        disconnect() {
          node.disconnected = true;
        },
      };
      gains.push(node);
      return node;
    }
    createBufferSource() {
      const node = {
        connect() {},
        disconnect() {},
        start(time) {
          node.started = time;
        },
        stop() {
          node.stopped = true;
        },
      };
      sources.push(node);
      return node;
    }
    async close() {
      closed++;
    }
  };
  return { sources, gains, closed: () => closed };
}

test("completed clicks pat and play at the selected volume; dragging and synthetic clicks stay quiet", async (t) => {
  const f = fixture(t);
  const audio = audioFixture(f.window);
  const host = f.window.document.querySelector(".biliskip-pet");
  const body = host.querySelector(".biliskip-pet-body");
  f.update({ ...base(), settings: { petVolume: 35 } });
  for (const type of ["pointerdown", "pointerup", "click"]) {
    f.emit(body, type);
  }
  assert.equal(host.dataset.pressed, "true");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.sources.length, 2);
  assert.equal(audio.gains[0].gain.value, 0.35);
  f.tick(110);
  assert.equal(host.dataset.pressed, "false");
  f.emit(body, "pointerdown");
  f.emit(body, "pointermove", { clientX: 400 });
  f.emit(body, "pointerup");
  f.emit(body, "click");
  assert.equal(host.dataset.pressed, "false");
  assert.equal(audio.sources[0].stopped, true);
  assert.equal(audio.gains[0].disconnected, true);
  f.emit(body, "pointerdown");
  f.emit(body, "pointerup");
  f.emit(body, "click", { isTrusted: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.sources.length, 2);
  f.update({ ...base(), settings: { petSound: false } });
  f.emit(body, "click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.sources.length, 2);
  f.api.destroy();
  assert.equal(audio.closed(), 1);
});

test("pending audio decode is invalidated by dragging, hiding and disabling the pet", async (t) => {
  const f = fixture(t);
  const audio = audioFixture(f.window);
  const doc = f.window.document;
  const body = doc.querySelector(".biliskip-pet-body");
  f.emit(body, "click");
  f.emit(body, "pointerdown");
  f.emit(body, "pointermove", { clientX: 400 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.sources.length, 0);
  f.emit(body, "pointerup");
  f.emit(body, "keydown", { key: "Enter" });
  f.emit(body, "click");
  f.emit(doc.querySelector(".biliskip-pet-hide"), "click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.sources.length, 0);
  f.update({ ...base(), settings: { petEnabled: false } });
  assert.equal(audio.closed(), 1);
});

test("long multiline captions use a bounded scroll area inside the visible bubble", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const host = doc.querySelector(".biliskip-pet");
  const bubble = doc.querySelector(".biliskip-pet-bubble");
  const content = doc.querySelector(".biliskip-pet-bubble-content");
  Object.defineProperty(f.window, "innerWidth", { value: 360, configurable: true });
  Object.defineProperty(f.window, "innerHeight", { value: 640, configurable: true });
  Object.defineProperty(content, "scrollHeight", { value: 600, configurable: true });
  host.getBoundingClientRect = () => ({ left: 24, top: 460, width: 160, height: 160 });
  f.update({
    ...base(),
    settings: { petMirror: true, petDialogues: { idle: { title: "多行\n".repeat(30) } } },
  });
  assert.equal(bubble.style.height, "420px");
  assert.equal(content.style.overflowY, "auto");
  assert.equal(content.style.justifyContent, "flex-start");
  const top = 460 + Number.parseFloat(bubble.style.top);
  assert.ok(top >= 12 && top + 420 <= 628);
  Object.defineProperty(content, "scrollHeight", { value: 60, configurable: true });
  f.update(base());
  assert.equal(content.style.overflowY, "");
});

test("all failures share one caption and override a previously completed live job", () => {
  const project = projector();
  project({ ...base(), busy: true, job: { id: "error-shared", status: "running" } });
  for (const job of [
    undefined,
    { id: "error-shared", status: "error" },
    { id: "error-shared", status: "error", usage },
    { id: "error-shared", status: "done", stage: "done", usage },
  ]) {
    const result = project({ ...base(), stage: "error", job });
    assert.equal(result.scene, "error");
    assert.equal(result.title, "搞不定啦！打开面板自己看一下~");
    assert.doesNotMatch(result.title, /¥/);
  }
});

test("empty captions quietly hide the bubble while keeping the pet visible", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const bubble = doc.querySelector(".biliskip-pet-bubble");
  f.update({ ...base(), exempt: true });
  assert.equal(bubble.hidden, true);
  assert.equal(doc.querySelector(".biliskip-pet").hidden, false);
  f.emit(doc.querySelector(".biliskip-pet-body"), "click");
  assert.equal(bubble.hidden, false);
  assert.equal(doc.querySelector(".biliskip-pet-title").textContent, "好模型...");
  f.update({ ...base(), stage: "error" });
  assert.equal(bubble.hidden, false);
});

test("custom click audio replaces the duck pair and restoring defaults invalidates its buffer", async (t) => {
  const f = fixture(t);
  const audio = audioFixture(f.window);
  const body = f.window.document.querySelector(".biliskip-pet-body");
  f.update({ ...base(), settings: { petAudio: f.window.BiliSkipPetAssets.sounds[0] } });
  f.emit(body, "click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.sources.length, 1);
  f.update({ ...base(), settings: { petAudio: "" } });
  assert.equal(audio.sources[0].stopped, true);
  f.emit(body, "click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.sources.length, 3);
});

test("default click volume is ten percent", async (t) => {
  const f = fixture(t);
  const audio = audioFixture(f.window);
  f.emit(f.window.document.querySelector(".biliskip-pet-body"), "click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.gains[0].gain.value, 0.1);
});

test("both cache sources stay silent even with legacy overrides, while automatic skip still announces", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  for (const source of ["shared", "local-cache"]) {
    const cached = {
      ...base(),
      activityId: source,
      record: { key: "cached", source },
      settings: {
        petDialogues: { shared: { title: "旧共享提示" }, local: { title: "旧本地提示" } },
      },
    };
    f.update(cached);
    assert.equal(doc.querySelector(".biliskip-pet-title").textContent, "");
    assert.equal(doc.querySelector(".biliskip-pet-bubble").hidden, true);
    assert.equal(doc.querySelector(".biliskip-pet").hidden, false);
    f.emit(doc.querySelector(".biliskip-pet-body"), "click");
    assert.equal(doc.querySelector(".biliskip-pet-bubble").hidden, false);
    assert.equal(doc.querySelector(".biliskip-pet-title").textContent, "好模型...");
    f.update({ ...cached, player: { lastSkip: automaticSkip() } });
    assert.match(doc.querySelector(".biliskip-pet-title").textContent, /跳过 8 秒/);
    assert.equal(doc.querySelector(".biliskip-pet-bubble").hidden, false);
  }
});

test("clicking after a skip shows idle text and repeated snapshots preserve it until a new event", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const body = doc.querySelector(".biliskip-pet-body");
  const title = doc.querySelector(".biliskip-pet-title");
  const bubble = doc.querySelector(".biliskip-pet-bubble");
  const skipped = { ...base(), player: { lastSkip: automaticSkip() } };
  f.update(skipped);
  assert.match(title.textContent, /跳过 8 秒/);
  f.emit(body, "click");
  assert.equal(title.textContent, "好模型...");
  f.tick(5000);
  f.update(skipped);
  assert.equal(title.textContent, "好模型...");
  f.tick(1000);
  assert.equal(bubble.hidden, true);
  f.update({ ...base(), player: { lastSkip: automaticSkip(2, 12) } });
  assert.match(title.textContent, /跳过 12 秒/);
  assert.equal(bubble.hidden, false);
});

test("manual idle uses current custom text and keeps live-job fee tracking intact", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const body = doc.querySelector(".biliskip-pet-body");
  const title = doc.querySelector(".biliskip-pet-title");
  const bubble = doc.querySelector(".biliskip-pet-bubble");
  const settings = { petDialogues: { idle: { title: "自定义待机" } } };
  const job = { id: "click-during-job", status: "running", stage: "model" };
  const working = { ...base(), settings, busy: true, analyzing: true, job };
  f.update(working);
  f.emit(body, "click");
  assert.equal(title.textContent, "自定义待机");
  settings.petDialogues.idle.title = "新待机";
  f.update(working);
  assert.equal(title.textContent, "新待机");
  f.tick(6000);
  assert.equal(bubble.hidden, true);
  f.update({ ...base(), settings, job: { ...job, status: "done", stage: "done", usage } });
  assert.equal(title.textContent, "大肥鱼吃了你 ¥0.00075476");
  f.emit(body, "click");
  assert.equal(title.textContent, "新待机");
  f.update({ ...base(), settings, stage: "error" });
  assert.equal(title.textContent, "搞不定啦！打开面板自己看一下~");
  settings.petDialogues.idle.title = "";
  f.emit(body, "click");
  assert.equal(title.textContent, "");
  assert.equal(bubble.hidden, true);
});

test("right dragging and bubble placement reserve the classic and overlay scrollbar strips", (t) => {
  const f = fixture(t);
  const doc = f.window.document;
  const host = doc.querySelector(".biliskip-pet");
  const body = host.querySelector(".biliskip-pet-body");
  Object.defineProperty(f.window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(doc.documentElement, "clientWidth", { value: 982, configurable: true });
  Object.defineProperty(doc.documentElement, "clientHeight", { value: 700, configurable: true });
  Object.defineProperty(doc.documentElement, "scrollHeight", { value: 1400, configurable: true });
  host.getBoundingClientRect = () => ({
    left: Number.parseFloat(host.style.left) || 200,
    top: 500,
    width: 160,
    height: 160,
  });
  f.emit(body, "pointerdown");
  f.emit(body, "pointermove", { clientX: 2000 });
  f.emit(body, "pointerup");
  assert.equal(host.style.left, "810px");
  const bubble = host.querySelector(".biliskip-pet-bubble");
  assert.ok(
    810 + Number.parseFloat(bubble.style.left) + Number.parseFloat(bubble.style.width) <= 970,
  );
  Object.defineProperty(doc.documentElement, "clientWidth", { value: 1000, configurable: true });
  f.emit(f.window, "resize");
  assert.equal(host.style.left, "816px");
  Object.defineProperty(doc.documentElement, "scrollHeight", { value: 700, configurable: true });
  f.emit(f.window, "resize");
  assert.equal(host.style.left, "840px");
  f.emit(body, "pointerdown");
  f.emit(body, "pointermove", { clientX: -2000, clientY: 2000 });
  f.emit(body, "pointerup");
  assert.equal(host.style.left, "0px");
  assert.equal(host.style.bottom, "0px");
});

test("scrollbar changes re-clamp the right edge and its observer is cleaned up", (t) => {
  let changed;
  let disconnected = false;
  // Test-only observer drives viewport changes without native layout or timers.
  const f = fixture(t, true, {
    ResizeObserver: class {
      constructor(callback) {
        changed = callback;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  });
  const doc = f.window.document;
  const host = doc.querySelector(".biliskip-pet");
  const body = host.querySelector(".biliskip-pet-body");
  Object.defineProperty(f.window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(doc.documentElement, "clientWidth", { value: 1000, configurable: true });
  host.getBoundingClientRect = () => ({ left: 200, top: 500, width: 160, height: 160 });
  f.emit(body, "pointerdown");
  f.emit(body, "pointermove", { clientX: 2000, clientY: 2000 });
  f.emit(body, "pointerup");
  assert.equal(host.style.left, "840px");
  Object.defineProperty(doc.documentElement, "clientWidth", { value: 970, configurable: true });
  changed();
  assert.equal(host.style.left, "798px");
  assert.equal(host.style.bottom, "0px");
  f.api.destroy();
  assert.equal(disconnected, true);
  Object.defineProperty(doc.documentElement, "clientWidth", { value: 930, configurable: true });
  changed();
  assert.equal(host.style.left, "798px");
});
