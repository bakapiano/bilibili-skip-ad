import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { bindSectionNavigation } from "../../extension/lib/section-navigation.js";

const html = await readFile(new URL("../../extension/options.html", import.meta.url), "utf8");
const ids = [
  "model-section",
  "asr-section",
  "short-video-section",
  "playback-section",
  "pet-section",
  "shared-section",
  "cache-section",
];

function fixture(t) {
  // Deterministic scroll geometry: real DOM and navigation binding, no privileged API calls.
  const dom = new JSDOM(html, {
    url: "https://example.test/options.html",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  const nav = document.getElementById("settings-nav");
  let offset = 0;
  let observe;
  let disconnected = false;
  let nextFrame = 0;
  const frames = new Map();
  window.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.ResizeObserver = class {
    constructor(callback) {
      observe = callback;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  };
  Object.defineProperty(window, "scrollY", { get: () => offset });
  Object.defineProperty(window, "innerHeight", { value: 600 });
  Object.defineProperty(document.documentElement, "scrollHeight", { value: 3500 });
  document.querySelector(".save-bar").getBoundingClientRect = () => ({ bottom: 52 });
  ids.forEach((id, index) => {
    const section = document.getElementById(id);
    section.style.scrollMarginTop = "84px";
    section.getBoundingClientRect = () => ({ top: 160 + index * 500 - offset });
  });
  const stop = bindSectionNavigation(nav);
  t.after(() => {
    stop();
    window.close();
  });
  const flush = () => {
    const tasks = [...frames.values()];
    frames.clear();
    for (const task of tasks) {
      task();
    }
  };
  const scroll = (value) => {
    offset = value;
    window.dispatchEvent(new window.Event("scroll"));
  };
  return {
    document,
    nav,
    window,
    frames,
    flush,
    scroll,
    stop,
    observe: () => observe(),
    disconnected: () => disconnected,
  };
}

test("native section anchors cover every settings group and switches precede their labels", () => {
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const nav = document.getElementById("settings-nav");
  assert.deepEqual(
    [...nav.querySelectorAll("a")].map((link) => link.hash.slice(1)),
    ids,
  );
  for (const id of ids) {
    const section = document.getElementById(id);
    assert.equal(section.tagName, "SECTION");
    assert.equal(section.getAttribute("tabindex"), "-1");
    const heading = document.getElementById(section.getAttribute("aria-labelledby"));
    const icon = heading.querySelector("img.section-icon");
    const navIcon = nav.querySelector(`a[href="#${id}"] img.section-icon`);
    assert.ok(icon, `${id} has a title icon`);
    assert.equal(icon.getAttribute("alt"), "");
    assert.equal(icon.getAttribute("src"), navIcon.getAttribute("src"));
  }
  assert.equal(document.querySelectorAll(".hero").length, 0);
  assert.equal(document.querySelector(".options-header h1").textContent, "设置");
  assert.equal(nav.querySelector('a[href="#pet-section"] span').textContent, "宠物");
  assert.equal(document.querySelector("#pet-section-title span").textContent, "宠物");
  assert.ok(document.querySelector(".sidebar-brand img"));
  for (const label of document.querySelectorAll(".check")) {
    assert.equal(label.firstElementChild.getAttribute("role"), "switch");
    assert.equal(label.lastElementChild.tagName, "SPAN");
  }
  dom.window.close();
});

test("navigation follows scrolling, anchor landing positions and the final section", (t) => {
  const f = fixture(t);
  const selected = () => f.nav.querySelector('[aria-current="location"]').hash;
  assert.equal(selected(), "#model-section");
  f.scroll(160 + 500 - 84);
  f.flush();
  assert.equal(selected(), "#asr-section");
  assert.equal(f.nav.querySelectorAll("[aria-current]").length, 1);
  f.scroll(1650);
  f.flush();
  assert.equal(selected(), "#playback-section");
  f.scroll(2150);
  f.flush();
  assert.equal(selected(), "#pet-section");
  f.scroll(2900);
  f.flush();
  assert.equal(selected(), "#cache-section");
  f.scroll(0);
  f.flush();
  assert.equal(selected(), "#model-section");
});

test("scroll updates are frame-batched and listeners stop on settings-page cleanup", (t) => {
  const f = fixture(t);
  f.scroll(600);
  f.scroll(700);
  f.window.dispatchEvent(new f.window.Event("resize"));
  f.window.dispatchEvent(new f.window.Event("hashchange"));
  f.observe();
  assert.equal(f.frames.size, 1);
  f.stop();
  assert.equal(f.frames.size, 0);
  assert.equal(f.disconnected(), true);
  f.scroll(1200);
  assert.equal(f.frames.size, 0);
});
