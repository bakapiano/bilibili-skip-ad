import { MAX_PET_AUDIO_BYTES, MAX_PET_AUDIO_SECONDS, validatePetAudio } from "./pet-config.js";

const MIME_BY_EXTENSION = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
};
const MIME_ALIASES = {
  "audio/mp3": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
};

export async function readPetAudio(file, view, signal) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_PET_AUDIO_BYTES) {
    throw new Error("请选择 1 MiB 以内的音频文件。");
  }
  const type =
    MIME_ALIASES[file.type] ||
    file.type ||
    MIME_BY_EXTENSION[file.name?.split(".").at(-1).toLowerCase()];
  if (!Object.values(MIME_BY_EXTENSION).includes(type)) {
    throw new Error("请选择 MP3、WAV、OGG 或 M4A 音频。");
  }
  signal?.throwIfAborted();
  const buffer = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  const pieces = [];
  for (let offset = 0; offset < buffer.length; offset += 32768) {
    pieces.push(String.fromCharCode(...buffer.subarray(offset, offset + 32768)));
  }
  const data = `data:${type};base64,${view.btoa(pieces.join(""))}`;
  validatePetAudio(data);
  const url = view.URL.createObjectURL(new view.Blob([buffer], { type }));
  const audio = new view.Audio();
  try {
    const duration = await new Promise((resolve, reject) => {
      const stop = () => {
        view.clearTimeout(timer);
        audio.removeEventListener("loadedmetadata", loaded);
        audio.removeEventListener("error", failed);
        signal?.removeEventListener("abort", aborted);
      };
      const loaded = () => {
        stop();
        resolve(audio.duration);
      };
      const failed = () => {
        stop();
        reject(new Error("音频读取未完成，请检查格式后重试。"));
      };
      const aborted = () => {
        stop();
        reject(signal.reason);
      };
      audio.addEventListener("loadedmetadata", loaded);
      audio.addEventListener("error", failed);
      signal?.addEventListener("abort", aborted, { once: true });
      const timer = view.setTimeout(failed, 8000);
      audio.preload = "metadata";
      audio.src = url;
    });
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_PET_AUDIO_SECONDS) {
      throw new Error(`点击音频时长请保持在 ${MAX_PET_AUDIO_SECONDS} 秒以内。`);
    }
    signal?.throwIfAborted();
    return { petAudio: data, petAudioName: String(file.name || "自定义音频").slice(0, 100) };
  } finally {
    audio.removeAttribute("src");
    audio.load();
    view.URL.revokeObjectURL(url);
  }
}
