import { sharedOrigin } from "./lib/core.js";
const $ = id => document.getElementById(id);
let cache = [], current = {};
async function call(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error?.message || "扩展请求未完成。");
  return result.data;
}
function notice(text, error = false) { $("notice").textContent = text; $("notice").classList.toggle("error", error); }
function showSettings(settings) {
  current = settings;
  for (const [id, field] of [["consent", "consent"], ["auto-analyze", "autoAnalyze"], ["auto-skip", "autoSkip"], ["shared-read", "sharedRead"], ["shared-upload", "sharedUpload"]]) $(id).checked = settings[field];
  $("threshold").value = settings.confidenceThreshold;
  $("shared-url").value = settings.sharedBaseUrl;
  $("key-status").textContent = settings.hasKey ? "状态：已配置个人 Key。输入框留空会保留当前值。" : "状态：等待配置个人 Key。";
  $("shared-token").placeholder = settings.hasSharedToken ? "共享令牌已配置，留空保留" : "可选，与 DeepSeek Key 独立";
}
function readForm() {
  return { consent: $("consent").checked, autoAnalyze: $("auto-analyze").checked, autoSkip: $("auto-skip").checked,
    confidenceThreshold: Number($("threshold").value), sharedBaseUrl: sharedOrigin($("shared-url").value.trim()),
    sharedRead: $("shared-read").checked, sharedUpload: $("shared-upload").checked };
}
$("settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!event.isTrusted) return;
  $("save").disabled = true;
  try {
    const settings = readForm();
    if (settings.sharedRead || settings.sharedUpload) {
      if (!settings.sharedBaseUrl) throw new Error("请填写共享服务域名。");
      const granted = await chrome.permissions.request({ origins: [`${settings.sharedBaseUrl}/*`] });
      if (!granted) throw new Error("共享域名授权尚未完成，原设置保持不变。");
    }
    const result = await call({ type: "SAVE_SETTINGS", settings, apiKey: $("api-key").value.trim(), sharedToken: $("shared-token").value.trim() });
    $("api-key").value = ""; $("shared-token").value = "";
    showSettings(result); notice("设置已保存。现在可以回到 B站视频页进行分析。");
  } catch (error) { notice(error.message, true); }
  finally { $("save").disabled = false; }
});
async function refreshCache() {
  const data = await call({ type: "GET_CACHE" }); cache = data.records;
  $("stats").replaceChildren();
  for (const [name, value] of [["本地标记", data.stats.records], ["缓存命中记录", data.stats.cacheHits], ["模型请求记录", data.stats.apiCalls], ["待上传候选", data.stats.pendingUploads]]) {
    const box = document.createElement("div"); box.className = "stat";
    const number = document.createElement("strong"); number.textContent = value;
    const title = document.createElement("span"); title.textContent = name; box.append(number, title); $("stats").append(box);
  }
  $("cache-list").replaceChildren();
  if (!cache.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "本地数据库已就绪，等待第一条视频标记。"; $("cache-list").append(empty); }
  for (const record of cache) {
    const row = document.createElement("article"); row.className = "cache-row";
    const info = document.createElement("div"), title = document.createElement("h3"), link = document.createElement("a");
    link.textContent = record.video.title; link.href = `https://www.bilibili.com/video/${record.video.bvid}/?p=${record.video.page}`; link.target = "_blank"; link.rel = "noopener noreferrer"; title.append(link);
    const text = document.createElement("p"); text.textContent = `${record.video.bvid} · P${record.video.page} · CID ${record.video.cid} · ${record.segments.length} 段广告 · ${record.model}`;
    const summary = document.createElement("p"); summary.textContent = record.summary;
    const when = document.createElement("p"); when.textContent = `${new Date(record.createdAt).toLocaleString()} · 字幕 ${record.cueCount} 句 · 指纹 ${record.transcript_sha256.slice(0, 12)}…`;
    info.append(title, text, summary, when);
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "删除这条缓存";
    remove.addEventListener("click", async event => {
      if (!event.isTrusted || !confirm("确认删除这条本地标记？再次分析会产生新的模型用量。")) return;
      try { await call({ type: "DELETE_RECORD", key: record.key }); await refreshCache(); notice("本地标记已删除。"); } catch (error) { notice(error.message, true); }
    });
    row.append(info, remove); $("cache-list").append(row);
  }
}
$("refresh-cache").addEventListener("click", () => refreshCache().catch(error => notice(error.message, true)));
$("clear-key").addEventListener("click", async event => {
  if (!event.isTrusted || !confirm("确认清除当前浏览器保存的 DeepSeek Key？本地标记会保留。")) return;
  try { showSettings(await call({ type: "SAVE_SETTINGS", settings: { ...current, autoAnalyze: false }, clearKey: true })); notice("DeepSeek Key 已清除，本地标记已保留。"); }
  catch (error) { notice(error.message, true); }
});
$("clear-cache").addEventListener("click", async event => {
  if (!event.isTrusted || !confirm("确认清空本地标记、字幕缓存和待上传候选？Key 与设置会保留。")) return;
  try { await call({ type: "CLEAR_CACHE" }); await refreshCache(); notice("本地缓存已清空。"); }
  catch (error) { notice(error.message, true); }
});
$("export-cache").addEventListener("click", event => {
  if (!event.isTrusted) return;
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records: cache }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = "biliskip-markers.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
});
Promise.all([call({ type: "GET_SETTINGS" }).then(showSettings), refreshCache()]).catch(error => notice(error.message, true));
