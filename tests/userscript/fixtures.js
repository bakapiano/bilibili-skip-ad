// Deterministic GM/storage/network/Web Locks stand-ins. No live credentials or API calls.
import { body, labels, ref, usage, video } from "../extension/fixtures.js";

export function lockFixture() {
  const held = new Set();
  return {
    held,
    async request(name, options, callback) {
      if (!options.ifAvailable) {
        throw new Error("Fixture expects non-blocking locks.");
      }
      if (held.has(name)) {
        return callback(null);
      }
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

export function gmFixture({
  values = new Map(),
  handler,
  language = "zh-CN",
  zeroAds = false,
} = {}) {
  const requests = [];
  const menus = new Map();
  const changes = new Map();
  let receipt;
  let nextId = 1;
  const gm = {
    info: { version: "5.4.0", scriptHandler: "Tampermonkey", sandboxMode: "raw" },
    getValue: async (key, fallback) =>
      structuredClone(values.has(key) ? values.get(key) : fallback),
    setValue: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    deleteValue: async (key) => {
      values.delete(key);
    },
    listValues: async () => [...values.keys()],
    registerMenuCommand: async (name, fn) => {
      menus.set(name, fn);
      return name;
    },
    unregisterMenuCommand: async (id) => {
      menus.delete(id);
    },
    addValueChangeListener: async (key, fn) => {
      const id = nextId++;
      changes.set(id, { key, fn });
      return id;
    },
    removeValueChangeListener: async (id) => {
      changes.delete(id);
    },
    xmlHttpRequest(details) {
      const row = { details, aborted: false };
      requests.push(row);
      const pending = Promise.resolve().then(async () => {
        const supplied = await handler?.(details);
        if (supplied) {
          return { finalUrl: details.url, ...supplied };
        }
        const url = new URL(details.url);
        let data;
        let status = 200;
        switch (url.pathname) {
          case "/x/web-interface/view":
            data = {
              code: 0,
              data: {
                bvid: url.searchParams.get("bvid"),
                aid: 123,
                title: video.title,
                pages: [{ cid: video.cid, duration: video.duration, part: "P1" }],
              },
            };
            break;
          case "/x/player/wbi/v2":
            data = {
              code: 0,
              data: {
                subtitle: {
                  subtitles: [
                    { lan: language, subtitle_url: "https://aisubtitle.hdslb.com/bfs/test.json" },
                  ],
                },
              },
            };
            break;
          case "/x/v2/subtitle/web/view":
            return { status: 200, finalUrl: details.url, response: new ArrayBuffer(0) };
          case "/bfs/test.json":
            data = { body };
            break;
          case "/chat/completions": {
            const payload = JSON.parse(JSON.parse(details.data).messages[1].content);
            const output = labels(payload);
            if (zeroAds) {
              output.segments = [];
            }
            data = {
              choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
              usage,
            };
            break;
          }
          case "/v1/segments":
            data = receipt ? { ...receipt, status: "published" } : {};
            status = receipt ? 200 : 404;
            break;
          case "/v1/candidates":
            receipt = JSON.parse(details.data);
            data = { schema_version: 1, status: "accepted", submission_id: "synthetic-receipt" };
            break;
          default:
            throw new Error(`Unmocked endpoint: ${url.pathname}`);
        }
        return {
          status,
          finalUrl: details.url,
          response: new TextEncoder().encode(JSON.stringify(data)).buffer,
        };
      });
      pending.abort = () => {
        row.aborted = true;
      };
      return pending;
    },
  };
  return { gm, values, requests, menus, changes, ref };
}
