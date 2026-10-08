// Explicitly synthetic UI demo. No network or model provider is connected here.
(() => {
  let listeners = new Set();
  let state;
  let pet;
  let timer;
  let skipSequence = 0;
  const status = document.getElementById("status");
  const base = () => ({ video: { route: "demo-video:p1" }, stage: "idle", busy: false });
  const emit = (next) => {
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  };
  const create = () => {
    pet?.destroy();
    listeners = new Set();
    state = base();
    pet = globalThis.BiliSkipPet({
      observe(listener) {
        listeners.add(listener);
        listener(state);
        return () => listeners.delete(listener);
      },
      openPanel() {
        status.textContent = "面板入口已触发。B站预览包中会打开实际的视频面板。";
      },
    });
  };
  create();
  for (const button of document.querySelectorAll("[data-demo]")) {
    button.addEventListener("click", () => {
      clearTimeout(timer);
      const type = button.dataset.demo;
      status.textContent = "模拟状态：" + button.textContent;
      if (type === "reset") {
        create();
        return;
      }
      if (type === "cache") {
        emit({ ...base(), record: { key: "demo-cache", source: "shared" } });
      } else if (type === "skip") {
        emit({
          ...base(),
          player: {
            lastSkip: {
              id: ++skipSequence,
              automatic: true,
              route: "demo-video:p1",
              seconds: 49.7,
            },
          },
        });
      } else if (type === "asr") {
        emit({
          ...base(),
          busy: true,
          job: { id: "asr-demo", status: "running", stage: "asr-transcribe" },
        });
      } else if (type === "error") {
        emit({ ...base(), stage: "error" });
      } else {
        const id = crypto.randomUUID();
        emit({
          ...base(),
          busy: true,
          analyzing: true,
          job: { id, status: "running", stage: "model" },
        });
        timer = setTimeout(() => {
          emit({
            ...base(),
            job: {
              id,
              status: "done",
              stage: "done",
              usage: {
                offPeakCny: 0.00075476,
                peakCny: 0.00150952,
                costCny: 0.00075476,
                pricingPeriod: "offPeak",
              },
            },
          });
          status.textContent = "模拟识别完成，金额为固定示例；真实 API 请求为 0。";
        }, 1800);
      }
    });
  }
})();
