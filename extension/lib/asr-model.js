import { ASR_MODEL, modelSource, allowedModelDownload } from "./asr-config.js";
import { AppError, assert } from "./core.js";
import { boundedBody } from "./bilibili.js";

export const ASR_CACHE_NAME = "biliskip-asr-model-v1";

export class AsrModelCache {
  constructor({
    fetcher = fetch,
    storage = globalThis.caches,
    locks = globalThis.navigator?.locks,
    model = ASR_MODEL,
  } = {}) {
    this.fetcher = fetcher.bind(globalThis);
    this.storage = storage;
    this.locks = locks;
    this.model = model;
  }
  async cachedResponse(cache) {
    for (const key of [this.model.url, this.model.legacyUrl].filter(Boolean)) {
      const response = await cache.match(key);
      if (response) {
        return { response, key };
      }
    }
    return { response: null, key: this.model.url };
  }
  async status() {
    assert(this.storage, "ASR_STORAGE", "浏览器模型缓存暂不可用，请检查站点存储设置。");
    const cache = await this.storage.open(ASR_CACHE_NAME);
    const { response } = await this.cachedResponse(cache);
    return { cached: Boolean(response), bytes: this.model.bytes };
  }
  async load(progress = () => {}, signal, sourceId = "biliskip") {
    assert(this.storage, "ASR_STORAGE", "浏览器模型缓存暂不可用，请检查站点存储设置。");
    assert(this.locks?.request, "ASR_LOCK", "请使用具备Web Locks的现代浏览器管理模型缓存。");
    signal?.throwIfAborted();
    return this.locks.request(
      `biliskip:asr-model:${this.model.sha256}`,
      { ifAvailable: true },
      async (lock) => {
        assert(lock, "BUSY", "另一个页面正在准备语音模型，请完成后点击检查缓存。");
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        const timer = setTimeout(() => controller.abort(), 900000);
        signal?.addEventListener("abort", abort, { once: true });
        try {
          signal?.throwIfAborted();
          return await this.read(progress, controller.signal, sourceId);
        } catch (error) {
          if (controller.signal.aborted || signal?.aborted) {
            throw new AppError("ASR_CANCELLED", "模型下载已停止，可再次点击下载重试。");
          }
          if (error instanceof AppError) {
            throw error;
          }
          throw new AppError("ASR_MODEL", "语音模型准备失败，请检查网络和浏览器可用存储后重试。");
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      },
    );
  }
  async read(progress, signal, sourceId) {
    const selected = modelSource(sourceId);
    assert(selected, "ASR_SOURCE", "请选择内置模型下载源。");
    // Tests may inject tiny pinned models; production always uses the reviewed source catalog.
    const source = this.model === ASR_MODEL ? selected : { ...selected, url: this.model.url };
    const cache = await this.storage.open(ASR_CACHE_NAME);
    const cached = await this.cachedResponse(cache);
    const hit = Boolean(cached.response);
    let response = cached.response;
    let lastPercent = -1;
    const notify = (stage, loaded, message) =>
      progress({ stage, loaded, total: this.model.bytes, message });
    const downloadProgress = (loaded) => {
      const percent = Math.min(100, Math.floor((loaded / this.model.bytes) * 100));
      if (percent > lastPercent) {
        lastPercent = percent;
        notify(
          "download",
          loaded,
          `模型下载 ${percent}% · ${(loaded / 1000000).toFixed(1)}/${(this.model.bytes / 1000000).toFixed(1)}MB`,
        );
      }
    };
    notify(
      hit ? "read" : "download",
      0,
      hit ? "正在读取本机模型缓存…" : `正在从${source.label}下载语音模型…`,
    );
    if (!response) {
      response = await this.fetcher(source.url, {
        credentials: "omit",
        redirect: source.id === "biliskip" ? "error" : "follow",
        modelSource: source.id,
        signal,
        onDownloadProgress: downloadProgress,
      });
      assert(
        !response.url || allowedModelDownload(response.url, source),
        "ASR_HOST",
        "模型地址应匹配内置下载地址。",
      );
    }
    let bytes;
    try {
      bytes = await boundedBody(response, this.model.bytes, (loaded) => {
        signal.throwIfAborted();
        if (!hit) {
          downloadProgress(loaded);
        }
      });
    } catch (error) {
      if (hit && error.code === "TOO_LARGE") {
        await cache.delete(cached.key);
      }
      throw error;
    }
    signal.throwIfAborted();
    notify("verify", bytes.length, "正在校验模型SHA-256…");
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    if (bytes.length !== this.model.bytes || digest !== this.model.sha256) {
      if (hit) {
        await cache.delete(cached.key);
      }
      throw new AppError("ASR_HASH", "模型校验失败，异常缓存已移除，请重新下载。");
    }
    signal.throwIfAborted();
    if (!hit || cached.key !== this.model.url) {
      notify("save", bytes.length, "正在保存本机模型缓存…");
      await cache.put(
        this.model.url,
        new Response(bytes, {
          headers: {
            "Content-Length": String(bytes.length),
            "Content-Type": "application/octet-stream",
          },
        }),
      );
      if (hit && cached.key !== this.model.url) {
        await cache.delete(cached.key);
      }
    }
    notify("ready", bytes.length, "模型已缓存并通过校验，可以开始本地转写。");
    return bytes;
  }
  async download(progress, signal, sourceId) {
    await this.load(progress, signal, sourceId);
    return this.status();
  }
}
