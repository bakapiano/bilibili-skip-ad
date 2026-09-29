import { DEFAULT_SETTINGS } from "./lib/constants.js";
import { AppError, assert, fromUrl, safeError, validateSettings, publicRecord } from "./lib/core.js";
import { BilibiliClient } from "./lib/bilibili.js";
import { LocalDB } from "./lib/db.js";
import { DeepSeekClient, SharedClient } from "./lib/providers.js";
import { AnalysisService } from "./lib/service.js";
import { publicSettings, trustedUI, verifyPage, verifyPageSource } from "./lib/messaging.js";

const db = new LocalDB();
const subscribers = new Map();
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await db.open();
  await db.recoverJobs();
})();
async function fullSettings() {
  const data = await chrome.storage.local.get(["settings", "deepseekKey", "sharedToken"]);
  return { ...validateSettings(data.settings || DEFAULT_SETTINGS), apiKey: data.deepseekKey || "", sharedToken: data.sharedToken || "" };
}
const service = new AnalysisService({ db, bili: new BilibiliClient(), model: new DeepSeekClient(), settings: fullSettings,
  shared: new SharedClient(fetch, origin => chrome.permissions.contains({ origins: [origin] })),
  notify(route, payload) {
    for (const tabId of subscribers.get(route) || []) chrome.tabs.sendMessage(tabId, { type: "BILISKIP_PROGRESS", route, ...payload }).catch(() => {});
  },
});
async function pageIdentity(sender, input) {
  verifyPageSource(sender, chrome.runtime.id);
  // A content script survives SPA navigation; sender.url can retain its original
  // document URL. Chrome's current tab URL is the authority for the requested BV/P.
  const current = await chrome.tabs.get(sender.tab.id);
  const requested = verifyPage(sender, input, chrome.runtime.id, current.url);
  const route = service.route(requested);
  for (const [key, tabs] of subscribers) {
    tabs.delete(sender.tab.id);
    if (!tabs.size) subscribers.delete(key);
  }
  if (!subscribers.has(route)) subscribers.set(route, new Set());
  subscribers.get(route).add(sender.tab.id);
  return requested;
}
async function broadcastSettings() {
  const settings = publicSettings(await fullSettings());
  for (const tab of await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" })) {
    chrome.tabs.sendMessage(tab.id, { type: "BILISKIP_SETTINGS", settings }).catch(() => {});
  }
}
async function handle(message, sender) {
  await ready;
  assert(message && typeof message.type === "string", "MESSAGE", "请求格式异常。");
  const ui = trustedUI(sender, chrome.runtime);
  if (message.type === "GET_SETTINGS") {
    assert(ui, "SENDER", "设置仅供扩展页面读取。");
    return publicSettings(await fullSettings());
  }
  if (message.type === "OPEN_OPTIONS") {
    assert(ui || (sender.id === chrome.runtime.id && sender.frameId === 0 && fromUrl(sender.url)), "SENDER", "请求来源异常。");
    await chrome.runtime.openOptionsPage(); return {};
  }
  if (message.type === "SAVE_SETTINGS") {
    assert(ui, "SENDER", "设置仅供扩展页面修改。");
    const current = await fullSettings();
    const settings = validateSettings({ ...current, ...message.settings });
    if (settings.sharedRead || settings.sharedUpload) {
      assert(await chrome.permissions.contains({ origins: [`${settings.sharedBaseUrl}/*`] }), "SHARED_PERMISSION", "请先为共享域名授权。");
    }
    const changes = { settings };
    for (const [field, incoming] of [["deepseekKey", message.apiKey], ["sharedToken", message.sharedToken]]) {
      if (incoming !== undefined && incoming !== "") {
        assert(typeof incoming === "string" && incoming.length >= 8 && incoming.length <= 2048 && !/\s/.test(incoming), "KEY", "密钥格式异常。");
        changes[field] = incoming;
      }
    }
    if (message.clearKey === true) changes.deepseekKey = "";
    if (message.clearSharedToken === true) changes.sharedToken = "";
    await chrome.storage.local.set(changes);
    await broadcastSettings();
    return publicSettings(await fullSettings());
  }
  if (message.type === "GET_CACHE") {
    assert(ui, "SENDER", "缓存管理仅供扩展页面读取。");
    const records = (await db.all("records")).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(row => publicRecord(row));
    return { records, stats: await db.stats(), events: (await db.all("events")).slice(-30) };
  }
  if (message.type === "DELETE_RECORD" || message.type === "CLEAR_CACHE") {
    assert(ui, "SENDER", "缓存管理仅供扩展页面操作。");
    if (message.type === "CLEAR_CACHE") await db.clearRecords();
    else { assert(typeof message.key === "string" && message.key.length < 500, "CACHE", "缓存标识异常。"); await db.remove("records", message.key); }
    return {};
  }
  if (message.type === "GET_ACTIVE") {
    assert(ui, "SENDER", "请求来源异常。");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { tabId: tab?.id, video: fromUrl(tab?.url || ""), settings: publicSettings(await fullSettings()), stats: await db.stats() };
  }
  if (message.type === "GET_PAGE_STATE") {
    const ref = await pageIdentity(sender, message.video);
    try { return { ...await service.prepare(ref), settings: publicSettings(await fullSettings()) }; }
    catch (error) {
      // Keep configured-key/consent state visible even when subtitle loading fails.
      return { record: null, cueCount: 0, error: safeError(error), settings: publicSettings(await fullSettings()) };
    }
  }
  if (message.type === "ANALYZE") {
    const ref = await pageIdentity(sender, message.video);
    assert(typeof message.force === "boolean" && typeof message.automatic === "boolean", "MESSAGE", "分析参数异常。");
    return { ...await service.analyze(ref, { force: message.force, automatic: message.automatic }), settings: publicSettings(await fullSettings()) };
  }
  if (message.type === "SET_AUTO_SKIP") {
    await pageIdentity(sender, message.video);
    assert(typeof message.enabled === "boolean", "SETTINGS", "开关状态异常。");
    const settings = validateSettings({ ...await fullSettings(), autoSkip: message.enabled });
    await chrome.storage.local.set({ settings }); await broadcastSettings(); return publicSettings(await fullSettings());
  }
  if (message.type === "UPLOAD") {
    if (!ui) {
      const ref = await pageIdentity(sender, message.video);
      const row = await db.get("records", message.key);
      assert(row && row.video.bvid === ref.bvid && row.video.page === ref.page, "CACHE", "上传记录与页面不匹配。");
    }
    return service.upload(message.key);
  }
  throw new AppError("MESSAGE", "请求类型异常。");
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: safeError(error) }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { for (const set of subscribers.values()) set.delete(tabId); });
chrome.runtime.onInstalled.addListener(details => { if (details.reason === "install") ready.then(() => chrome.runtime.openOptionsPage()).catch(() => {}); });
