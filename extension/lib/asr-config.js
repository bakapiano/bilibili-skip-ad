export const ASR_VERSION = "sensevoice-int8-1.12.20-vad-04-12-cues-v2";
export const ASR_MODEL = Object.freeze({
  url: "https://biliskipad.bakapiano.com/models/sensevoice-small-int8/c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51.onnx",
  // Read-only key for migrating a previously downloaded browser cache.
  legacyUrl:
    "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx",
  bytes: 239233841,
  sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
});
export const ASR_MAX_AUDIO_BYTES = 64 * 1024 * 1024;
export const ASR_MODEL_SOURCES = Object.freeze([
  { id: "biliskip", label: "BiliSkip 本站", url: ASR_MODEL.url, origins: [] },
  {
    id: "hf-mirror",
    label: "HF-Mirror 镜像",
    url: ASR_MODEL.legacyUrl.replace("https://huggingface.co/", "https://hf-mirror.com/"),
    origins: ["https://hf-mirror.com/*", "https://*.hf.co/*", "https://*.huggingface.co/*"],
  },
  {
    id: "huggingface",
    label: "Hugging Face 原站",
    url: ASR_MODEL.legacyUrl,
    origins: ["https://huggingface.co/*", "https://*.hf.co/*", "https://*.huggingface.co/*"],
  },
]);
export function modelSource(id) {
  return ASR_MODEL_SOURCES.find((source) => source.id === id);
}
export function allowedModelDownload(value, source) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
      return false;
    }
    if (url.href === source.url) {
      return true;
    }
    return (
      source.id !== "biliskip" &&
      (url.hostname.endsWith(".hf.co") || url.hostname.endsWith(".huggingface.co"))
    );
  } catch {
    return false;
  }
}
export const ASR_MAX_SECONDS = 3600;
export function exemptVideo(video, settings) {
  return settings.shortVideoExempt && video.duration < settings.shortVideoMinutes * 60;
}
