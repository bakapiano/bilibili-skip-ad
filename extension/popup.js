let active;
const status = document.getElementById("status"), analyze = document.getElementById("analyze");
async function call(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error?.message || "扩展请求未完成。");
  return result.data;
}
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
analyze.addEventListener("click", async event => {
  if (!event.isTrusted || !active?.video) return;
  if (!active.settings.hasKey || !active.settings.consent) { await chrome.runtime.openOptionsPage(); return; }
  try { await chrome.tabs.sendMessage(active.tabId, { type: "BILISKIP_ANALYZE_FROM_POPUP" }); status.textContent = "请求已交给视频页，进度可在页面面板中查看。"; }
  catch { status.textContent = "请刷新 B站视频页，让扩展加载完成后重试。"; }
});
call({ type: "GET_ACTIVE" }).then(data => {
  active = data;
  status.textContent = `${data.video ? `${data.video.bvid} · P${data.video.page}` : "请打开 B站标准视频页。"}\n${data.settings.hasKey ? "DeepSeek Key 已配置" : "等待配置 DeepSeek Key"}\n本地标记 ${data.stats.records} 条 · 模型请求记录 ${data.stats.apiCalls} 次`;
  analyze.disabled = !data.video;
  analyze.textContent = !data.settings.hasKey || !data.settings.consent ? "设置 Key 与字幕授权" : "分析当前视频（优先缓存）";
}).catch(error => { status.textContent = error.message; });
