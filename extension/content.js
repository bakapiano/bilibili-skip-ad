(() => {
  "use strict";
  globalThis.__biliskipV1?.destroy();
  const lifetime = new AbortController();
  let cleanup;
  function boot() {
    cleanup?.();
    const controller = globalThis.BiliSkipContent({
      hostId: "biliskip-extension-root",
      request: (payload) => chrome.runtime.sendMessage(payload),
      subscribe(listener) {
        const receive = (data, sender) => {
          if (sender.id === chrome.runtime.id) {
            listener(data);
          }
        };
        chrome.runtime.onMessage.addListener(receive);
        return () => chrome.runtime.onMessage.removeListener(receive);
      },
    });
    const panel = globalThis.BiliSkipPlayerPanel({
      id: "biliskip-extension-panel",
      mount(root) {
        const unmount = globalThis.BiliSkipPopup({
          root,
          async background() {
            // Public in-page snapshot only; credentials and settings writes stay in options.html.
            const state = controller.control({ action: "state" });
            return { video: state.video, settings: state.settings };
          },
          command(_tabId, data) {
            try {
              return { ok: true, data: controller.control(data) };
            } catch (error) {
              return {
                ok: false,
                error: { code: error.code || "MESSAGE", message: error.message },
              };
            }
          },
          openOptions: () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }),
        });
        return { destroy: unmount };
      },
    });
    const pet = globalThis.BiliSkipPet?.({
      observe: controller.observe,
      openPanel: () => panel.open(),
      id: "biliskip-extension-pet",
    });
    const onControl = (data, sender, respond) => {
      if (sender.id !== chrome.runtime.id || data.type !== "BILISKIP_CONTROL") {
        return;
      }
      if (sender.url !== chrome.runtime.getURL("popup.html")) {
        respond({ ok: false, error: { code: "SENDER", message: "操作来源应为扩展弹窗。" } });
        return;
      }
      try {
        respond({ ok: true, data: controller.control(data) });
      } catch (error) {
        respond({ ok: false, error: { code: error.code || "MESSAGE", message: error.message } });
      }
    };
    chrome.runtime.onMessage.addListener(onControl);
    cleanup = () => {
      pet?.destroy();
      panel.destroy();
      chrome.runtime.onMessage.removeListener(onControl);
      controller.destroy();
    };
  }
  window.addEventListener("pagehide", () => cleanup?.(), { signal: lifetime.signal });
  window.addEventListener(
    "pageshow",
    (event) => {
      if (event.persisted) {
        boot();
      }
    },
    { signal: lifetime.signal },
  );
  globalThis.__biliskipV1 = {
    destroy() {
      lifetime.abort();
      cleanup?.();
    },
  };
  boot();
})();
