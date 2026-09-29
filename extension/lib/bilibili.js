import { MAX_BYTES } from "./constants.js";
import { AppError, assert, identity, normalize } from "./core.js";

const API = "https://api.bilibili.com";
const FORMATS = [
  ['nP](wOFRvU.+<fjS{jn-!$D|Dz&",zT`', "=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`"],
  ['Bn"q~|albg@]Go~ACgyDvKnd+)_D}^&J?', "Cu~L!xs~f^&r@'vh=q]q{eeng*sEg^kp#J"],
];
export function subtitleUrl(value) {
  const url = new URL(value.startsWith("//") ? `https:${value}` : value);
  assert(url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash,
    "SUBTITLE", "字幕地址应为标准 HTTPS URL。");
  if (url.hostname === "subtitle.bilibili.com") {
    const encoded = decodeURIComponent(url.pathname.slice(1));
    for (const [prefix, seed] of FORMATS) {
      const key = seed + "bilibili";
      const decoded = Array.from(encoded, (char, index) => String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(index % key.length))).join("");
      if (decoded.startsWith(prefix)) {
        const path = decoded.slice(prefix.length);
        assert(/^\/bfs\/[A-Za-z0-9_./-]+$/.test(path), "SUBTITLE", "字幕地址编码异常。");
        return `https://aisubtitle.hdslb.com${path}${url.search}`;
      }
    }
    throw new AppError("SUBTITLE", "B站字幕地址格式发生变化，需要更新适配器。");
  }
  assert(url.hostname.endsWith(".hdslb.com"),
    "SUBTITLE", "字幕地址应来自 B站 HTTPS 字幕域名。");
  return url.href;
}
export function protobufFields(bytes) {
  let position = 0;
  function integer() {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      assert(position < bytes.length, "SUBTITLE", "字幕元数据被截断。");
      const byte = bytes[position++];
      assert(index < 9 || byte <= 1, "SUBTITLE", "字幕元数据整数溢出。");
      value |= BigInt(byte & 127) << BigInt(index * 7);
      if (byte < 128) return value;
    }
    throw new AppError("SUBTITLE", "字幕元数据格式异常。");
  }
  const result = [];
  while (position < bytes.length) {
    const tag = Number(integer());
    assert(Number.isSafeInteger(tag) && tag <= 0xffffffff, "SUBTITLE", "字幕字段标记越界。");
    const number = Math.floor(tag / 8), wire = tag & 7;
    assert(number > 0, "SUBTITLE", "字幕字段编号异常。");
    if (wire === 0) result.push([number, wire, integer()]);
    else {
      assert([1, 2, 5].includes(wire), "SUBTITLE", "字幕字段类型异常。");
      const length = wire === 2 ? Number(integer()) : wire === 1 ? 8 : 4;
      assert(Number.isSafeInteger(length) && length >= 0 && position + length <= bytes.length, "SUBTITLE", "字幕元数据长度异常。");
      result.push([number, wire, bytes.slice(position, position + length)]);
      position += length;
    }
  }
  return result;
}
export function parseTracks(bytes) {
  const decode = value => new TextDecoder("utf-8", { fatal: true }).decode(value);
  const tracks = [];
  for (const [field, wire, envelope] of protobufFields(bytes)) {
    if (field !== 1 || wire !== 2) continue;
    for (const [number, kind, payload] of protobufFields(envelope)) {
      if (number !== 3 || kind !== 2) continue;
      const values = new Map(protobufFields(payload).filter(([, type]) => type === 2).map(([key, , value]) => [key, value]));
      if (values.has(5)) tracks.push({ lan: decode(values.get(3) || new Uint8Array()), subtitle_url: decode(values.get(5)) });
    }
  }
  return tracks;
}
export async function boundedBody(response, limit = MAX_BYTES) {
  assert(response.ok, "HTTP", `资源请求返回 HTTP ${response.status}。`);
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert(bytes.length <= limit, "TOO_LARGE", "响应超出大小限制。");
    return bytes;
  }
  const chunks = []; let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw new AppError("TOO_LARGE", "响应超出大小限制。"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export class BilibiliClient {
  constructor(fetcher = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    // Chrome's native fetch requires Window/WorkerGlobalScope as its receiver.
    // Calling an unbound native function as this.fetcher() brands `this` as the client.
    this.fetcher = fetcher.bind(globalThis);
    this.pause = pause;
  }
  async request(url, json = true, credentials = "include") {
    const target = new URL(url);
    assert(target.protocol === "https:" && !target.username && !target.password && !target.port &&
      (target.hostname === "api.bilibili.com" || target.hostname.endsWith(".hdslb.com")), "HOST", "B站请求域名异常。");
    const resource = target.hostname === "api.bilibili.com" ? ({
      "/x/web-interface/view": "视频元数据接口",
      "/x/player/wbi/v2": "播放器字幕接口",
      "/x/v2/subtitle/web/view": "Protobuf 字幕接口",
    }[target.pathname] || "B站接口") : "B站字幕 CDN";
    try {
      const response = await this.fetcher(url, { credentials: target.hostname === "api.bilibili.com" ? credentials : "omit",
        redirect: "error", signal: AbortSignal.timeout(15000) });
      const bytes = await boundedBody(response);
      return json ? JSON.parse(new TextDecoder().decode(bytes)) : bytes;
    } catch (error) {
      if (error instanceof AppError) throw new AppError(error.code, `${resource}：${error.message}`);
      if (error?.name === "SyntaxError") throw new AppError("BILI_JSON", `${resource}返回了非 JSON 内容，请稍后重试。`);
      if (["TimeoutError", "AbortError"].includes(error?.name)) throw new AppError("BILI_TIMEOUT", `${resource}超过 15 秒等待上限，请检查网络后重试。`);
      const kind = error?.name === "TypeError" ? "TypeError" : "NetworkError";
      // Keep signed CDN URLs, cookies and raw exception messages out of UI/logs.
      throw new AppError("BILI_NETWORK", `${resource}连接失败（${kind}）。请检查扩展的站点访问权限与浏览器网络后重试。`);
    }
  }
  async api(path, params) {
    const result = await this.request(`${API}${path}?${new URLSearchParams(params)}`);
    assert(result.code === 0 && result.data, "BILI_API", `B站接口返回 ${result.code}，请稍后重试。`);
    return result.data;
  }
  async load(input, progress = () => {}) {
    const id = identity(input);
    progress("video", "正在核对视频身份…");
    const meta = await this.api("/x/web-interface/view", { bvid: id.bvid });
    assert(meta.bvid === id.bvid && Number.isSafeInteger(meta.aid) && meta.aid > 0, "VIDEO", "视频元数据身份异常。");
    const part = meta.pages?.[id.page - 1];
    assert(part, "VIDEO", "该视频分 P 已变化，请刷新页面。");
    const video = { ...id, cid: part.cid, title: meta.title, part: part.part, duration: part.duration };
    progress("subtitle", "正在读取带时间戳字幕…");
    let tracks = [];
    try { tracks = (await this.api("/x/player/wbi/v2", { bvid: id.bvid, cid: part.cid })).subtitle?.subtitles || []; }
    catch { /* The independent Protobuf endpoint is the next read path. */ }
    if (!tracks.some(track => /zh/i.test(track.lan))) {
      const params = new URLSearchParams({ oid: part.cid, pid: meta.aid, type: 1, context_ext: '{"video_type":1}',
        cur_production_type: 0, preferred_language: "ai-zh" });
      // The public endpoint sometimes answers 200 with an empty protobuf envelope.
      // Retry that read once; model requests keep their separate one-attempt policy.
      for (let attempt = 0; attempt < 2; attempt++) {
        const bytes = await this.request(`${API}/x/v2/subtitle/web/view?${params}`, false);
        tracks = parseTracks(bytes);
        if (tracks.some(track => /zh/i.test(track.lan))) break;
        if (attempt === 0) {
          progress("subtitle", "字幕列表暂为空，正在再核对一次…");
          await this.pause(350);
        }
      }
    }
    const chinese = tracks.filter(track => /zh/i.test(track.lan)).sort((a, b) => Number(a.lan.startsWith("ai-")) - Number(b.lan.startsWith("ai-")));
    assert(chinese.length, "NO_SUBTITLE", "当前未获取到中文字幕。请检查播放器字幕与登录状态；V1 使用现成字幕。");
    const track = chinese[0];
    const raw = await this.request(subtitleUrl(track.subtitle_url));
    return normalize(video, raw.body, `bilibili:${track.lan}`);
  }
}
