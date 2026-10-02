import { AppError, assert } from "./core.js";

export class OffscreenAsr {
  constructor() {
    this.pending = new Map();
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (
        sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL("offscreen.html") ||
        message?.type !== "ASR_EVENT"
      ) {
        return;
      }
      const task = this.pending.get(message.id);
      if (!task) {
        return;
      }
      if (message.progress) {
        task.progress(message.progress);
      }
      if (message.done) {
        clearTimeout(task.timer);
        this.pending.delete(message.id);
        if (message.error) {
          task.reject(new AppError("ASR", message.error));
        } else {
          task.resolve(message.result);
        }
      }
    });
  }
  async ensure() {
    if (!this.creating) {
      this.creating = (async () => {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [1801],
          addRules: [
            {
              id: 1801,
              priority: 1,
              action: {
                type: "modifyHeaders",
                requestHeaders: [
                  { header: "Referer", operation: "set", value: "https://www.bilibili.com/" },
                ],
              },
              condition: {
                requestDomains: ["bilivideo.com", "bilivideo.cn"],
                initiatorDomains: [chrome.runtime.id],
                resourceTypes: ["xmlhttprequest"],
              },
            },
          ],
        });
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [chrome.runtime.getURL("offscreen.html")],
        });
        if (!contexts.length) {
          await chrome.offscreen.createDocument({
            url: "offscreen.html",
            reasons: ["WORKERS", "BLOBS"],
            justification: "本地音频解码与CPU语音识别Worker池",
          });
        }
      })().finally(() => {
        this.creating = null;
      });
    }
    return this.creating;
  }
  async transcribe(video, track, concurrency, progress, source = "biliskip") {
    assert(!this.pending.size && !this.starting, "BUSY", "本地转写正在处理另一个视频。");
    this.starting = true;
    try {
      await this.ensure();
    } finally {
      this.starting = false;
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError("ASR_TIMEOUT", "本地转写超过20分钟，请降低并发后重试。"));
        chrome.runtime.sendMessage({ type: "ASR_CANCEL", id }).catch(() => {});
      }, 1200000);
      this.pending.set(id, { resolve, reject, timer, progress });
      chrome.runtime
        .sendMessage({ type: "ASR_RUN", id, video, track, concurrency, source })
        .catch(() => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new AppError("ASR", "语音后台启动失败，请重新加载扩展。"));
        });
    });
  }
}
