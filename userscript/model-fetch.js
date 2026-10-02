import { ASR_MODEL, ASR_MODEL_SOURCES, allowedModelDownload } from "../extension/lib/asr-config.js";
import { AppError, assert } from "../extension/lib/core.js";

export function createModelFetch(gm) {
  return (url, options = {}) => {
    const source = ASR_MODEL_SOURCES.find((item) => item.url === url);
    assert(source, "HOST", "模型地址应匹配内置下载源快照。");
    return new Promise((resolve, reject) => {
      let request;
      let finished = false;
      const finish = (error, response) => {
        if (finished) {
          return;
        }
        finished = true;
        options.signal?.removeEventListener("abort", abort);
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      };
      const abort = () => {
        finish(new AppError("ASR_CANCELLED", "模型下载已停止。"));
        request?.abort();
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        request = gm.xmlHttpRequest({
          url,
          method: "GET",
          anonymous: true,
          responseType: "arraybuffer",
          redirect: source.id === "biliskip" ? "error" : "follow",
          onprogress: (event) => {
            if (finished) {
              return;
            }
            if (event.loaded > ASR_MODEL.bytes) {
              finish(new AppError("TOO_LARGE", "模型文件超过预期体积。"));
              request?.abort();
              return;
            }
            options.onDownloadProgress?.(event.loaded);
          },
        });
        request.then(
          (response) => {
            if (finished) {
              return;
            }
            try {
              assert(
                allowedModelDownload(response.finalUrl || url, source),
                "HOST",
                "模型下载跳转域名异常。",
              );
              assert(
                response.response.byteLength <= ASR_MODEL.bytes,
                "TOO_LARGE",
                "模型文件超过预期体积。",
              );
              finish(null, new Response(response.response, { status: response.status }));
            } catch (error) {
              finish(error);
            }
          },
          () => finish(new AppError("ASR_MODEL", "模型下载失败，请检查网络后重试。")),
        );
      } catch {
        finish(new AppError("ASR_MODEL", "模型请求启动失败，请检查油猴网络权限。"));
      }
    });
  };
}
