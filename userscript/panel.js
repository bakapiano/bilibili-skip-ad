import panelCss from "./panel.css";
import petSettingsCss from "../extension/pet-settings.css";
import { bindPetSettings } from "../extension/lib/pet-settings-view.js";
import { AppError, safeError } from "../extension/lib/core.js";
import { publicSettings } from "../extension/lib/messaging.js";
import { bindModelSettings } from "../extension/lib/model-settings.js";
import { createAutoSave } from "../extension/lib/auto-save.js";
import { bindAsrAvailability } from "./asr-settings.js";

const fields = [
  ["consent", "允许将标题和字幕发送给 DeepSeek", "model-fields"],
  ["autoAnalyze", "前台视频无缓存时自动分析", "playback-fields"],
  ["autoSkip", "自动跳过广告", "playback-fields"],
  ["asrEnabled", "字幕不可用时本地转写", "asr-fields"],
  ["asrUpload", "上传转写字幕用于准确度评估", "asr-fields"],
  ["shortVideoExempt", "启用短视频豁免", "short-video-fields"],
  ["sharedRead", "查询线上共享缓存", "shared-fields"],
  ["sharedUpload", "允许上传广告标记", "shared-fields"],
  ["autoUpload", "分析完成后自动上传", "shared-fields"],
];

const sectionIcon = (name) =>
  `<span class="section-icon" aria-hidden="true">${globalThis.BiliSkipPlayerAssets[`sectionIcon${name}`]}</span>`;

const settingsHtml = `
<section id="settings-panel" hidden>
  <button id="back-to-video" type="button">← 当前视频</button>
  <h2>设置</h2>
  <div class="settings-save"><span id="settings-status" role="status">修改后自动保存</span><button id="retry-save" type="button" hidden>重试</button></div>
  <form id="settings-form">
    <section class="settings-section"><h3>${sectionIcon("model")}模型与隐私</h3>
      <p>共享缓存可直接使用。填写个人 Key 后，可通过 DeepSeek 自行识别，按 API 用量计费。</p>
      <p id="key-state"></p>
      <div class="actions"><button id="configure-key" type="button">配置 / 更换 Key</button><button id="clear-key" type="button">清除 Key</button></div>
      <div id="model-fields"></div><p>Key 保存在油猴专属存储。授权后向 DeepSeek 发送当前视频标题与完整字幕。</p>
    </section>
    <section class="settings-section"><h3>${sectionIcon("playback")}播放行为</h3>
      <div id="playback-fields"></div>
      <label class="value-row" for="confidence">自动跳过最低自评分 <input id="confidence" type="number" min="0.75" max="1" step="0.01" required /></label>
      <p>符合评分和时长保护的区间才会自动跳过。可通过试听和撤销核对边界。</p>
    </section>
    <section class="settings-section" aria-labelledby="asr-heading">
      <h3 id="asr-heading">${sectionIcon("asr")}本地语音转写</h3>
      <div id="asr-fields"></div>
      <p>使用 SenseVoiceSmall INT8 在本机处理音频。字幕上传包含视频信息、完整文本与时间戳，用于准确度评估；上传开关独立于广告标记上传。</p>
      <p id="asr-resource-status" role="status"></p>
      <button id="check-asr-resources" type="button">检查转写资源</button>
      <fieldset id="asr-resource-controls"><legend>转写运行配置</legend>
        <label class="value-row" for="asr-concurrency">CPU 并发数 <select id="asr-concurrency"><option>1</option><option>2</option><option>4</option><option>6</option><option>8</option></select></label>
        <p>每路约512MiB WASM内存，支持60分钟以内音轨。缓存模式可手动转写后查询已有标记。</p>
        <label for="model-source">模型下载源</label><select id="model-source"><option value="biliskip">BiliSkip 本站</option><option value="hf-mirror">HF-Mirror 镜像</option><option value="huggingface">Hugging Face 原站</option></select>
        <p>模型约239MB，各源使用相同文件并校验SHA-256，缓存跨源复用。下载期间保持面板打开。</p>
        <button id="download-model" type="button">下载模型</button>
      </fieldset>
      <p id="model-status" role="status">正在检查模型缓存…</p>
      <progress id="model-download-progress" max="100" value="0" hidden aria-label="模型下载进度"></progress>
      <div class="actions"><button id="cancel-model-download" type="button" hidden>取消下载</button><button id="check-model-cache" type="button">检查缓存</button></div>
    </section>
    <section class="settings-section" id="short-video-section" aria-labelledby="short-video-heading">
      <h3 id="short-video-heading">${sectionIcon("short")}短视频豁免</h3><div id="short-video-fields"></div>
      <label class="value-row" for="short-minutes">视频短于多少分钟 <input id="short-minutes" type="number" min="0" max="180" step="0.1" required /></label>
      <p>支持小数。小于该时长时保留完整视频，跳过字幕获取、本地转写、广告分析与标记应用。</p>
    </section>
    <section class="settings-section" id="pet-section"><h3>${sectionIcon("pet")}宠物</h3><div id="pet-settings"></div></section>
    <section class="settings-section"><h3>${sectionIcon("shared")}共享缓存</h3><div id="shared-fields"></div>
      <p>由 biliskipad.bakapiano.com 提供。查询发送视频标识和字幕指纹；上传包含视频信息、广告标记与有限证据，零广告结果同样可复用。</p>
    </section>
  </form>
  <section class="settings-section"><h3>${sectionIcon("cache")}本地缓存</h3><p id="cache-stats"></p><button id="clear-cache" type="button">清空油猴本地缓存</button></section>
</section>`;

