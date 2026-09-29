import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../extension/timeline.js", import.meta.url), "utf8");
function fixture() {
  class Element {
    constructor() {
      this.style = { position: "" };
      this.dataset = {};
      this.children = [];
      this.isConnected = true;
    }
    append(node) {
      this.children.push(node);
      node.parent = this;
    }
    replaceChildren() {
      for (const child of this.children) {
        child.isConnected = false;
      }
      this.children = [];
    }
    setAttribute(name, value) {
      this[name] = value;
    }
    remove() {
      this.isConnected = false;
      if (this.parent) {
        this.parent.children = this.parent.children.filter((child) => child !== this);
      }
    }
  }
  const main = new Element();
  const mini = new Element();
  let targets = [main, mini];
  const player = { querySelectorAll: () => targets };
  const video = { closest: () => player };
  const document = { createElement: () => new Element() };
  const sandbox = {
    document,
    getComputedStyle: (node) => ({ position: node.style.position || "static" }),
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const timeline = new sandbox.BiliSkipTimeline(document);
  const record = {
    key: "one",
    createdAt: 1,
    video: { duration: 100 },
    segments: [{ start: 10, end: 20, brand: "测试" }],
  };
  return {
    main,
    mini,
    video,
    timeline,
    record,
    replaceMain() {
      targets = [new Element(), mini];
      return targets[0];
    },
  };
}
test("native main and mini timeline layers use exact percentages and click-through styling", () => {
  const f = fixture();
  f.timeline.sync(f.record, f.video);
  for (const wrap of [f.main, f.mini]) {
    const layer = wrap.children[0];
    const marker = layer.children[0];
    assert.equal(layer.className, "biliskip-native-markers");
    assert.match(layer.style.cssText, /pointer-events:none/);
    assert.equal(marker.style.left, "10%");
    assert.equal(marker.style.width, "10%");
    assert.equal(marker.dataset.start, "10");
    assert.equal(marker.dataset.end, "20");
  }
  f.timeline.sync(f.record, f.video);
  assert.equal(f.main.children.length, 1);
});
test("timeline clears stale markers, restores positioning and remounts after player UI replacement", () => {
  const f = fixture();
  f.timeline.sync(f.record, f.video);
  assert.equal(f.main.style.position, "relative");
  const replaced = f.replaceMain();
  f.timeline.sync(f.record, f.video);
  assert.equal(f.main.children.length, 0);
  assert.equal(f.main.style.position, "");
  assert.equal(replaced.children.length, 1);
  f.timeline.sync(null, f.video);
  assert.equal(replaced.children.length, 0);
  assert.equal(f.mini.children.length, 0);
  assert.equal(f.timeline.layers.size, 0);
});
test("updated record rebuilds markers and preserves a site's later positioning change", () => {
  const f = fixture();
  f.timeline.sync(f.record, f.video);
  const next = { ...f.record, createdAt: 2, segments: [{ start: 30, end: 40, brand: "第二段" }] };
  f.timeline.sync(next, f.video);
  assert.equal(f.main.children[0].children[0].style.left, "30%");
  f.main.style.position = "absolute";
  f.timeline.clear();
  assert.equal(f.main.style.position, "absolute");
});
