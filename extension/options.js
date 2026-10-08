import { sharedOrigin } from "./lib/core.js";
import { AsrModelCache } from "./lib/asr-model.js";
import { bindModelSettings } from "./lib/model-settings.js";
import { modelSource } from "./lib/asr-config.js";
import { createAutoSave } from "./lib/auto-save.js";
import { bindSectionNavigation } from "./lib/section-navigation.js";
import { bindPetSettings } from "./lib/pet-settings-view.js";
const $ = (id) => document.getElementById(id);
const stopNavigation = bindSectionNavigation($("settings-nav"));
window.addEventListener("pagehide", stopNavigation, { once: true });
let cache = [];
let cachePage = 1;
let cachePageSize = 10;
const CACHE_PAGE_SIZES = new Set([10, 20, 50]);
let current = {};
let settingsReady = false;
const modelCache = new AsrModelCache();
async function modelPermission(id) {
  const source = modelSource(id);
  if (!source) {
    throw new Error("请选择内置模型下载源。");
  }
  if (!source.origins.length || (await modelCache.status()).cached) {
    return;
  }
  const permission = { origins: source.origins };
  if (
    !(await chrome.permissions.contains(permission)) &&
    !(await chrome.permissions.request(permission))
  ) {
    throw new Error("请授权所选下载源的域名后重试，或选择BiliSkip本站。");
  }
}
const stopModelSettings = bindModelSettings(document, modelCache, {
  beforeDownload: modelPermission,
});
window.addEventListener("pagehide", stopModelSettings, { once: true });
async function call(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) {
    throw new Error(result?.error?.message || "扩展请求未完成。");
  }
  return result.data;
}
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
}
function showSettings(settings) {
  current = settings;
  petSettings.load(settings);
  for (const [id, field] of [
    ["consent", "consent"],
    ["auto-analyze", "autoAnalyze"],
    ["auto-skip", "autoSkip"],
    ["shared-read", "sharedRead"],
    ["shared-upload", "sharedUpload"],
    ["auto-upload", "autoUpload"],
    ["asr-enabled", "asrEnabled"],
    ["asr-upload", "asrUpload"],
    ["short-exempt", "shortVideoExempt"],
  ]) {
    $(id).checked = settings[field];
  }
  updateUploadControls();
  $("threshold").value = settings.confidenceThreshold;
  $("asr-concurrency").value = settings.asrConcurrency;
  $("model-source").value = settings.asrModelSource;
  $("short-minutes").value = settings.shortVideoMinutes;
  $("shared-url").value = settings.sharedBaseUrl;
  $("key-status").textContent = settings.hasKey
    ? "状态：已配置个人 Key。输入框留空会保留当前值。"
    : "状态：缓存模式，可直接读取本地及共享广告标记。";
  $("shared-token").placeholder = settings.hasSharedToken
    ? "共享令牌已配置，留空保留"
    : "可选，与 DeepSeek Key 独立";
  settingsReady = true;
}
function updateUploadControls() {
  $("auto-upload").disabled = !$("shared-upload").checked;
  $("auto-analyze").disabled = !$("consent").checked;
  if (!$("consent").checked) {
    $("auto-analyze").checked = false;
  }
}
const autoSave = createAutoSave({
  save: (message) => call({ type: "SAVE_SETTINGS", ...message }),
});
const petSettings = bindPetSettings($("pet-settings"), {
  save: (settings) => autoSave({ settings }),
});
window.addEventListener("pagehide", () => petSettings.destroy(), { once: true });
const failedSaves = new Map();
let pendingSaves = 0;
function saveStatus() {
  const firstError = failedSaves.values().next().value;
  $("save-status").textContent = firstError
    ? firstError.message
    : pendingSaves
      ? "正在保存…"
      : "已自动保存";
  $("save-status").classList.toggle("error", Boolean(firstError));
  $("retry-save").hidden = !firstError;
}
const fields = [
  ["consent", "consent", "switch"],
  ["auto-analyze", "autoAnalyze", "switch"],
  ["auto-skip", "autoSkip", "switch"],
  ["shared-read", "sharedRead", "switch"],
  ["shared-upload", "sharedUpload", "switch"],
  ["auto-upload", "autoUpload", "switch"],
  ["asr-enabled", "asrEnabled", "switch"],
  ["asr-upload", "asrUpload", "switch"],
  ["short-exempt", "shortVideoExempt", "switch"],
  ["threshold", "confidenceThreshold", "number"],
  ["asr-concurrency", "asrConcurrency", "number"],
  ["short-minutes", "shortVideoMinutes", "number"],
  ["model-source", "asrModelSource", "text"],
  ["shared-url", "sharedBaseUrl", "url"],
  ["api-key", "apiKey", "secret"],
  ["shared-token", "sharedToken", "secret"],
];
for (const [id, field, kind] of fields) {
  const input = $(id);
  let revision = 0;
  const saveInput = async () => {
    const attempt = ++revision;
    const raw = String(input.value).trim();
    pendingSaves++;
    failedSaves.delete(field);
    saveStatus();
    try {
      if (kind === "number" && (!raw || !input.checkValidity())) {
        throw new Error("请填写有效范围内的数字。");
      }
      const value = kind === "switch" ? input.checked : kind === "number" ? Number(raw) : raw;
      const patch =
        kind === "secret" ? {} : { [field]: kind === "url" ? sharedOrigin(value) : value };
      if (field === "consent" && !value) {
        patch.autoAnalyze = false;
      }
      if (kind === "secret" && !value) {
        return;
      }
      if (field === "asrModelSource") {
        await modelPermission(value);
      }
      if (
        field === "sharedBaseUrl" ||
        (["sharedRead", "sharedUpload", "asrUpload"].includes(field) && value)
      ) {
        const origin = patch.sharedBaseUrl || current.sharedBaseUrl;
        if (!origin) {
          throw new Error("请填写共享服务域名。");
        }
        const permission = { origins: [`${origin}/*`] };
        if (
          !(await chrome.permissions.contains(permission)) &&
          !(await chrome.permissions.request(permission))
        ) {
          throw new Error("共享域名授权尚未完成，请重试。");
        }
      }
      if (attempt !== revision) {
        return;
      }
      const message = { settings: patch, ...(kind === "secret" ? { [field]: value } : {}) };
      await autoSave(message, (result) => {
        current = result;
        if (kind === "secret" && input.value.trim() === value) {
          input.value = "";
          if (field === "apiKey") {
            $("key-status").textContent = "个人 Key 已保存";
          } else {
            input.placeholder = "共享令牌已配置，留空保留";
          }
        }
      });
    } catch (error) {
      if (attempt === revision) {
        failedSaves.set(field, { message: error.message, retry: saveInput });
      }
    } finally {
      pendingSaves--;
      saveStatus();
    }
  };
  input.addEventListener("change", (event) => {
    if (event.isTrusted && settingsReady) {
      updateUploadControls();
      return saveInput();
    }
  });
}
$("retry-save").addEventListener("click", (event) => {
  if (event.isTrusted) {
    return Promise.all([...failedSaves.values()].map((failure) => failure.retry()));
  }
});
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.isTrusted) {
    document.activeElement?.blur();
  }
});
async function refreshCache() {
  const data = await call({ type: "GET_CACHE" });
  cache = data.records;
  $("stats").replaceChildren();
  for (const [name, value] of [
    ["本地标记", data.stats.records],
    ["缓存命中记录", data.stats.cacheHits],
    ["模型请求记录", data.stats.apiCalls],
    ["待上传候选", data.stats.pendingUploads],
  ]) {
    const box = document.createElement("div");
    box.className = "stat";
    const number = document.createElement("strong");
    number.textContent = value;
    const title = document.createElement("span");
    title.textContent = name;
    box.append(number, title);
    $("stats").append(box);
  }
  renderCache();
}
function renderCache() {
  const pages = Math.ceil(cache.length / cachePageSize);
  cachePage = Math.max(1, Math.min(cachePage, pages || 1));
  $("cache-page-status").textContent =
    `第 ${pages ? cachePage : 0} / ${pages} 页 · 共 ${cache.length} 条`;
  $("cache-page-size").value = String(cachePageSize);
  $("cache-page-prev").disabled = cachePage <= 1;
  $("cache-page-next").disabled = cachePage >= pages;
  $("cache-list").replaceChildren();
  if (!cache.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "本地数据库已就绪，等待第一条视频标记。";
    $("cache-list").append(empty);
  }
  for (const record of cache.slice((cachePage - 1) * cachePageSize, cachePage * cachePageSize)) {
    const row = document.createElement("article");
    row.className = "cache-row";
    const info = document.createElement("div");
    const title = document.createElement("h3");
    const link = document.createElement("a");
    link.textContent = record.video.title;
    link.href = `https://www.bilibili.com/video/${record.video.bvid}/?p=${record.video.page}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    title.append(link);
    const text = document.createElement("p");
    text.textContent = `${record.video.bvid} · P${record.video.page} · CID ${record.video.cid} · ${record.segments.length} 段广告 · ${record.model}`;
    const summary = document.createElement("p");
    summary.textContent = record.summary;
    const when = document.createElement("p");
    when.textContent = `${new Date(record.createdAt).toLocaleString()} · 字幕 ${record.cueCount} 句 · 指纹 ${record.transcript_sha256.slice(0, 12)}…`;
    info.append(title, text, summary, when);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除这条缓存";
    remove.addEventListener("click", async (event) => {
      if (!event.isTrusted || !confirm("确认删除这条本地标记？再次分析会产生新的模型用量。")) {
        return;
      }
      try {
        await call({ type: "DELETE_RECORD", key: record.key });
        await refreshCache();
        notice("本地标记已删除。");
      } catch (error) {
        notice(error.message, true);
      }
    });
    row.append(info, remove);
    $("cache-list").append(row);
  }
}
for (const [id, delta] of [
  ["cache-page-prev", -1],
  ["cache-page-next", 1],
]) {
  $(id).addEventListener("click", (event) => {
    if (event.isTrusted) {
      cachePage += delta;
      renderCache();
    }
  });
}
$("cache-page-size").addEventListener("change", () => {
  const size = Number($("cache-page-size").value);
  cachePageSize = CACHE_PAGE_SIZES.has(size) ? size : 10;
  cachePage = 1;
  renderCache();
});
$("refresh-cache").addEventListener("click", () =>
  refreshCache().catch((error) => notice(error.message, true)),
);
$("clear-key").addEventListener("click", async (event) => {
  if (!event.isTrusted || !confirm("确认清除当前浏览器保存的 DeepSeek Key？本地标记会保留。")) {
    return;
  }
  try {
    const result = await autoSave({
      settings: { autoAnalyze: false },
      clearKey: true,
    });
    current = result;
    $("auto-analyze").checked = false;
    $("api-key").value = "";
    $("key-status").textContent = "缓存模式，可直接读取已有广告标记。";
    notice("DeepSeek Key 已清除，本地标记已保留。");
  } catch (error) {
    notice(error.message, true);
  }
});
$("clear-cache").addEventListener("click", async (event) => {
  if (!event.isTrusted || !confirm("确认清空本地标记、字幕缓存和待上传候选？Key 与设置会保留。")) {
    return;
  }
  try {
    await call({ type: "CLEAR_CACHE" });
    await refreshCache();
    notice("本地缓存已清空。");
  } catch (error) {
    notice(error.message, true);
  }
});
$("export-cache").addEventListener("click", (event) => {
  if (!event.isTrusted) {
    return;
  }
  const blob = new Blob(
    [JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records: cache }, null, 2)],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "biliskip-markers.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
});
Promise.all([call({ type: "GET_SETTINGS" }).then(showSettings), refreshCache()]).catch((error) =>
  notice(error.message, true),
);
