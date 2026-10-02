import { ASR_ASSETS } from "./asr-assets.js";
import { AppError, assert } from "../extension/lib/core.js";
import { boundedBody } from "../extension/lib/bilibili.js";

export async function readAsrResource(gm, asset, fetcher = fetch, signal) {
  signal?.throwIfAborted();
  assert(
    typeof gm.getResourceUrl === "function",
    "ASR_RESOURCE",
    "请安装新版脚本并允许油猴读取预加载资源。",
  );
  let url;
  try {
    url = await gm.getResourceUrl(asset.name);
  } catch {
    throw new AppError("ASR_RESOURCE", "油猴预加载资源读取失败，请重新安装脚本及其资源。");
  }
  signal?.throwIfAborted();
  assert(
    typeof url === "string",
    "ASR_RESOURCE",
    "油猴语音资源尚未准备完成，请更新脚本资源后重试。",
  );
  let bytes;
  if (url.startsWith("data:")) {
    const separator = url.indexOf(",");
    assert(
      separator > 4 && separator <= 256 && /;base64$/i.test(url.slice(0, separator)),
      "ASR_RESOURCE",
      "语音资源数据格式异常。",
    );
    const encoded = url.slice(separator + 1);
    assert(
      encoded.length <= Math.ceil(asset.bytes / 3) * 4,
      "ASR_RESOURCE_SIZE",
      "语音资源超过固定大小。",
    );
    try {
      const raw = atob(encoded);
      bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index++) {
        bytes[index] = raw.charCodeAt(index);
      }
    } catch {
      throw new AppError("ASR_RESOURCE", "语音资源解码失败，请重新安装脚本资源。");
    }
  } else {
    // Runtime requests are restricted to the manager's local blob. Never fall back to HTTP.
    assert(
      url.startsWith("blob:") && url.length < 2048,
      "ASR_RESOURCE_URL",
      "语音运行时须来自油猴预加载的本地资源。",
    );
    const response = await fetcher.call(globalThis, url, {
      credentials: "omit",
      redirect: "error",
      signal: signal || AbortSignal.timeout(10000),
    });
    bytes = await boundedBody(response, asset.bytes);
  }
  signal?.throwIfAborted();
  assert(bytes.length === asset.bytes, "ASR_RESOURCE_SIZE", "语音资源长度与固定版本不一致。");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  signal?.throwIfAborted();
  assert(
    hash === asset.sha256,
    "ASR_RESOURCE_HASH",
    "语音资源SHA-256校验失败，请重新安装脚本资源。",
  );
  return bytes.buffer;
}

export async function loadAsrResources(gm, fetcher = fetch, signal) {
  const entries = await Promise.all(
    ASR_ASSETS.map(async (asset) => [asset.key, await readAsrResource(gm, asset, fetcher, signal)]),
  );
  return Object.fromEntries(entries);
}

// Keep dependency failures local to this page. Saved settings and transcript caches remain valid.
export class AsrResourceGate {
  constructor(loader, { timeoutMs = 10000 } = {}) {
    this.loader = loader;
    this.timeoutMs = timeoutMs;
    this.listeners = new Set();
    this.state = {
      status: "unchecked",
      message: "本地转写首次使用前会校验 WASM 和 VAD/词表资源。",
    };
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  update(status, message) {
    this.state = { status, message };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
  async load({ retry = false } = {}) {
    if (this.pending) {
      return this.pending;
    }
    if (this.error && !retry) {
      throw this.error;
    }
    if (this.buffers && !retry) {
      return this.buffers;
    }
    this.pending = Promise.resolve()
      .then(async () => {
        this.update("checking", "正在校验油猴预加载的 WASM 和 VAD/词表资源…");
        const controller = new AbortController();
        let timer;
        try {
          const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new AppError("ASR_RESOURCE_TIMEOUT", "语音资源读取超时。"));
              controller.abort();
            }, this.timeoutMs);
          });
          this.buffers = await Promise.race([
            Promise.resolve().then(() => this.loader(controller.signal)),
            timeout,
          ]);
          this.error = null;
          this.update("ready", "WASM 和 VAD/词表资源已通过校验，本地转写可用。");
          return this.buffers;
        } catch (error) {
          controller.abort();
          this.buffers = null;
          const reason =
            error?.code === "ASR_RESOURCE_TIMEOUT"
              ? "资源读取超时"
              : ["ASR_RESOURCE_HASH", "ASR_RESOURCE_SIZE"].includes(error?.code)
                ? "资源完整性校验失败"
                : "资源读取失败";
          this.error = new AppError(
            "ASR_UNAVAILABLE",
            `本地转写已在当前页面暂停（${reason}）。字幕识别与已有缓存继续可用。请在油猴中更新脚本资源，再到设置点击「重新检查资源」。`,
          );
          this.update("unavailable", this.error.message);
          throw this.error;
        } finally {
          clearTimeout(timer);
        }
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}
