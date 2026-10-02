import { createSherpa } from "./vendor/runtime.js";
import { OfflineRecognizer } from "./vendor/sherpa-onnx-asr.js";
import { Vad } from "./vendor/sherpa-onnx-vad.js";
const SAMPLE_RATE = 16000;
let runtime;
let recognizer;
let vad;
let workerIndex;
let busy = false;
const logs = [];

async function load(data) {
  const start = performance.now();
  workerIndex = data.workerIndex;
  runtime = await createSherpa({
    noInitialRun: true,
    wasmBinary: new Uint8Array(data.binary),
    getPreloadedPackage: () => data.model,
    print: (text) => logs.push(String(text)),
    printErr: (text) => logs.push(String(text)),
  });
  recognizer = new OfflineRecognizer(
    {
      modelConfig: {
        tokens: "./tokens.txt",
        numThreads: 1,
        provider: "cpu",
        debug: 0,
        senseVoice: {
          model: "./sense-voice.onnx",
          language: "auto",
          useInverseTextNormalization: 1,
        },
      },
    },
    runtime,
  );
  if (workerIndex === 0) {
    vad = new Vad(
      {
        sileroVad: {
          model: "./silero_vad.onnx",
          threshold: 0.5,
          minSilenceDuration: 0.4,
          minSpeechDuration: 0.2,
          maxSpeechDuration: 12,
          windowSize: 512,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        provider: "cpu",
        debug: 0,
        bufferSizeInSeconds: 40,
      },
      runtime,
    );
  }
  if (!recognizer.handle || (workerIndex === 0 && !vad.handle)) {
    throw new Error("ASR or VAD initialization failed");
  }
  runtime.getPreloadedPackage = undefined;
  runtime.wasmBinary = undefined;
  return {
    workerIndex,
    initSeconds: (performance.now() - start) / 1000,
    wasmMemoryBytes: runtime.HEAPU8.buffer.byteLength,
    sharedWasmMemory:
      typeof SharedArrayBuffer !== "undefined" &&
      runtime.HEAPU8.buffer instanceof SharedArrayBuffer,
    requestedModelThreads: 1,
    logs,
  };
}

function segmentAudio(data) {
  const samples = new Float32Array(data.samples);
  const start = performance.now();
  const parts = [];
  let kernelSeconds = 0;
  vad.reset();
  function drain() {
    while (!vad.isEmpty()) {
      const part = vad.front();
      vad.pop();
      parts.push({
        index: parts.length,
        startSample: part.start,
        sampleCount: part.samples.length,
        samples: part.samples.buffer,
      });
    }
  }
  for (let position = 0; position < samples.length; position += 512) {
    const block = new Float32Array(512);
    block.set(samples.subarray(position, Math.min(samples.length, position + 512)));
    const before = performance.now();
    vad.acceptWaveform(block);
    kernelSeconds += (performance.now() - before) / 1000;
    drain();
  }
  vad.flush();
  drain();
  return {
    parts,
    vadKernelSeconds: kernelSeconds,
    vadStageSeconds: (performance.now() - start) / 1000,
  };
}

function decode(data) {
  const startedAt = performance.timeOrigin + performance.now();
  const samples = new Float32Array(data.samples);
  const stream = recognizer.createStream();
  let result;
  try {
    stream.acceptWaveform(SAMPLE_RATE, samples);
    recognizer.decode(stream);
    result = recognizer.getResult(stream);
  } finally {
    stream.free();
  }
  const endedAt = performance.timeOrigin + performance.now();
  return {
    index: data.index,
    start: data.startSample / SAMPLE_RATE + data.offset,
    end: Math.min(
      data.offset + data.audioSeconds,
      (data.startSample + samples.length) / SAMPLE_RATE + data.offset,
    ),
    text: (result.text || "").replace(/<\|[^|]*\|>/g, "").trim(),
    tokens: result.tokens || [],
    timestamps: result.timestamps || [],
    durations: result.durations || [],
    lang: result.lang || "",
    workerIndex,
    startedAt,
    endedAt,
    decodeSeconds: (endedAt - startedAt) / 1000,
    wasmMemoryBytes: runtime.HEAPU8.buffer.byteLength,
  };
}

self.onmessage = async ({ data }) => {
  if (busy) {
    self.postMessage({ id: data.id, error: "Worker received overlapping requests" });
    return;
  }
  busy = true;
  try {
    const result =
      data.type === "load"
        ? await load(data)
        : data.type === "vad"
          ? segmentAudio(data)
          : decode(data);
    self.postMessage(
      { id: data.id, result },
      data.type === "vad" ? result.parts.map((part) => part.samples) : [],
    );
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error.message || error), logs });
  } finally {
    busy = false;
  }
};
