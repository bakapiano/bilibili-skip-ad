const unmount = globalThis.BiliSkipPopup({
  root: document,
  async background(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) {
      throw new Error(result?.error?.message || "扩展请求未完成。");
    }
    return result.data;
  },
  command: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  openOptions: () => chrome.runtime.openOptionsPage(),
});
window.addEventListener("pagehide", unmount, { once: true });
