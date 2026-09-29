// Minimal deterministic DOM for the real options/popup scripts; no live Chrome APIs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { sharedOrigin } from "../../extension/lib/core.js";

export function uiFixture(name, chrome) {
  const html = readFileSync(new URL(`../../extension/${name}.html`, import.meta.url), "utf8");
  class Element {
    constructor(tag = "div") {
      this.tag = tag;
      this.children = [];
      this.style = {};
      this.dataset = {};
      this.events = new Map();
      this.disabled = false;
      this.hidden = false;
      this.checked = false;
      this.value = "";
      this.textContent = "";
      this.classList = { toggle() {} };
    }
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = children;
      this.textContent = "";
    }
    addEventListener(type, fn) {
      this.events.set(type, fn);
    }
    async emit(type, isTrusted = true) {
      if (type === "click" && (this.disabled || this.hidden)) {
        return;
      }
      await this.events.get(type)?.({ isTrusted, preventDefault() {} });
    }
  }
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]);
    element.disabled = /\bdisabled\b/.test(match[0]);
    element.hidden = /\bhidden\b/.test(match[0]);
    elements.set(match[2], element);
  }
  const get = (id) => {
    assert.ok(elements.has(id), `Unknown HTML id: ${id}`);
    return elements.get(id);
  };
  const walk = (element) => [element, ...element.children.flatMap(walk)];
  const all = () => [...elements.values()].flatMap(walk);
  const events = new Map();
  let interval;
  const sandbox = {
    chrome,
    sharedOrigin,
    URL,
    Blob,
    confirm: () => true,
    setTimeout,
    setInterval: (fn) => {
      interval = fn;
      return 1;
    },
    clearInterval: () => {
      interval = null;
    },
    window: { addEventListener: (type, fn) => events.set(type, fn) },
    document: {
      getElementById: get,
      createElement: (tag) => new Element(tag),
      querySelectorAll: (selector) => {
        assert.equal(selector, "[data-segment-action]");
        return all().filter((element) => element.dataset.segmentAction);
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(new URL("../../extension/player-core.js", import.meta.url), "utf8"),
    sandbox,
  );
  const source = readFileSync(new URL(`../../extension/${name}.js`, import.meta.url), "utf8");
  if (name === "popup") {
    vm.runInContext(
      readFileSync(new URL("../../extension/popup-view.js", import.meta.url), "utf8"),
      sandbox,
    );
  }
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, ""), sandbox);
  return { get, all, poll: () => interval?.(), close: () => events.get("pagehide")?.(), sandbox };
}
