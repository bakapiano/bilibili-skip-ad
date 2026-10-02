import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { clientIp } from "./config.js";
import { BADGE_METRICS, statsBadge } from "./badges.js";
import { HttpError, validateCandidate, validateQuery, validateTranscript } from "./validation.js";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_TRANSCRIPT_BYTES = 512 * 1024;

function authorized(header, token) {
  if (!token) {
    return true;
  }
  const received = Buffer.from(typeof header === "string" ? header : "");
  const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function readJson(request, timeoutMs, limit = MAX_BODY_BYTES) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
    throw new HttpError(415, "CONTENT_TYPE", "提交内容应使用 application/json。");
  }
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
    throw new HttpError(415, "CONTENT_ENCODING", "请直接提交 JSON 文本。");
  }
  if (Number(request.headers["content-length"]) > limit) {
    throw new HttpError(413, "TOO_LARGE", `提交上限为 ${limit / 1024} KiB。`);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (error, result) => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish(new HttpError(413, "TOO_LARGE", `提交上限为 ${limit / 1024} KiB。`));
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = () => {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        finish(null, JSON.parse(text));
      } catch {
        finish(new HttpError(400, "INVALID_JSON", "JSON 格式异常。"));
      }
    };
    const onAborted = () => finish(new HttpError(400, "ABORTED", "提交已中断。"));
    const timer = setTimeout(
      () => finish(new HttpError(408, "BODY_TIMEOUT", "提交内容读取超时。")),
      timeoutMs,
    );
    timer.unref();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
  });
}

export function createCacheServer({
  store,
  token = "",
  trustedProxies = [],
  now = Date.now,
  onError = () => {},
  bodyTimeoutMs = 10000,
}) {
  const server = createServer(
    { maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 15000 },
    (request, response) => {
      request.on("error", () => {});
      response.on("error", () => {});
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Idempotency-Key",
      );
      response.setHeader("Access-Control-Expose-Headers", "Retry-After");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      const send = (status, data) => {
        if (response.destroyed) {
          return;
        }
        response.statusCode = status;
        if (status === 204) {
          response.end();
        } else {
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify(data));
        }
      };
      const handle = async () => {
        const url = new URL(request.url, "http://localhost");
        const badgeMetric = BADGE_METRICS.find((metric) => url.pathname === `/v1/badges/${metric}`);
        if (request.method === "GET" && url.pathname === "/healthz") {
          send(200, { ok: true, schema_version: 1 });
          return;
        }
        if (
          !["/v1/candidates", "/v1/segments", "/v1/stats", "/v1/transcripts"].includes(
            url.pathname,
          ) &&
          !badgeMetric
        ) {
          throw new HttpError(404, "NOT_FOUND", "接口不存在。");
        }
        if (request.method === "OPTIONS") {
          response.setHeader("Access-Control-Max-Age", "600");
          send(204);
          return;
        }
        if (request.method === "GET" && badgeMetric) {
          if (url.search) {
            throw new HttpError(400, "INVALID_INPUT", "徽章接口使用固定统计路径。");
          }
          response.setHeader("Cache-Control", "public, max-age=300");
          send(200, statsBadge(badgeMetric, store.publicStats(now())));
          return;
        }
        if (request.method === "GET" && url.pathname === "/v1/stats") {
          if (url.search) {
            throw new HttpError(400, "INVALID_INPUT", "统计地址应为 /v1/stats。");
          }
          const result = store.publicStats(now());
          response.setHeader("Cache-Control", "public, max-age=60");
          send(200, result);
          return;
        }
        if (
          request.method === "POST" &&
          ["/v1/candidates", "/v1/transcripts"].includes(url.pathname)
        ) {
          response.setHeader("Connection", "close");
          const time = now();
          const ip = clientIp(request, trustedProxies);
          const limit = store.consume(ip, time);
          if (!limit.allowed) {
            response.setHeader("Retry-After", String(limit.retryAfter));
            throw new HttpError(429, "RATE_LIMITED", "每个 IP 每 1 秒最多提交 1 次，请稍后重试。");
          }
          if (!authorized(request.headers.authorization, token)) {
            throw new HttpError(401, "UNAUTHORIZED", "共享服务令牌验证失败。");
          }
          if (url.search) {
            throw new HttpError(400, "INVALID_INPUT", `提交地址应为 ${url.pathname}。`);
          }
          const transcript = url.pathname === "/v1/transcripts";
          const payload = await readJson(
            request,
            bodyTimeoutMs,
            transcript ? MAX_TRANSCRIPT_BYTES : MAX_BODY_BYTES,
          );
          const key = request.headers["idempotency-key"];
          const cacheKey = transcript
            ? validateTranscript(payload, key)
            : validateCandidate(payload, key);
          const saved = transcript
            ? store.saveTranscript(cacheKey, key, payload, ip, time)
            : store.save(cacheKey, key, payload, ip, time);
          send(saved.created ? 201 : 200, saved.receipt);
          return;
        }
        if (request.method === "GET" && url.pathname === "/v1/segments") {
          if (!authorized(request.headers.authorization, token)) {
            throw new HttpError(401, "UNAUTHORIZED", "共享服务令牌验证失败。");
          }
          const result = store.lookup(validateQuery(url.searchParams));
          if (!result) {
            throw new HttpError(404, "CACHE_MISS", "共享缓存尚无此标记。");
          }
          send(200, result);
          return;
        }
        throw new HttpError(405, "METHOD", "请使用接口规定的请求方法。");
      };
      handle().catch((error) => {
        response.setHeader("Connection", "close");
        request.resume();
        if (!(error instanceof HttpError)) {
          onError(error.code || "INTERNAL");
        }
        send(error instanceof HttpError ? error.status : 500, {
          schema_version: 1,
          error: {
            code: error instanceof HttpError ? error.code : "INTERNAL",
            message: error instanceof HttpError ? error.message : "服务暂时不可用。",
          },
        });
      });
    },
  );
  server.maxConnections = 256;
  server.setTimeout(20000, (socket) => socket.destroy());
  return server;
}
