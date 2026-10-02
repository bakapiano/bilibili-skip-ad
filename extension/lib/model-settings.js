// Shared settings UI. Downloading model data is independent of ASR and API consent switches.
export function bindModelSettings(root, modelCache, { beforeDownload = async () => {} } = {}) {
  const get = (id) => root.getElementById(id);
  const button = get("download-model");
  const cancel = get("cancel-model-download");
  const refresh = get("check-model-cache");
  const status = get("model-status");
  const progress = get("model-download-progress");
  const source = get("model-source");
  const lifetime = new AbortController();
  let controller;
  let closed = false;
  const text = (message) => {
    status.textContent = message;
  };
  const check = async () => {
    if (controller) {
      return;
    }
    try {
      const state = await modelCache.status();
      if (!closed && !controller) {
        text(
          state.cached
            ? "模型已缓存（约239MB），使用前自动校验。"
            : "模型待下载（约239MB）。可先下载，再按需开启本地转写。",
        );
        button.textContent = state.cached ? "校验已缓存模型" : "下载模型";
      }
    } catch (error) {
      if (!closed) {
        text(error.message || "模型缓存检查失败。");
      }
    }
  };
  button.addEventListener(
    "click",
    async (event) => {
      if (!event.isTrusted || controller) {
        return;
      }
      controller = new AbortController();
      button.disabled = true;
      refresh.disabled = true;
      source.disabled = true;
      cancel.hidden = false;
      progress.hidden = false;
      progress.value = 0;
      try {
        // Called directly from the user gesture so Chrome can request optional host access.
        await beforeDownload(source.value || "biliskip");
        await modelCache.download(
          (state) => {
            if (!closed) {
              text(state.message);
              progress.value = state.total ? (state.loaded / state.total) * 100 : 0;
            }
          },
          controller.signal,
          source.value || "biliskip",
        );
        button.textContent = "校验已缓存模型";
      } catch (error) {
        if (!closed) {
          text(error.message || "模型下载未完成，请重试。");
        }
      } finally {
        controller = null;
        if (!closed) {
          button.disabled = false;
          refresh.disabled = false;
          source.disabled = false;
          cancel.hidden = true;
        }
      }
    },
    { signal: lifetime.signal },
  );
  cancel.addEventListener(
    "click",
    (event) => {
      if (event.isTrusted) {
        controller?.abort();
      }
    },
    { signal: lifetime.signal },
  );
  refresh.addEventListener(
    "click",
    (event) => {
      if (event.isTrusted) {
        void check();
      }
    },
    { signal: lifetime.signal },
  );
  void check();
  return () => {
    closed = true;
    controller?.abort();
    lifetime.abort();
  };
}
