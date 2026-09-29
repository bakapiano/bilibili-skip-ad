import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { HttpError } from "./validation.js";

export function normalizeIp(value) {
  if (typeof value !== "string" || value.includes("%") || !isIP(value)) {
    throw new HttpError(400, "INVALID_IP", "来源 IP 格式异常。");
  }
  if (isIP(value) === 4) {
    return value;
  }
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const [left, right] = address.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words = address.includes("::")
    ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
    : head;
  const numbers = words.map((word) => Number.parseInt(word, 16));
  if (numbers.slice(0, 5).every((number) => number === 0) && numbers[5] === 65535) {
    return [numbers[6] >> 8, numbers[6] & 255, numbers[7] >> 8, numbers[7] & 255].join(".");
  }
  return numbers.map((number) => number.toString(16)).join(":");
}

export function clientIp(request, trustedProxies = []) {
  const peer = normalizeIp(request.socket.remoteAddress);
  const header = request.headers["x-real-ip"];
  const ip = trustedProxies.includes(peer) && header !== undefined ? normalizeIp(header) : peer;
  // Treat an IPv6 /64 as one client network so temporary addresses share the limit.
  return ip.includes(":") ? `${ip.split(":").slice(0, 4).join(":")}::/64` : ip;
}

export function readConfig(env = process.env) {
  const port = env.BILISKIP_PORT || "8787";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("BILISKIP_PORT should be between 1 and 65535.");
  }
  const token = env.BILISKIP_SHARED_TOKEN || "";
  if (token && (token.length < 16 || token.length > 200 || /\s/.test(token))) {
    throw new Error("BILISKIP_SHARED_TOKEN should contain 16-200 non-whitespace characters.");
  }
  return {
    host: env.BILISKIP_HOST || "127.0.0.1",
    port: Number(port),
    dbPath:
      env.BILISKIP_DB_PATH ||
      fileURLToPath(new URL("../data/shared-cache.sqlite", import.meta.url)),
    token,
    trustedProxies: (env.BILISKIP_TRUSTED_PROXIES || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(normalizeIp),
  };
}
