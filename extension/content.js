(() => {
  "use strict";
  globalThis.__biliskipV1?.destroy();
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
  globalThis.__biliskipV1 = {
    destroy() {
      chrome.runtime.onMessage.removeListener(onControl);
      controller.destroy();
    },
  };
})();
