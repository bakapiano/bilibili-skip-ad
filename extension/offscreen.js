import { AsrEngine } from "./asr/engine.js";
const engine = new AsrEngine();
let active;
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("background.js")) {
    return;
  }
  if (message.type === "ASR_CANCEL" && message.id === active) {
    engine.close();
    return;
  }
  if (message.type !== "ASR_RUN") {
    return;
  }
  const send = (data) =>
    chrome.runtime.sendMessage({ type: "ASR_EVENT", id: message.id, ...data }).catch(() => {});
  if (active) {
    void send({ done: true, error: "另一个本地转写任务仍在运行，请完成后重试。" });
    return;
  }
  active = message.id;
  let latest = "正在本地转写…";
  const heartbeat = setInterval(() => void send({ progress: latest }), 10000);
  engine
    .transcribe(
      message.video,
      message.track,
      message.concurrency,
      (progress) => {
        latest = progress;
        void send({ progress });
      },
      message.source,
    )
    .then(
      (result) => send({ done: true, result }),
      (error) => send({ done: true, error: error.message }),
    )
    .finally(() => {
      clearInterval(heartbeat);
      active = null;
    });
});
