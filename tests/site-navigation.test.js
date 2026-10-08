import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("../server/site/index.html", import.meta.url), "utf8");
const source = await readFile(
  new URL("../server/site/assets/navigation.js", import.meta.url),
  "utf8",
);
const sectionIds = ["overview", "community", "install", "examples", "pet", "features", "notes"];

test("homepage has accessible native section anchors with icons, independent of JavaScript", () => {
  const dom = new JSDOM(html, { url: "https://biliskipad.bakapiano.com/" });
  const { document } = dom.window;
  const links = [...document.querySelectorAll("#home-navigation a")];
  assert.deepEqual(
    links.map((link) => link.hash.slice(1)),
    sectionIds,
  );
  for (const link of links) {
    const section = document.getElementById(link.hash.slice(1));
    assert.equal(section.tagName, "SECTION");
    assert.equal(section.getAttribute("tabindex"), "-1");
    assert.ok(section.closest(".home-content"));
    assert.ok(document.getElementById(section.getAttribute("aria-labelledby")));
    assert.ok(link.querySelector('svg[aria-hidden="true"]'));
  }
  assert.equal(document.querySelectorAll("#home-navigation [aria-current]").length, 1);
  assert.ok(document.querySelector("#screenshot-title"), "old screenshot links keep their anchor");
  assert.equal(document.getElementById("install-userscript").checked, true);
  dom.window.close();
});

test("homepage navigation tracks section offsets, batches updates and restores after BFCache", (t) => {
  // Synthetic scroll geometry and ResizeObserver. No network or user data is involved.
  const dom = new JSDOM(html, {
    url: "https://biliskipad.bakapiano.com/",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  const frames = new Map();
  let nextFrame = 0;
  let y = 0;
  let observe;
  let stopped = 0;
  let requests = 0;
  window.fetch = () => {
    requests++;
    throw new Error("Navigation must not fetch");
  };
  window.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.ResizeObserver = class {
    constructor(callback) {
      observe = callback;
    }
    observe(node) {
      assert.equal(node.className, "home-content");
    }
    disconnect() {
      stopped++;
    }
  };
  Object.defineProperty(window, "scrollY", { get: () => y });
  Object.defineProperty(window, "innerHeight", { value: 700 });
  Object.defineProperty(document.documentElement, "scrollHeight", { value: 3600 });
  document.documentElement.style.scrollPaddingTop = "24px";
  for (const [index, id] of sectionIds.entries()) {
    const section = document.getElementById(id);
    section.style.scrollMarginTop = "12px";
    section.getBoundingClientRect = () => ({ top: 100 + index * 500 - y });
  }
  const flush = () => {
    const tasks = [...frames.values()];
    frames.clear();
    for (const callback of tasks) {
      callback();
    }
  };
  const scroll = (value) => {
    y = value;
    window.dispatchEvent(new window.Event("scroll"));
  };
  const active = () => document.querySelector('#home-navigation [aria-current="location"]').hash;
  window.eval(source);
  assert.equal(active(), "#overview");
  scroll(600 - 36);
  window.dispatchEvent(new window.Event("resize"));
  window.dispatchEvent(new window.Event("hashchange"));
  observe();
  assert.equal(frames.size, 1);
  flush();
  assert.equal(active(), "#community");
  scroll(1600 - 36);
  flush();
  assert.equal(active(), "#examples");
  scroll(2100 - 36);
  flush();
  assert.equal(active(), "#pet");
  for (const id of sectionIds) {
    document.getElementById(id).style.scrollMarginTop = "72px";
  }
  scroll(2600 - 96);
  flush();
  assert.equal(active(), "#features");
  scroll(2900);
  flush();
  assert.equal(active(), "#notes");
  document.querySelector('#home-navigation a[href="#features"]').click();
  flush();
  // Synthetic final geometry: a click to a near-bottom section can share the last scroll offset.
  document.getElementById("features").getBoundingClientRect = () => ({ top: 100 });
  observe();
  flush();
  assert.equal(active(), "#features");
  window.dispatchEvent(new window.WheelEvent("wheel"));
  flush();
  assert.equal(active(), "#notes");
  scroll(0);
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(frames.size, 0);
  assert.equal(stopped, 1);
  scroll(100);
  assert.equal(frames.size, 0);
  window.dispatchEvent(new window.PageTransitionEvent("pageshow", { persisted: true }));
  assert.equal(active(), "#overview");
  scroll(600);
  flush();
  assert.equal(active(), "#community");
  assert.equal(requests, 0);
});

test("navigation deployment stays within static assets and the existing same-origin CSP", async () => {
  for (const name of ["site.sh", "install.sh"]) {
    const script = await readFile(new URL(`../server/deploy/${name}`, import.meta.url), "utf8");
    assert.ok(script.includes("site/assets/navigation.js"));
  }
  assert.doesNotMatch(source, /\bfetch\(|xmlHttpRequest|localStorage|sendBeacon/);
  const nginx = await readFile(new URL("../server/deploy/nginx.conf", import.meta.url), "utf8");
  assert.match(nginx, /location \/assets\//);
  assert.match(nginx, /script-src 'self'/);
});
