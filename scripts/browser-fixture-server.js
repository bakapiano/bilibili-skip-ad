// Local-only browser fixture: explicit source allowlist, no credentials or proxying.
import http from "node:http";
import { readFile } from "node:fs/promises";
const allowed = new Map([
  ["/fetch-binding", "tests/browser/fetch-binding.html"],
  ...["fetch-binding.js", "fetch-binding-checks.js", "fetch-binding-worker.js"].map(name => [`/${name}`, `tests/browser/${name}`]),
  ...["bilibili.js", "core.js", "constants.js", "providers.js"].map(name => [`/extension/lib/${name}`, `extension/lib/${name}`]),
  ["/player-fixture", "tests/browser/player-fixture.html"],
  ["/player-fixture.js", "tests/browser/player-fixture.js"],
  ...["player-core.js", "timeline.js", "content.js"].map(name => [`/extension/${name}`, `extension/${name}`]),
]);
// A 100-second silent unsigned-8-bit PCM WAV provides a genuine seekable media element.
const wav = Buffer.alloc(44 + 800000, 128);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVE", 8);
wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
wav.write("data", 36); wav.writeUInt32LE(800000, 40);
const server = http.createServer(async (request, response) => {
  const target = new URL(request.url, "http://127.0.0.1");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
  if (target.pathname === "/fixture.wav") {
    response.setHeader("Content-Type", "audio/wav"); response.setHeader("Accept-Ranges", "bytes");
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    if (!Number.isSafeInteger(start) || start > end || start < 0) { response.writeHead(416); response.end(); return; }
    if (range) { response.statusCode = 206; response.setHeader("Content-Range", `bytes ${start}-${end}/${wav.length}`); }
    response.setHeader("Content-Length", end - start + 1); response.end(wav.subarray(start, end + 1)); return;
  }
  if (target.pathname === "/probe") { response.setHeader("Content-Type", "application/json"); response.end('{"ok":true}'); return; }
  const file = allowed.get(target.pathname);
  if (!file) { response.writeHead(404); response.end(); return; }
  try {
    const content = await readFile(new URL(`../${file}`, import.meta.url));
    response.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8");
    response.end(content);
  } catch { response.writeHead(500); response.end("Fixture read error"); }
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/fetch-binding`,
  playerUrl: `http://127.0.0.1:${server.address().port}/player-fixture`, pid: process.pid })));
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
