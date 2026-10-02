import popupHtml from "../extension/popup.html";
import popupCss from "../extension/popup.css";
import panelCss from "./panel.css";
import { safeError } from "../extension/lib/core.js";
import { publicSettings } from "../extension/lib/messaging.js";
import { bindModelSettings } from "../extension/lib/model-settings.js";
import { bindAsrAvailability } from "./asr-settings.js";

const fields = [
  ["consent", "同意将当前视频标题和完整字幕发送给 DeepSeek"],
  ["autoAnalyze", "前台视频无缓存时自动分析（按 API 用量计费）"],
  ["autoSkip", "自动跳过广告"],
  ["asrEnabled", "字幕不可用时本地转写（默认关闭；首次下载约239MB；音频留在本机）"],
  ["asrUpload", "上传转写字幕用于准确度评估（默认开启）"],
  ["shortVideoExempt", "短视频豁免：同时跳过ASR、广告分析和广告跳过"],
  ["sharedRead", "查询线上共享缓存"],
  ["sharedUpload", "允许上传广告标记和有限证据句"],
  ["autoUpload", "分析完成后自动上传（包括零广告结果）"],
];

export function createPanel({ runtime, control, configureKey }) {
  let closeCurrent;
  let focusSettings;
  async function open(showSettings = false) {
    if (closeCurrent) {
      if (showSettings) {
        focusSettings();
      }
      return;
    }
    const host = document.createElement("div");
    host.id = "biliskip-userscript-panel";
    const root = host.attachShadow({ mode: "closed" });
    // These strings are repository-owned, bundled at build time. External titles,
    // segments and errors are rendered by textContent in the shared popup view.
    root.innerHTML = `<style>${popupCss.replace(":root", ":host")}\n${panelCss}</style>
      <dialog aria-label="BiliSkip 油猴版">
        <button id="close-panel" type="button" aria-label="关闭面板">关闭</button>
        ${popupHtml.match(/<main\b[\s\S]*?<\/main>/)[0]}
        <section id="settings-panel" hidden><h2>油猴版设置</h2>
          <p>共享缓存可直接使用。可选的 DeepSeek Key 用于自行识别，保存在油猴专属存储。共享服务为 biliskipad.bakapiano.com。</p>
          <p id="key-state"></p><button id="configure-key" type="button">配置 / 更换 Key</button>
          <button id="clear-key" type="button">清除 Key</button>
          <form id="settings-form"><div id="setting-fields"></div>
            <label>自动跳过阈值 <input id="confidence" type="number" min="0.75" max="1" step="0.01" required /></label>
            <section class="settings-section" aria-labelledby="asr-heading">
              <h3 id="asr-heading">本地语音转写</h3>
              <div id="asr-fields"></div>
              <p>转写上传包含视频信息、完整转写文本及时间戳、字幕指纹与模型版本，发送至共享服务。此开关独立于广告标记上传，免Key缓存模式同样遵循，可随时关闭。</p>
              <p id="asr-resource-status" role="status"></p>
              <button id="check-asr-resources" type="button">检查转写资源</button>
              <fieldset id="asr-resource-controls">
              <legend>转写运行配置</legend>
              <label>CPU 并发数 <select id="asr-concurrency"><option>1</option><option>2</option><option>4</option><option>6</option><option>8</option></select></label>
              <p>默认2路；每路约512MiB WASM内存，缓冲另计。支持60分钟以内音轨。缓存模式可手动转写后匹配共享标记；配置Key并授权后可用DeepSeek自行识别。</p>
              <label>模型下载源 <select id="model-source"><option value="biliskip">BiliSkip 本站</option><option value="hf-mirror">HF-Mirror 镜像</option><option value="huggingface">Hugging Face 原站</option></select></label>
              <p>各源提供相同模型，下载后统一校验文件大小和SHA-256，缓存跨下载源复用。下载时保持此面板打开，保存设置后自动转写沿用所选源。</p>
              <button id="download-model" type="button">下载模型</button>
              </fieldset>
              <p id="model-status" role="status">正在检查模型缓存…</p>
              <progress id="model-download-progress" max="100" value="0" hidden aria-label="模型下载进度"></progress>
              <div>
                <button id="cancel-model-download" type="button" hidden>取消下载</button>
                <button id="check-model-cache" type="button">检查缓存</button>
              </div>
            </section>
            <section class="settings-section" id="short-video-section" aria-labelledby="short-video-heading">
              <h3 id="short-video-heading">短视频豁免</h3>
              <div id="short-video-fields"></div>
              <label>视频短于多少分钟时豁免（支持小数） <input id="short-minutes" type="number" min="0" max="180" step="0.1" required /></label>
              <p>小于此时长时保留完整视频，跳过字幕获取、本地转写、广告分析和缓存标记应用。默认关闭，预设3分钟。</p>
            </section>
            <button class="primary" type="submit">保存设置</button>
          </form>
          <p id="settings-status" role="status"></p>
          <p id="cache-stats"></p><button id="clear-cache" type="button">清空油猴本地缓存</button>
        </section>
      </dialog>`;
    document.body.append(host);
    const get = (id) => root.getElementById(id);
    const dialog = root.querySelector("dialog");
    const stopModelSettings = bindModelSettings(root, runtime.asr.models, {
      beforeDownload: () => runtime.asr.ensureAvailable(),
    });
    for (const [name, text] of fields) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `setting-${name}`;
      label.append(input, document.createTextNode(text));
      const target = ["asrEnabled", "asrUpload"].includes(name)
        ? "asr-fields"
        : name === "shortVideoExempt"
          ? "short-video-fields"
          : "setting-fields";
      get(target).append(label);
    }
    const stopAsrAvailability = bindAsrAvailability(root, runtime.asr.availability);
    root.querySelector("footer").textContent =
      "金色区间为符合跳过条件的广告。关闭面板后继续分析和跳过；任务跟随当前标签页运行。";
    const status = (message) => {
      get("settings-status").textContent = message;
    };
    const report = (error) => status(safeError(error).message);
    const loadSettings = async () => {
      const settings = publicSettings(await runtime.settings());
      for (const [name] of fields) {
        get(`setting-${name}`).checked = settings[name];
      }
      get("confidence").value = String(settings.confidenceThreshold);
      get("asr-concurrency").value = String(settings.asrConcurrency);
      get("model-source").value = settings.asrModelSource;
      get("short-minutes").value = String(settings.shortVideoMinutes);
      get("key-state").textContent = settings.hasKey
        ? "DeepSeek Key 已配置"
        : "缓存模式：可直接读取本地及共享广告标记";
      updateSwitches();
      const stats = await runtime.db.stats();
      get("cache-stats").textContent =
        `本地 ${stats.records} 条标记 · 待提交 ${stats.pendingUploads} 条`;
    };
    function updateSwitches() {
      get("setting-autoUpload").disabled = !get("setting-sharedUpload").checked;
      get("setting-autoAnalyze").disabled = !get("setting-consent").checked;
      if (!get("setting-consent").checked) {
        get("setting-autoAnalyze").checked = false;
      }
    }
    focusSettings = () => {
      get("settings-panel").hidden = false;
      get("settings-panel").scrollIntoView({ block: "nearest" });
    };
    const bind = (id, callback, type = "click") => {
      get(id).addEventListener(type, (event) => {
        event.preventDefault();
        if (event.isTrusted) {
          Promise.resolve().then(callback).catch(report);
        }
      });
    };
    bind("configure-key", async () => {
      await configureKey();
      await loadSettings();
    });
    bind("clear-key", async () => {
      if (confirm("清除油猴版保存的 DeepSeek Key？")) {
        await runtime.saveKey("");
        await loadSettings();
        status("Key 已清除。");
      }
    });
    bind(
      "settings-form",
      async () => {
        const patch = Object.fromEntries(
          fields.map(([name]) => [name, get(`setting-${name}`).checked]),
        );
        patch.confidenceThreshold = Number(get("confidence").value);
        patch.asrConcurrency = Number(get("asr-concurrency").value);
        patch.asrModelSource = get("model-source").value;
        patch.shortVideoMinutes = Number(get("short-minutes").value);
        await runtime.saveSettings(patch);
        status("设置已保存。");
      },
      "submit",
    );
    for (const name of ["consent", "sharedUpload"]) {
      get(`setting-${name}`).addEventListener("change", updateSwitches);
    }
    bind("clear-cache", async () => {
      if (control({ action: "state" }).busy) {
        status("当前任务正在进行，请完成后清理缓存。");
        return;
      }
      if (confirm("清空油猴版的本地标记与上传记录？Key 和设置会保留。")) {
        await runtime.exclusive("analysis", () =>
          runtime.exclusive("upload", () => runtime.db.clearRecords()),
        );
        await loadSettings();
        status("本地缓存已清空。当前播放器保留已加载标记，读取缓存可刷新状态。");
      }
    });
    const unmount = globalThis.BiliSkipPopup({
      root,
      background: (message) => runtime.handle(message),
      command(_tabId, data) {
        try {
          return { ok: true, data: control(data) };
        } catch (error) {
          return { ok: false, error: { code: error.code || "MESSAGE", message: error.message } };
        }
      },
      openOptions: focusSettings,
    });
    closeCurrent = () => {
      stopAsrAvailability();
      stopModelSettings();
      unmount();
      host.remove();
      closeCurrent = null;
    };
    bind("close-panel", () => dialog.close());
    dialog.addEventListener("close", () => closeCurrent?.());
    dialog.showModal();
    if (showSettings) {
      focusSettings();
    }
    await loadSettings().catch(report);
  }
  return { open, close: () => closeCurrent?.() };
}