export function createPanel({ runtime, control, configureKey, enabled }) {
  return globalThis.BiliSkipPlayerPanel({
    id: "biliskip-userscript-panel",
    enabled,
    extraHtml: settingsHtml,
    extraCss: panelCss + "\n" + petSettingsCss,
    mount(root) {
      const get = (id) => root.getElementById(id);
      let closed = false;
      let ready = false;
      const failedSaves = new Map();
      let pendingSaves = 0;
      const status = (message, error = false) => {
        if (!closed) {
          get("settings-status").textContent = message;
          get("settings-status").classList.toggle("error", error);
        }
      };
      const report = (error) => status(safeError(error).message, true);
      const autoSave = createAutoSave({ save: (patch) => runtime.saveSettings(patch) });
      const petSettings = bindPetSettings(get("pet-settings"), { save: autoSave });
      const saveStatus = () => {
        if (closed) {
          return;
        }
        const failure = failedSaves.values().next().value;
        status(
          failure ? failure.message : pendingSaves ? "正在保存…" : "已自动保存",
          Boolean(failure),
        );
        get("retry-save").hidden = !failure;
      };
      const showSettings = () => {
        get("settings-panel").hidden = false;
        root.querySelector("main").hidden = true;
        root.querySelector(".drawer-scroll").scrollTop = 0;
        if (ready && !pendingSaves && !failedSaves.size) {
          void loadSettings().catch(report);
        }
      };
      const bind = (id, callback, type = "click") => {
        get(id).addEventListener(type, (event) => {
          if (event.isTrusted) {
            if (type === "click") {
              event.preventDefault();
            }
            try {
              return Promise.resolve(callback()).catch(report);
            } catch (error) {
              report(error);
            }
          }
        });
      };
      const updateSwitches = () => {
        get("setting-autoUpload").disabled = !get("setting-sharedUpload").checked;
        get("setting-autoAnalyze").disabled = !get("setting-consent").checked;
        if (!get("setting-consent").checked) {
          get("setting-autoAnalyze").checked = false;
        }
      };
      const revisions = new Map();
      const queueSave = async (key, read) => {
        const revision = (revisions.get(key) || 0) + 1;
        revisions.set(key, revision);
        failedSaves.delete(key);
        pendingSaves++;
        saveStatus();
        try {
          await autoSave(read());
        } catch (error) {
          if (revisions.get(key) === revision) {
            failedSaves.set(key, {
              message: safeError(error).message,
              retry: () => queueSave(key, read),
            });
          }
        } finally {
          pendingSaves--;
          saveStatus();
        }
      };
      for (const [name, text, target] of fields) {
        const label = document.createElement("label");
        label.className = "switch-row";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.setAttribute("role", "switch");
        input.id = `setting-${name}`;
        const caption = document.createElement("span");
        caption.textContent = text;
        label.append(input, caption);
        get(target).append(label);
        bind(
          input.id,
          () => {
            if (ready) {
              updateSwitches();
              return queueSave(name, () => ({
                [name]: input.checked,
                ...(name === "consent" && !input.checked ? { autoAnalyze: false } : {}),
              }));
            }
          },
          "change",
        );
      }
      for (const [id, field, number] of [
        ["confidence", "confidenceThreshold", true],
        ["asr-concurrency", "asrConcurrency", true],
        ["short-minutes", "shortVideoMinutes", true],
        ["model-source", "asrModelSource", false],
      ]) {
        bind(
          id,
          () => {
            if (!ready) {
              return;
            }
            return queueSave(field, () => {
              const input = get(id);
              if (number && (!input.value.trim() || !input.checkValidity())) {
                throw new AppError("SETTINGS", "请填写有效范围内的数字。");
              }
              return { [field]: number ? Number(input.value) : input.value };
            });
          },
          "change",
        );
      }
      const stopAsrAvailability = bindAsrAvailability(root, runtime.asr.availability);
      const stopModelSettings = bindModelSettings(root, runtime.asr.models, {
        beforeDownload: () => runtime.asr.ensureAvailable(),
      });
      const loadSettings = async () => {
        const settings = publicSettings(await runtime.settings());
        if (closed || pendingSaves || failedSaves.size) {
          return;
        }
        for (const [name] of fields) {
          get(`setting-${name}`).checked = settings[name];
        }
        get("confidence").value = String(settings.confidenceThreshold);
        get("asr-concurrency").value = String(settings.asrConcurrency);
        get("model-source").value = settings.asrModelSource;
        get("short-minutes").value = String(settings.shortVideoMinutes);
        petSettings.load(settings);
        get("key-state").textContent = settings.hasKey
          ? "DeepSeek Key 已配置"
          : "缓存模式 · 可直接复用已有标记";
        updateSwitches();
        ready = true;
        const stats = await runtime.db.stats();
        if (!closed) {
          get("cache-stats").textContent =
            `本地 ${stats.records} 条标记 · 待提交 ${stats.pendingUploads} 条`;
        }
      };
      bind("back-to-video", () => {
        get("settings-panel").hidden = true;
        root.querySelector("main").hidden = false;
        root.querySelector(".drawer-scroll").scrollTop = 0;
      });
      bind("retry-save", () =>
        Promise.all([...failedSaves.values()].map((failure) => failure.retry())),
      );
      get("settings-form").addEventListener("submit", (event) => {
        event.preventDefault();
        if (event.isTrusted) {
          root.activeElement?.blur();
        }
      });
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
          status("本地缓存已清空。");
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
        openOptions: showSettings,
      });
      const unsubscribe = runtime.subscribe((message) => {
        if (message.type === "BILISKIP_SETTINGS" && !pendingSaves && !failedSaves.size) {
          void loadSettings().catch(report);
        }
      });
      return {
        showSettings,
        ready: loadSettings().catch(report),
        destroy() {
          closed = true;
          unsubscribe();
          stopAsrAvailability();
          stopModelSettings();
          petSettings.destroy();
          unmount();
        },
      };
    },
  });
}
