import { ASR_MAX_SECONDS } from "../lib/asr-config.js";
import { AppError, assert } from "../lib/core.js";
import { AsrModelCache } from "../lib/asr-model.js";
import { audioBytes } from "../lib/audio.js";
import { RecognitionPool } from "./pool.js";
import { tokenCues } from "./cues.js";

export class AsrEngine {
  constructor({ fetcher = fetch, modelFetcher = fetcher, createWorker, resources } = {}) {
    this.fetcher = fetcher.bind(globalThis);
    this.models = new AsrModelCache({ fetcher: modelFetcher });
    this.pool = new RecognitionPool(createWorker);
    this.resources =
      resources ||
      (async () => {
        const buffers = await Promise.all(
          ["runtime.wasm", "support.bin"].map(async (file) => {
            const response = await fetch(new URL(`./vendor/${file}`, import.meta.url));
            assert(response.ok, "ASR_RESOURCE", "语音运行时资源读取失败。");
            return response.arrayBuffer();
          }),
        );
        return { binary: buffers[0], support: buffers[1] };
      });
  }
  async model(progress, signal, source) {
    return this.models.load((state) => progress(state.message), signal, source);
  }
  async transcribe(video, track, concurrency, progress = () => {}, source = "biliskip") {
    assert(!this.busy, "BUSY", "另一个视频正在本地转写。");
    assert(video.duration <= ASR_MAX_SECONDS, "ASR_DURATION", "本地转写首版支持60分钟以内视频。");
    assert([1, 2, 4, 6, 8].includes(concurrency), "SETTINGS", "语音并发设置异常。");
    this.busy = true;
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const started = performance.now();
    try {
      progress("正在下载当前视频音轨…");
      const bytes = await audioBytes(track, this.fetcher, signal);
      progress("正在本机解码音频…");
      const context = new OfflineAudioContext(1, 1, 16000);
      const decoded = await context.decodeAudioData(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      signal.throwIfAborted();
      assert(
        Math.abs(decoded.duration - video.duration) <= 3,
        "AUDIO_DURATION",
        "音轨时长与当前视频不符。",
      );
      const pcm = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const source = decoded.getChannelData(channel);
        for (let i = 0; i < pcm.length; i++) {
          pcm[i] += source[i] / decoded.numberOfChannels;
        }
      }
      const weights = await this.model(progress, signal, source);
      const { binary, support } = await this.resources();
      signal.throwIfAborted();
      const model = new Uint8Array(weights.length + support.byteLength);
      model.set(weights);
      model.set(new Uint8Array(support), weights.length);
      await this.pool.load(concurrency, { model: model.buffer, binary }, progress);
      signal.throwIfAborted();
      const result = await this.pool.transcribe(pcm, 0, progress);
      const cues = result.segments
        .flatMap(tokenCues)
        .map((cue) => ({ from: cue.start, to: cue.end, content: cue.text }));
      assert(cues.length, "ASR_EMPTY", "音轨转写完成，未检测到可用语音字幕。");
      return {
        cues,
        metrics: {
          ...result.metrics,
          elapsedMs: Math.round(performance.now() - started),
        },
      };
    } catch (error) {
      if (signal.aborted) {
        throw new AppError("ASR_CANCELLED", "本地语音转写已停止。");
      }
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        "ASR",
        `本地语音转写未完成（${error?.name || "RuntimeError"}），请检查网络、可用内存或降低并发后重试。`,
      );
    } finally {
      this.pool.close();
      this.busy = false;
      this.controller = null;
    }
  }
  close() {
    this.controller?.abort();
    this.pool.close();
  }
}
