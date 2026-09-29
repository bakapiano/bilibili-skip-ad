import popupHtml from "../extension/popup.html";
import popupCss from "../extension/popup.css";
import panelCss from "./panel.css";
import { safeError } from "../extension/lib/core.js";
import { publicSettings } from "../extension/lib/messaging.js";

const fields = [
  ["consent", "同意将当前视频标题和完整字幕发送给 DeepSeek"],
  ["autoAnalyze", "前台视频无缓存时自动分析（按 API 用量计费）"],
  ["autoSkip", "自动跳过广告"],
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
          <p>Key 保存在油猴专属存储，直连 DeepSeek。共享服务为 biliskipad.bakapiano.com。</p>
          <p id="key-state"></p><button id="configure-key" type="button">配置 / 更换 Key</button>
          <button id="clear-key" type="button">清除 Key</button>
          <form id="settings-form"><div id="setting-fields"></div>
            <label>自动跳过阈值 <input id="confidence" type="number" min="0.75" max="1" step="0.01" required /></label>
            <button class="primary" type="submit">保存设置</button>
          </form>
          <p id="settings-status" role="status"></p>
          <p id="cache-stats"></p><button id="clear-cache" type="button">清空油猴本地缓存</button>
        </section>
      </dialog>`;
    document.body.append(host);
    const get = (id) => root.getElementById(id);
    const dialog = root.querySelector("dialog");
    for (const [name, text] of fields) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `setting-${name}`;
      label.append(input, document.createTextNode(text));
      get("setting-fields").append(label);
    }
    root.querySelector("footer").textContent =
      "金色区间为广告。关闭面板后继续分析和跳过；任务跟随当前标签页运行。";
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
      get("key-state").textContent = settings.hasKey
        ? "DeepSeek Key 已配置"
        : "请配置个人 DeepSeek API Key";
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
