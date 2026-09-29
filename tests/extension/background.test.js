import { test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { DEFAULT_SETTINGS } from "../../extension/lib/constants.js";
import { ref } from "./fixtures.js";

test("background startup, sender checks and network-error response preserve secret isolation", async () => {
  const original = {
    chrome: globalThis.chrome,
    indexedDB: globalThis.indexedDB,
    fetch: globalThis.fetch,
  };
  const data = {
    settings: { ...DEFAULT_SETTINGS, consent: true },
    deepseekKey: "private-test-key",
    sharedToken: "private-test-token",
  };
  const access = [];
  const listeners = [];
  let fetchCalls = 0;
  let currentUrl = `https://www.bilibili.com/video/${ref.bvid}`;
  globalThis.indexedDB = new IDBFactory();
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new TypeError("private-internal-exception");
  };
  globalThis.chrome = {
    runtime: {
      id: "test-extension",
      getURL: (p) => `chrome-extension://test-extension/${p}`,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onInstalled: { addListener() {} },
    },
    storage: {
      local: {
        setAccessLevel: async (v) => access.push(v),
        get: async (keys) => Object.fromEntries(keys.map((k) => [k, data[k]])),
        set: async (v) => Object.assign(data, v),
      },
      session: { setAccessLevel: async (v) => access.push(v) },
    },
    tabs: {
      onRemoved: { addListener() {} },
      query: async () => [],
      get: async (id) => ({ id, url: currentUrl }),
      sendMessage: async () => ({}),
    },
    permissions: { contains: async () => false },
  };
  try {
    await import(`../../extension/background.js?test=${crypto.randomUUID()}`);
    const sender = {
      id: "test-extension",
      frameId: 0,
      tab: { id: 7 },
      url: `https://www.bilibili.com/video/${ref.bvid}`,
    };
    const request = (message, source = sender) =>
      new Promise((resolve) => listeners[0](message, source, resolve));
    const result = await request({ type: "GET_PAGE_STATE", video: ref });
    assert.equal(result.ok, true);
    assert.equal(result.data.error.code, "BILI_NETWORK");
    assert.match(result.data.error.message, /视频元数据接口/);
    assert.equal(result.data.settings.hasKey, true);
    assert.equal(result.data.settings.consent, true);
    assert.equal(JSON.stringify(result).includes("private-"), false);
    assert.deepEqual(access, [
      { accessLevel: "TRUSTED_CONTEXTS" },
      { accessLevel: "TRUSTED_CONTEXTS" },
    ]);
    assert.equal(
      (await request({ type: "SAVE_SETTINGS", settings: { consent: false } })).error.code,
      "SENDER",
    );
    assert.equal((await request({ type: "GET_SETTINGS" })).error.code, "SENDER");
    assert.equal(
      (await request({ type: "GET_PAGE_STATE", video: ref }, { ...sender, frameId: 1 })).error.code,
      "SENDER",
    );
    assert.equal(fetchCalls, 1);
    const ui = { id: "test-extension", url: "chrome-extension://test-extension/options.html" };
    assert.equal(data.settingsVersion, 2);
    assert.equal((await request({ type: "GET_SETTINGS" }, ui)).data.hasSharedToken, true);
    const changedOrigin = await request(
      {
        type: "SAVE_SETTINGS",
        settings: {
          sharedBaseUrl: "https://another.example.com",
          sharedRead: false,
          sharedUpload: false,
        },
      },
      ui,
    );
    assert.equal(changedOrigin.ok, true);
    assert.equal(changedOrigin.data.hasSharedToken, false);
    assert.equal(data.sharedToken, "private-test-token");
    const restoredOrigin = await request(
      {
        type: "SAVE_SETTINGS",
        settings: {
          sharedBaseUrl: DEFAULT_SETTINGS.sharedBaseUrl,
        },
      },
      ui,
    );
    assert.equal(restoredOrigin.data.hasSharedToken, true);
    const cache = await request({ type: "GET_CACHE" }, ui);
    assert.equal(cache.data.stats.apiCalls, 0);
    assert.equal(cache.data.stats.records, 0);
    currentUrl = "https://www.bilibili.com/video/BV1WhE1zeEWH";
    const switched = await request({
      type: "GET_PAGE_STATE",
      video: { bvid: "BV1WhE1zeEWH", page: 1 },
    });
    assert.equal(switched.ok, true);
    assert.equal(switched.data.error.code, "BILI_NETWORK");
    assert.equal((await request({ type: "GET_PAGE_STATE", video: ref })).error.code, "SENDER");
  } finally {
    Object.assign(globalThis, original);
  }
});
