import { DEFAULT_SHARED_URL, MAX_BYTES } from "../extension/lib/constants.js";
import { AppError, assert } from "../extension/lib/core.js";

export function allowedTarget(input) {
  const url = new URL(input);
  assert(
    url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash,
    "HOST",
    "请求地址应为标准 HTTPS URL。",
  );
  const bili = url.hostname === "api.bilibili.com";
  const model = url.origin === "https://api.deepseek.com";
  const shared = url.origin === DEFAULT_SHARED_URL;
  const subtitle = url.hostname.endsWith(".hdslb.com") && url.pathname.startsWith("/bfs/");
  assert(
    (bili &&
      ["/x/web-interface/view", "/x/player/wbi/v2", "/x/v2/subtitle/web/view"].includes(
        url.pathname,
      )) ||
      (model && url.pathname === "/chat/completions") ||
      (shared && ["/v1/segments", "/v1/candidates"].includes(url.pathname)) ||
      subtitle,
    "HOST",
    "请求应发往 B站字幕、DeepSeek 或内置共享缓存接口。",
  );
  return { url, bili, model, shared };
}

// GM requests run in Tampermonkey's background context. Keep cookies and bearer
// credentials on separate destinations and stop redirects before they are sent.
export function createGMFetch(gm) {
  const active = new Set();
  let disposed = false;
  const fetcher = (input, options = {}) => {
    if (disposed) {
      throw new DOMException("页面任务已结束，请刷新后重试。", "AbortError");
    }
    const { url, bili, model, shared } = allowedTarget(input);
    const method = options.method || "GET";
    assert(
      method === (model || url.pathname === "/v1/candidates" ? "POST" : "GET"),
      "METHOD",
      "请求方法与接口不匹配。",
    );
    const headers = {};
    for (const [name, value] of new Headers(options.headers).entries()) {
      assert(
        ["accept", "content-type", "idempotency-key"].includes(name) ||
          (name === "authorization" && (model || shared)),
        "HEADERS",
        "请求头超出接口授权范围。",
      );
      headers[name] = value;
    }
    return new Promise((resolve, reject) => {
      let request;
      let finished = false;
      const finish = (error, value) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        active.delete(cancel);
        options.signal?.removeEventListener("abort", abort);
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const cancel = (reason = new DOMException("请求已停止。", "AbortError")) => {
        finish(reason);
        request?.abort();
      };
      const abort = () => cancel(options.signal.reason);
      // Chrome's GM fetch mode ignores details.timeout; use our own abort timer.
      const timer = setTimeout(() => cancel(new DOMException("请求超时。", "TimeoutError")), 30000);
      if (options.signal?.aborted) {
        abort();
        return;
      }
      active.add(cancel);
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        request = gm.xmlHttpRequest({
          url: url.href,
          method,
          headers,
          data: options.body,
          responseType: "arraybuffer",
          redirect: "error",
          anonymous: !(bili && options.credentials === "include"),
        });
        request.then(
          (response) => {
            if (finished) {
              return;
            }
            try {
              assert(
                new URL(response.finalUrl || url.href).href === url.href,
                "REDIRECT",
                "接口地址发生跳转，请核对服务配置。",
              );
              assert(
                response.status >= 200 && response.status <= 599,
                "NETWORK",
                "网络响应状态异常。",
              );
              const bytes = new Uint8Array(response.response);
              assert(bytes.byteLength <= MAX_BYTES, "TOO_LARGE", "响应超出大小限制。");
              finish(
                null,
                new Response([204, 205, 304].includes(response.status) ? null : bytes, {
                  status: response.status,
                }),
              );
            } catch (error) {
              finish(error);
            }
          },
          () => finish(new AppError("NETWORK", "接口连接未完成，请检查油猴网络权限后重试。")),
        );
      } catch {
        finish(new AppError("NETWORK", "油猴网络请求启动失败，请检查脚本权限。"));
      }
    });
  };
  fetcher.dispose = () => {
    disposed = true;
    for (const cancel of [...active]) {
      cancel();
    }
  };
  return fetcher;
}
