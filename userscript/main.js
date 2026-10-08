import "../extension/player-core.js";
import "../extension/timeline.js";
import "../extension/content-controller.js";
import "../extension/popup-view.js";
import "../extension/player-assets.js";
import "../extension/player-panel.js";
import "../extension/pet-state.js";
import "../extension/pet-assets.js";
import "../extension/pet.js";
import { assert, safeError } from "../extension/lib/core.js";
import { UserscriptRuntime, SETTINGS_KEY } from "./runtime.js";
import { createPanel } from "./panel.js";
import { userscriptAsr } from "./asr.js";
import { createGMFetch } from "./network.js";

async function start() {
  const [major, minor] = String(GM.info.version).split(".").map(Number);
  assert(
    GM.info.scriptHandler === "Tampermonkey" && (major > 5 || (major === 5 && minor >= 4)),
    "ENVIRONMENT",
    "请使用 Tampermonkey 5.4+ 运行本脚本。",
  );
  let controller;
  let pet;
  const fetcher = createGMFetch(GM);
  const asr = userscriptAsr(GM, fetcher);
  const runtime = new UserscriptRuntime({
    gm: GM,
    fetcher,
    asr,
    location,
    locks: navigator.locks,
    openOptions: () => panel.open(true),
  });
  const configureKey = async () => {
    const key = prompt("BiliSkip：输入个人 DeepSeek API Key，保存在油猴专属存储。取消保留原值。");
    if (key !== null && key.trim()) {
      await runtime.saveKey(key.trim());
    }
  };
  const panel = createPanel({
    runtime,
    enabled: () => Boolean(controller) && !document.getElementById("biliskip-extension-root"),
    control: (data) => {
      assert(
        controller,
        "CONFLICT",
        "检测到 Chrome 版 BiliSkip。请在扩展管理页停用 Chrome 版，再刷新视频页使用油猴版。",
      );
      return controller.control(data);
    },
    configureKey,
  });
  const menuIds = [];
  const menu = async (name, callback) => {
    menuIds.push(
      await GM.registerMenuCommand(name, () => {
        Promise.resolve()
          .then(callback)
          .catch((error) => alert(safeError(error).message));
      }),
    );
  };
  await menu("BiliSkip · 打开面板", () => panel.open());
  await menu("BiliSkip · 设置", () => panel.open(true));
  await menu("BiliSkip · 配置 DeepSeek Key", configureKey);
  // Chrome content scripts and GM sandboxes share DOM, so use a diagnostic node
  // only for detecting a second controller, never as an authority for API calls.
  const hasExtension = () => Boolean(document.getElementById("biliskip-extension-root"));
  if (!hasExtension()) {
    controller = globalThis.BiliSkipContent({
      hostId: "biliskip-userscript-root",
      request: (payload) => runtime.request(payload),
      subscribe: (listener) => runtime.subscribe(listener),
    });
    panel.sync();
    pet = globalThis.BiliSkipPet({
      observe: controller.observe,
      openPanel: () => panel.open(),
      id: "biliskip-userscript-pet",
    });
  }
  const conflictTimer = setInterval(() => {
    if (controller && hasExtension()) {
      pet?.destroy();
      panel.destroy();
      controller.destroy();
      controller = null;
      runtime.fetcher.dispose();
      asr.close();
    }
  }, 400);
  const settingsListener = await GM.addValueChangeListener(
    SETTINGS_KEY,
    (_key, _old, _next, remote) => {
      if (remote) {
        runtime.broadcastSettings().catch(() => {});
      }
    },
  );
  const keyListener = await GM.addValueChangeListener(
    "biliskip:v1:deepseekKey",
    (_key, _old, _next, remote) => {
      if (remote) {
        runtime.broadcastSettings().catch(() => {});
      }
    },
  );
  window.addEventListener(
    "pagehide",
    () => {
      pet?.destroy();
      panel.destroy();
      asr.close();
      controller?.destroy();
      clearInterval(conflictTimer);
      runtime.fetcher.dispose();
      GM.removeValueChangeListener(settingsListener);
      GM.removeValueChangeListener(keyListener);
      for (const id of menuIds) {
        GM.unregisterMenuCommand(id);
      }
    },
    { once: true },
  );
}

function boot() {
  return start().catch((error) => {
    const message = safeError(error).message;
    GM.registerMenuCommand("BiliSkip · 查看启动提示", () => alert(message));
  });
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    boot();
  }
});
boot();
