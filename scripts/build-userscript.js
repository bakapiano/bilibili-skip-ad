import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { BUILD_VERSION } from "../extension/lib/constants.js";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function bundleUserscript() {
  const header = [
    "// ==UserScript==",
    "// @name         BiliSkip · AI 广告跳过",
    "// @namespace    https://github.com/bakapiano/bilibili-skip-ad",
    `// @version      ${BUILD_VERSION}.1`,
    "// @description  读取 B站字幕和共享缓存，标记并跳过植入广告。使用个人 DeepSeek Key。",
    "// @author       bakapiano",
    "// @homepageURL  https://biliskipad.bakapiano.com/",
    "// @supportURL   https://github.com/bakapiano/bilibili-skip-ad/issues",
    "// @match        https://www.bilibili.com/video/*",
    "// @run-at       document-idle",
    "// @sandbox      DOM",
    "// @noframes",
    ...[
      "GM.info",
      "GM.xmlHttpRequest",
      "GM.getValue",
      "GM.setValue",
      "GM.deleteValue",
      "GM.listValues",
      "GM.registerMenuCommand",
      "GM.unregisterMenuCommand",
      "GM.addValueChangeListener",
      "GM.removeValueChangeListener",
    ].map((grant) => `// @grant        ${grant}`),
    ...["api.bilibili.com", "hdslb.com", "api.deepseek.com", "biliskipad.bakapiano.com"].map(
      (host) => `// @connect      ${host}`,
    ),
    "// ==/UserScript==",
  ].join("\n");
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["userscript/main.js"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    minify: false,
    charset: "utf8",
    legalComments: "inline",
    loader: { ".html": "text", ".css": "text" },
    banner: { js: header },
    metafile: true,
    logLevel: "silent",
  });
  return { code: result.outputFiles[0].text, inputs: Object.keys(result.metafile.inputs) };
}

async function main() {
  const { code, inputs } = await bundleUserscript();
  const directory = path.join(root, "dist");
  await mkdir(directory, { recursive: true });
  const filename = "biliskip.user.js";
  await writeFile(path.join(directory, filename), code, "utf8");
  const hash = createHash("sha256").update(code).digest("hex");
  await writeFile(path.join(directory, `${filename}.sha256`), `${hash}  ${filename}\n`, "utf8");
  console.log(
    `Built dist/${filename}: ${Buffer.byteLength(code)} bytes; ${inputs.filter((file) => file.startsWith("extension/")).length} shared extension files.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
