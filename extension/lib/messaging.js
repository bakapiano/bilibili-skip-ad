import { DEFAULT_SETTINGS, MODEL, PROMPT_VERSION, BUILD_VERSION } from "./constants.js";
import { assert, identity, fromUrl } from "./core.js";

export function publicSettings(settings) {
  return { ...Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, settings[key]])),
    hasKey: Boolean(settings.apiKey), hasSharedToken: Boolean(settings.sharedToken), model: MODEL, promptVersion: PROMPT_VERSION, buildVersion: BUILD_VERSION };
}
export function trustedUI(sender, runtime) {
  const base = runtime.getURL("");
  return sender.id === runtime.id && typeof sender.url === "string" &&
    ["options.html", "popup.html"].some(path => sender.url.split(/[?#]/)[0] === base + path);
}
export function verifyPageSource(sender, runtimeId) {
  assert(sender.id === runtimeId && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && fromUrl(sender.url), "SENDER", "页面请求来源异常。");
}
export function verifyPage(sender, input, runtimeId, currentUrl = sender.url) {
  verifyPageSource(sender, runtimeId);
  const actual = fromUrl(currentUrl), requested = identity(input);
  assert(actual && actual.bvid === requested.bvid && actual.page === requested.page, "SENDER", "视频页面已经切换，请等待新页面就绪。");
  return requested;
}
