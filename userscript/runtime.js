import { DEFAULT_SHARED_URL } from "../extension/lib/constants.js";
import {
  AppError,
  assert,
  fromUrl,
  identity,
  safeError,
  validateSettings,
} from "../extension/lib/core.js";
import { publicSettings } from "../extension/lib/messaging.js";
import { BilibiliClient } from "../extension/lib/bilibili.js";
import { DeepSeekClient, SharedClient } from "../extension/lib/providers.js";
import { AnalysisService } from "../extension/lib/service.js";
import { GMStore } from "./storage.js";
import { createGMFetch } from "./network.js";

export const SETTINGS_KEY = "biliskip:v1:settings";
const KEY_NAME = "biliskip:v1:deepseekKey";

export class UserscriptRuntime {
  constructor({ gm, location, locks, openOptions, fetcher = createGMFetch(gm) }) {
    Object.assign(this, { gm, location, locks, openOptions, fetcher });
    this.listeners = new Set();
    this.db = new GMStore(gm);
    this.service = new AnalysisService({
      db: this.db,
      bili: new BilibiliClient(fetcher),
      model: new DeepSeekClient(fetcher),
      shared: new SharedClient(fetcher, async (origin) => origin === `${DEFAULT_SHARED_URL}/*`),
      settings: () => this.settings(),
      notify: (route, payload) => this.emit({ type: "BILISKIP_PROGRESS", route, ...payload }),
    });
    const upload = this.service.upload.bind(this.service);
    this.service.upload = (key, options) => this.exclusive("upload", () => upload(key, options));
  }
  exclusive(name, callback) {
    assert(this.locks?.request, "LOCK", "请使用具备 Web Locks 的现代浏览器执行分析与上传。");
    return this.locks.request(`biliskip:userscript:${name}`, { ifAvailable: true }, (lock) => {
      assert(lock, "BUSY", "另一个 BiliSkip 标签页正在处理此任务，请稍后读取缓存。");
      return callback();
    });
  }
  async settings() {
    const settings = validateSettings(await this.gm.getValue(SETTINGS_KEY, {}));
    assert(settings.sharedBaseUrl === DEFAULT_SHARED_URL, "SETTINGS", "本版使用内置线上共享服务。");
    return { ...settings, apiKey: await this.gm.getValue(KEY_NAME, ""), sharedToken: "" };
  }
  async saveSettings(patch) {
    return this.exclusive("settings", async () => {
      const settings = validateSettings({ ...(await this.settings()), ...patch });
      assert(
        settings.sharedBaseUrl === DEFAULT_SHARED_URL,
        "SETTINGS",
        "本版使用内置线上共享服务。",
      );
      await this.gm.setValue(SETTINGS_KEY, settings);
      await this.broadcastSettings();
      return publicSettings(await this.settings());
    });
  }
  async saveKey(value) {
    assert(
      typeof value === "string" &&
        (value === "" || (value.length >= 12 && value.length <= 2048 && !/\s/.test(value))),
      "KEY",
      "密钥格式异常。",
    );
    await this.gm.setValue(KEY_NAME, value);
    await this.broadcastSettings();
  }
  async broadcastSettings() {
    this.emit({ type: "BILISKIP_SETTINGS", settings: publicSettings(await this.settings()) });
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(payload) {
    for (const listener of this.listeners) {
      listener(payload);
    }
  }
  verify(input) {
    const actual = fromUrl(this.location.href);
    const requested = identity(input);
    assert(
      actual && actual.bvid === requested.bvid && actual.page === requested.page,
      "SENDER",
      "视频已切换，请等待面板更新后重试。",
    );
    return requested;
  }
  async request(message) {
    try {
      return { ok: true, data: await this.handle(message) };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  }
  async handle(message) {
    if (message.type === "OPEN_OPTIONS") {
      await this.openOptions();
      return {};
    }
    if (message.type === "GET_ACTIVE") {
      return {
        video: fromUrl(this.location.href),
        settings: publicSettings(await this.settings()),
        stats: await this.db.stats(),
      };
    }
    const ref = this.verify(message.video);
    if (message.type === "GET_PAGE_STATE") {
      let result;
      try {
        result = await this.service.prepare(ref, { preferShared: message.preferShared === true });
      } catch (error) {
        result = { record: null, cueCount: 0, error: safeError(error) };
      }
      return { ...result, settings: publicSettings(await this.settings()) };
    }
    if (message.type === "SET_AUTO_SKIP") {
      assert(typeof message.enabled === "boolean", "SETTINGS", "开关状态异常。");
      return this.saveSettings({ autoSkip: message.enabled });
    }
    if (message.type === "ANALYZE") {
      assert(
        typeof message.force === "boolean" && typeof message.automatic === "boolean",
        "MESSAGE",
        "分析参数异常。",
      );
      const result = await this.exclusive("analysis", () =>
        this.service.analyze(ref, {
          force: message.force,
          automatic: message.automatic,
        }),
      );
      return { ...result, settings: publicSettings(await this.settings()) };
    }
    if (message.type === "UPLOAD") {
      const row = await this.db.get("records", message.key);
      assert(
        row && row.video.bvid === ref.bvid && row.video.page === ref.page,
        "CACHE",
        "上传记录与页面不匹配。",
      );
      return this.service.upload(message.key);
    }
    throw new AppError("MESSAGE", "请求类型异常。");
  }
}
