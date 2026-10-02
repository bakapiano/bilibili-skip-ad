export class RecognitionPool {
  constructor(
    createWorker = () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
  ) {
    this.createWorker = createWorker;
    this.workers = [];
    this.pending = new Map();
    this.nextId = 0;
    this.loadingMetrics = [];
  }
  request(worker, type, values = {}, transfer = []) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} exceeded 180 seconds`));
      }, 180000);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type, id, ...values }, transfer);
    });
  }
  async load(count, assets, progress = () => {}) {
    if (![1, 2, 4, 6, 8].includes(count)) {
      throw new Error("Worker count must be 1, 2, 4, 6 or 8");
    }
    this.close();
    const started = performance.now();
    // Stagger initialization to limit temporary simultaneous model buffer copies.
    for (let workerIndex = 0; workerIndex < count; workerIndex++) {
      progress(`初始化 CPU Worker ${workerIndex + 1}/${count}…`);
      const worker = this.createWorker();
      worker.onmessage = ({ data }) => {
        const task = this.pending.get(data.id);
        if (!task) {
          return;
        }
        this.pending.delete(data.id);
        clearTimeout(task.timer);
        if (data.error) {
          task.reject(new Error(data.error));
        } else {
          task.resolve(data.result);
        }
      };
      worker.onerror = (event) => {
        this.close(new Error(event.message || "Worker failed"));
      };
      this.workers.push(worker);
      const model = assets.model.slice(0);
      const binary = assets.binary.slice(0);
      this.loadingMetrics.push(
        await this.request(worker, "load", { model, binary, workerIndex }, [model, binary]),
      );
    }
    return {
      seconds: (performance.now() - started) / 1000,
      workers: [...this.loadingMetrics],
      totalWasmMemoryBytes: this.loadingMetrics.reduce((sum, row) => sum + row.wasmMemoryBytes, 0),
    };
  }
  async transcribe(samples, offset, progress = () => {}) {
    const start = performance.now();
    const vadStartedAt = performance.timeOrigin + start;
    const audioSeconds = samples.length / 16000;
    progress("运行 Silero VAD…");
    const { parts, vadKernelSeconds, vadStageSeconds } = await this.request(
      this.workers[0],
      "vad",
      { samples: samples.buffer },
      [samples.buffer],
    );
    const plan = parts.map(({ index, startSample, sampleCount }) => ({
      index,
      startSample,
      sampleCount,
    }));
    const segments = new Array(parts.length);
    let next = 0;
    let completed = 0;
    const asrStarted = performance.now();
    const asrStartedAt = performance.timeOrigin + asrStarted;
    // Each worker takes the next available original VAD waveform; output order is restored by index.
    await Promise.all(
      this.workers.map(async (worker) => {
        while (next < parts.length) {
          const part = parts[next++];
          segments[part.index] = await this.request(
            worker,
            "decode",
            { ...part, offset, audioSeconds },
            [part.samples],
          );
          completed++;
          progress(
            `ASR ${completed}/${parts.length} 段 · ${((performance.now() - start) / 1000).toFixed(1)} 秒`,
          );
        }
      }),
    );
    const asrWallSeconds = (performance.now() - asrStarted) / 1000;
    const asrEndedAt = performance.timeOrigin + performance.now();
    return {
      segments,
      plan,
      metrics: {
        audioSeconds,
        vadStartedAt,
        asrStartedAt,
        asrEndedAt,
        workers: this.workers.length,
        vadKernelSeconds,
        vadStageSeconds,
        asrWallSeconds,
        inferenceSeconds: (performance.now() - start) / 1000,
        totalDecodeSeconds: segments.reduce((sum, row) => sum + row.decodeSeconds, 0),
        perWorker: this.workers.map((_, index) => ({
          workerIndex: index,
          segments: segments.filter((segment) => segment.workerIndex === index).length,
          decodeSeconds: segments
            .filter((segment) => segment.workerIndex === index)
            .reduce((sum, segment) => sum + segment.decodeSeconds, 0),
          wasmMemoryBytes: Math.max(
            this.loadingMetrics[index].wasmMemoryBytes,
            ...segments
              .filter((segment) => segment.workerIndex === index)
              .map((segment) => segment.wasmMemoryBytes),
          ),
        })),
      },
    };
  }
  close(error = new Error("Worker pool stopped")) {
    for (const worker of this.workers) {
      worker.terminate();
    }
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.workers = [];
    this.pending.clear();
    this.loadingMetrics = [];
  }
}
