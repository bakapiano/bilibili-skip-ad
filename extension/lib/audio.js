import { AppError, assert } from "./core.js";
import { boundedBody } from "./bilibili.js";
import { ASR_MAX_AUDIO_BYTES } from "./asr-config.js";

export function audioUrl(value) {
  const url = new URL(value);
  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      /\.(?:bilivideo\.com|bilivideo\.cn|hdslb\.com)$/.test(url.hostname),
    "AUDIO_HOST",
    "音轨应来自B站HTTPS媒体域名。",
  );
  return url.href;
}
export async function audioTrack(video, fetcher = fetch) {
  const get = fetcher.bind(globalThis);
  const response = await get(
    `https://api.bilibili.com/x/player/playurl?${new URLSearchParams({ bvid: video.bvid, cid: video.cid, fnval: 16, qn: 16, fnver: 0 })}`,
    { credentials: "include", redirect: "error", signal: AbortSignal.timeout(15000) },
  );
  const payload = JSON.parse(new TextDecoder().decode(await boundedBody(response)));
  const tracks = payload.data?.dash?.audio;
  assert(payload.code === 0 && Array.isArray(tracks), "AUDIO", "当前播放权限下未取得可用音轨。");
  const track = [...tracks]
    .filter((item) => /mp4a/.test(item.codecs || ""))
    .sort((a, b) => a.bandwidth - b.bandwidth)[0];
  assert(track, "AUDIO", "当前视频缺少浏览器可解码的AAC音轨。");
  const urls = [track.baseUrl || track.base_url, ...(track.backupUrl || track.backup_url || [])];
  for (const candidate of urls) {
    try {
      return { url: audioUrl(candidate), codec: track.codecs };
    } catch {
      // Try a standard HTTPS CDN backup.
    }
  }
  throw new AppError("AUDIO_HOST", "当前音轨缺少标准HTTPS下载地址。");
}
export async function audioBytes(track, fetcher = fetch, signal) {
  const response = await fetcher.call(globalThis, audioUrl(track.url), {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]),
  });
  return boundedBody(response, ASR_MAX_AUDIO_BYTES);
}
