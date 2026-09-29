import assert from "node:assert/strict";
import { test } from "node:test";
import { uiFixture } from "./ui-fixture.js";
import { deferred, flush, ref } from "./fixtures.js";

function sample() {
  return {
    video: { ...ref, route: `${ref.bvid}:p1` },
    recordToken: "record:1",
    subtitleSource: "bilibili:en",
    record: {
      video: { ...ref, title: "弹窗测试视频", duration: 100 },
      source: "shared",
      cueCount: 4,
      model: "deepseek-flash",
      elapsedMs: 200,
      segments: [{ start: 10, end: 20, brand: "测试品牌", reason: "测试广告", confidence: 0.98 }],
    },
    settings: {
      hasKey: true,
      consent: true,
      autoSkip: true,
      autoUpload: true,
      sharedUpload: true,
      sharedRead: true,
    },
    player: { ready: true, canSkip: true, canUndo: true },
    message: "1 个广告区间已就绪。",
    metrics: { apiCalls: 1, cacheHits: 2 },
    stage: "ready",
    busy: false,
  };
}
async function setup({ video = ref, handler } = {}) {
  let state = sample();
  const requests = [];
  let options = 0;
  const ui = uiFixture("popup", {
    runtime: {
      sendMessage: async (message) => {
        assert.equal(message.type, "GET_ACTIVE");
        return { ok: true, data: { video, tabId: 7, settings: state.settings } };
      },
      openOptionsPage: async () => {
        options++;
      },
    },
    tabs: {
      sendMessage: async (tabId, message) => {
        assert.equal(tabId, 7);
        requests.push(message);
        if (handler) {
          const response = await handler(message);
          if (response) {
            return response;
          }
        }
        return { ok: true, data: state };
      },
    },
  });
  await flush();
  return {
    ...ui,
    requests,
    setState: (value) => {
      state = value;
    },
    options: () => options,
  };
}

test("native popup renders markers, language, metrics and all playback/cache actions", async () => {
  const f = await setup();
  assert.equal(f.get("source").textContent, "线上缓存");
  assert.equal(f.get("video-title").textContent, "弹窗测试视频");
  assert.match(f.get("meta").textContent, /字幕：英文（en）/);
  assert.match(f.get("meta").textContent, /模型请求 1 次/);
  assert.equal(f.get("meter").children[0].style.left, "10%");
  assert.match(f.get("upload-status").textContent, /自动上传：开/);
  for (const action of ["analyze", "refresh", "online", "toggle", "skip", "undo", "upload"]) {
    await f.get(action).emit("click");
    await flush();
    assert.equal(f.requests.at(-1).action, action);
    assert.equal(f.requests.at(-1).route, `${ref.bvid}:p1`);
    assert.equal(f.requests.at(-1).recordToken, "record:1");
  }
  for (const button of f.all().filter((el) => el.dataset.segmentAction)) {
    await button.emit("click");
    await flush();
    assert.equal(f.requests.at(-1).action, button.dataset.segmentAction);
    assert.equal(f.requests.at(-1).index, 0);
  }
  await f.get("options").emit("click");
  assert.equal(f.options(), 1);
});

test("popup honors busy/read/upload switches and clears markers when the page changes", async () => {
  const f = await setup();
  const busy = sample();
  busy.busy = true;
  busy.settings.sharedUpload = false;
  busy.settings.sharedRead = false;
  f.setState(busy);
  await f.poll();
  assert.equal(f.get("online").disabled, true);
  assert.equal(f.get("analyze").disabled, true);
  assert.equal(f.get("upload").hidden, true);
  assert.ok(
    f
      .all()
      .filter((el) => el.dataset.segmentAction)
      .every((el) => el.disabled),
  );
  f.setState({ ...sample(), video: null, record: null, recordToken: "", player: {} });
  await f.poll();
  assert.equal(f.get("meter").children.length, 0);
  assert.equal(f.get("analyze").disabled, true);
});

test("popup polling is read-only, stops on close and untrusted clicks stay inert", async () => {
  const f = await setup();
  await f.get("analyze").emit("click", false);
  await f.get("options").emit("click", false);
  await f.poll();
  assert.ok(f.requests.every((message) => message.action === "state"));
  assert.equal(f.options(), 0);
  f.close();
  const count = f.requests.length;
  await f.poll();
  assert.equal(f.requests.length, count);
});

test("popup explains unavailable or outdated page controllers and ordinary tabs", async () => {
  const f = await setup({
    handler: async () => {
      throw new Error("synthetic disconnected");
    },
  });
  assert.match(f.get("status").textContent, /请刷新 B站视频页/);
  assert.equal(f.get("analyze").disabled, true);
  const g = await setup({ video: null });
  assert.equal(g.requests.length, 0);
  assert.equal(g.get("analyze").disabled, true);
});

test("a stale poll response cannot replace the state returned by a newer command", async () => {
  const gate = deferred();
  let reads = 0;
  const f = await setup({
    handler: async (message) => {
      if (message.action === "state" && ++reads === 2) {
        return gate.promise;
      }
      if (message.action === "toggle") {
        const state = sample();
        state.settings.autoSkip = false;
        return { ok: true, data: state };
      }
    },
  });
  const poll = f.poll();
  await f.get("toggle").emit("click");
  await flush();
  gate.resolve({ ok: true, data: sample() });
  await poll;
  assert.equal(f.get("toggle").textContent, "开启自动跳过");
});
