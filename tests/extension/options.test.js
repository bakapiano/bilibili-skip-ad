import assert from "node:assert/strict";
import { test } from "node:test";
import { uiFixture } from "./ui-fixture.js";
import { flush, deferred } from "./fixtures.js";
import { validateSettings } from "../../extension/lib/core.js";
import { publicSettings } from "../../extension/lib/messaging.js";

test("cache list paginates all rows locally and clamps its page after deletion or refresh", async () => {
  const rows = Array.from({ length: 105 }, (_, index) => ({
    key: `synthetic-${index}`,
    video: { bvid: "BV1pFUDBKE8X", page: 1, cid: index + 1, title: `缓存 ${index}` },
    segments: [],
    model: "synthetic",
    summary: "测试缓存",
    createdAt: index,
    cueCount: 4,
    transcript_sha256: "a".repeat(64),
  }));
  let records = rows;
  let reads = 0;
  const f = uiFixture("options", {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "GET_CACHE") {
          reads++;
          return { ok: true, data: { records, stats: { records: records.length } } };
        }
        return { ok: true, data: publicSettings(validateSettings()) };
      },
    },
  });
  await flush();
  assert.equal(f.get("cache-list").children.length, 10);
  assert.match(f.get("cache-page-status").textContent, /1 \/ 11.*105/);
  for (let page = 0; page < 10; page++) {
    await f.get("cache-page-next").emit("click");
  }
  assert.equal(f.get("cache-list").children.length, 5);
  assert.equal(reads, 1);
  assert.equal(f.get("cache-page-next").disabled, true);
  f.get("cache-page-size").value = "50";
  await f.get("cache-page-size").emit("change");
  assert.equal(f.get("cache-list").children.length, 50);
  assert.match(f.get("cache-page-status").textContent, /1 \/ 3/);
  await f.get("cache-page-next").emit("click");
  records = rows.slice(0, 3);
  await f.get("refresh-cache").emit("click");
  await flush();
  assert.equal(f.get("cache-list").children.length, 3);
  assert.match(f.get("cache-page-status").textContent, /1 \/ 1.*3/);
  records = [];
  await f.get("refresh-cache").emit("click");
  await flush();
  assert.match(f.get("cache-page-status").textContent, /0 \/ 0.*0/);
  assert.equal(f.get("cache-page-prev").disabled, true);
  assert.equal(f.get("cache-page-next").disabled, true);
  f.close();
});

test("options load, save and retain the automatic-upload opt-out", async () => {
  let settings = validateSettings();
  const messages = [];
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === "GET_CACHE") {
          return { ok: true, data: { records: [], stats: {} } };
        }
        if (message.type === "SAVE_SETTINGS") {
          settings = validateSettings(message.settings);
        }
        return { ok: true, data: publicSettings(settings) };
      },
    },
    permissions: { contains: async () => true },
  };
  const f = uiFixture("options", chrome);
  await flush();
  assert.equal(f.get("auto-upload").checked, true);
  assert.equal(f.get("asr-upload").checked, true);
  f.get("asr-upload").checked = false;
  f.get("auto-upload").checked = false;
  await f.get("settings-form").emit("submit");
  assert.equal(messages.at(-1).settings.autoUpload, false);
  assert.equal(settings.sharedUpload, true);
  assert.equal(settings.asrUpload, false);
  const reopened = uiFixture("options", chrome);
  await flush();
  assert.equal(reopened.get("auto-upload").checked, false);
  assert.equal(reopened.get("asr-upload").checked, false);
  reopened.get("shared-upload").checked = false;
  await reopened.get("shared-upload").emit("change");
  assert.equal(reopened.get("auto-upload").disabled, true);
});

test("model settings predownload is explicitly clicked and independent of ASR/DeepSeek settings", async () => {
  let downloads = 0;
  let cached = false;
  const messages = [];
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
        return {
          ok: true,
          data:
            message.type === "GET_CACHE"
              ? { records: [], stats: {} }
              : publicSettings(validateSettings()),
        };
      },
    },
  };
  const model = class {
    async status() {
      return { cached };
    }
    async download(progress) {
      downloads++;
      progress({ loaded: 50, total: 100, message: "测试下载50%" });
      cached = true;
      progress({ loaded: 100, total: 100, message: "模型已缓存并通过校验" });
    }
  };
  const f = uiFixture("options", chrome, { AsrModelCache: model });
  await flush();
  assert.equal(downloads, 0);
  assert.equal(f.get("asr-enabled").checked, false);
  await f.get("download-model").emit("click", false);
  assert.equal(downloads, 0);
  await f.get("download-model").emit("click");
  assert.equal(downloads, 1);
  assert.match(f.get("model-status").textContent, /通过校验/);
  assert.equal(f.get("model-download-progress").value, 100);
  assert.equal(f.get("asr-enabled").checked, false);
  assert.equal(
    messages.some((row) => row.type === "SAVE_SETTINGS" || row.type === "ANALYZE"),
    false,
  );
  await f.get("check-model-cache").emit("click");
  await flush();
  assert.match(f.get("model-status").textContent, /已缓存/);
  f.close();
});

test("settings download cancels when the settings page closes", async () => {
  const gate = deferred();
  let signal;
  const f = uiFixture(
    "options",
    {
      runtime: {
        sendMessage: async (message) => ({
          ok: true,
          data:
            message.type === "GET_CACHE"
              ? { records: [], stats: {} }
              : publicSettings(validateSettings()),
        }),
      },
    },
    {
      AsrModelCache: class {
        async status() {
          return { cached: false };
        }
        download(_progress, value) {
          signal = value;
          value.addEventListener("abort", () => gate.reject(new Error("cancelled")));
          return gate.promise;
        }
      },
    },
  );
  const pending = f.get("download-model").emit("click");
  await flush();
  assert.equal(signal.aborted, false);
  f.close();
  assert.equal(signal.aborted, true);
  await pending;
});

test("third-party source asks for only its optional origins and passes selection to download", async () => {
  const permissions = [];
  const downloads = [];
  const f = uiFixture(
    "options",
    {
      runtime: {
        sendMessage: async (message) => ({
          ok: true,
          data:
            message.type === "GET_CACHE"
              ? { records: [], stats: {} }
              : publicSettings(validateSettings()),
        }),
      },
      permissions: {
        contains: async () => false,
        request: async (value) => {
          permissions.push(value);
          return true;
        },
      },
    },
    {
      AsrModelCache: class {
        async status() {
          return { cached: false };
        }
        async download(_progress, _signal, source) {
          downloads.push(source);
        }
      },
    },
  );
  await flush();
  f.get("model-source").value = "hf-mirror";
  await f.get("download-model").emit("click");
  assert.deepEqual(structuredClone(permissions), [
    { origins: ["https://hf-mirror.com/*", "https://*.hf.co/*", "https://*.huggingface.co/*"] },
  ]);
  assert.deepEqual(downloads, ["hf-mirror"]);
  assert.equal(f.get("asr-enabled").checked, false);
  f.close();
});
