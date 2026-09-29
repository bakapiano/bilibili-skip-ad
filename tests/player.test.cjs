const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const data = {
  video: { bvid: "BV1pFUDBKE8X", cid: 123, page: 1, duration: 100 },
  auto_threshold: 0.9,
  segments: [{ start: 10, end: 20, confidence: 0.98, brand: "合成测试品牌", reason: "测试" }],
};
const template = fs.readFileSync(path.join(__dirname, "../skip.template.js"), "utf8");

function logic(fixture = data) {
  const context = { module: { exports: {} }, URL };
  vm.runInNewContext(template.replace("__BILISKIP_DATA__", JSON.stringify(fixture)), context);
  return context.module.exports;
}

test("BV, page, host and duration must match", () => {
  const { matchesVideo } = logic();
  assert.equal(matchesVideo("https://www.bilibili.com/video/BV1pFUDBKE8X", 99.8), true);
  assert.equal(matchesVideo("https://www.bilibili.com/video/BV1pFUDBKE8X?p=2", 100), false);
  assert.equal(matchesVideo("https://www.bilibili.com/video/BV1pFUDBKE8Y", 100), false);
  assert.equal(matchesVideo("https://evil.test/video/BV1pFUDBKE8X", 100), false);
  assert.equal(matchesVideo("https://www.bilibili.com/video/BV1pFUDBKE8X", NaN), false);
  assert.equal(matchesVideo("https://www.bilibili.com/video/BV1pFUDBKE8X", 200), false);
});

test("segment end is exclusive and undo suppression is honored", () => {
  const { segmentAt } = logic();
  assert.equal(segmentAt(9.99, new Set()), undefined);
  assert.equal(segmentAt(10, new Set()).start, 10);
  assert.equal(segmentAt(20, new Set()), undefined);
  assert.equal(segmentAt(15, new Set([0])), undefined);
});

test("auto policy checks confidence and extreme coverage", () => {
  const { autoEligible } = logic();
  assert.equal(autoEligible(data.segments[0]), true);
  assert.equal(autoEligible({ ...data.segments[0], confidence: 0.7 }), false);
  const long = { ...data, segments: [{ start: 0, end: 80, confidence: 0.99 }] };
  assert.equal(logic(long).autoEligible(long.segments[0]), false);
});

function liveFixture(cid = 123) {
  const elements = [];
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.events = {}; elements.push(this); }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    attachShadow() { return new Element("shadow"); }
    addEventListener(name, fn) { this.events[name] = fn; }
    removeEventListener(name, fn) { if (this.events[name] === fn) delete this.events[name]; }
    getBoundingClientRect() { return { width: 640 }; }
    click() { if (!this.disabled) this.events.click?.(); }
  }
  const video = new Element("video");
  Object.assign(video, { duration: 100, currentTime: 12, paused: false, seeking: false });
  const body = new Element("body");
  const document = { body, createElement: tag => new Element(tag), querySelectorAll: () => [video] };
  const location = { href: "https://www.bilibili.com/video/BV1pFUDBKE8X/" };
  let tick;
  const context = { document, location, URL, AbortSignal,
    fetch: async () => ({ json: async () => ({ code: 0, data: { pages: [{ cid }] } }) }),
    setInterval: fn => { tick = fn; },
  };
  vm.runInNewContext(template.replace("__BILISKIP_DATA__", JSON.stringify(data)), context);
  return { video, location, tick: () => tick(), elements,
    button: text => elements.find(item => item.tag === "button" && item.textContent === text) };
}

test("preview -> opt-in skip -> undo -> continued playback", async () => {
  const fixture = liveFixture();
  await new Promise(resolve => setImmediate(resolve));
  fixture.tick();
  assert.equal(fixture.video.currentTime, 12, "preview leaves playback intact");
  fixture.button("开启自动跳过").click();
  assert.equal(fixture.video.currentTime, 20.05);
  fixture.button("撤销跳过").click();
  assert.equal(fixture.video.currentTime, 12);
  fixture.tick();
  assert.equal(fixture.video.currentTime, 12, "undo prevents immediate re-skip");
});

test("CID mismatch keeps seeking disabled", async () => {
  const fixture = liveFixture(999);
  await new Promise(resolve => setImmediate(resolve));
  fixture.tick();
  fixture.button("开启自动跳过").click();
  assert.equal(fixture.video.currentTime, 12);
  assert.equal(fixture.button("跳过当前广告").disabled, true);
});

test("listening to a boundary then opting in enables skipping again", async () => {
  const fixture = liveFixture();
  await new Promise(resolve => setImmediate(resolve));
  fixture.tick();
  fixture.button("试听边界").click();
  assert.equal(fixture.video.currentTime, 8);
  fixture.video.currentTime = 12;
  fixture.button("开启自动跳过").click();
  assert.equal(fixture.video.currentTime, 20.05);
});

test("automatic mode respects pause and seeking states", async () => {
  const fixture = liveFixture();
  await new Promise(resolve => setImmediate(resolve));
  fixture.tick();
  fixture.video.paused = true;
  fixture.button("开启自动跳过").click();
  assert.equal(fixture.video.currentTime, 12);
  fixture.video.paused = false;
  fixture.video.seeking = true;
  fixture.tick();
  assert.equal(fixture.video.currentTime, 12);
  fixture.video.seeking = false;
  fixture.tick();
  assert.equal(fixture.video.currentTime, 20.05);
});

test("SPA navigation to another video clears and hides the controller", async () => {
  const fixture = liveFixture();
  await new Promise(resolve => setImmediate(resolve));
  fixture.tick();
  fixture.button("开启自动跳过").click();
  fixture.location.href = "https://www.bilibili.com/video/BV1pFUDBKE8Y/";
  fixture.video.currentTime = 12;
  fixture.tick();
  assert.equal(fixture.video.currentTime, 12);
  assert.equal(fixture.elements.find(item => item.id === "biliskip-poc").style.display, "none");
});
