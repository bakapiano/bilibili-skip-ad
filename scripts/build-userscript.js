import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { BUILD_VERSION } from "../extension/lib/constants.js";
import { ASR_ASSETS, asrAssetUrl } from "../userscript/asr-assets.js";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
export const USERSCRIPT_VERSION = `${BUILD_VERSION}.1`;

export async function bundleUserscript({ petPreviewSource } = {}) {
  const worker = await build({
    define: { process: "undefined", module: "undefined" },
    external: ["fs", "path"],
    absWorkingDir: root,
    entryPoints: ["extension/asr/worker.js"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    minify: false,
  });
  for (const asset of ASR_ASSETS) {
    const bytes = await readFile(path.join(root, "extension/asr/vendor", asset.file));
    assert.equal(bytes.length, asset.bytes, asset.file);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, asset.file);
  }
  const license = (await readFile(path.join(root, "LICENSE"), "utf8")).trim();
  const petNotice = await readFile(path.join(root, "assets/pet/NOTICE.md"), "utf8");
  const notices = await Promise.all(
    [
      "NOTICE.md",
      "LICENSE",
      "ONNXRUNTIME-LICENSE",
      "ONNXRUNTIME-NOTICES",
      "SILERO-LICENSE",
      "FUNASR-MODEL-LICENSE",
    ].map(
      async (name) =>
        `${name}\n${await readFile(path.join(root, "extension/asr/vendor", name), "utf8")}`,
    ),
  );
  const header = [
    "// ==UserScript==",
    "// @name         BiliSkip · AI 广告跳过",
    "// @namespace    https://github.com/bakapiano/bilibili-skip-ad",
    `// @version      ${USERSCRIPT_VERSION}`,
    "// @description  读取 B站字幕和共享缓存，标记并跳过植入广告。使用个人 DeepSeek Key。",
    "// @author       bakapiano",
    "// @license      MIT",
    "// @homepageURL  https://biliskipad.bakapiano.com/",
    "// @supportURL   https://github.com/bakapiano/bilibili-skip-ad/issues",
    "// @match        https://www.bilibili.com/video/*",
    "// @run-at       document-idle",
    "// @noframes",
    ...ASR_ASSETS.map(
      (asset) => `// @resource     ${asset.name} ${asrAssetUrl(asset)}#sha256=${asset.sha256}`,
    ),
    ...[
      "GM.info",
      "GM.getResourceUrl",
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
    ...[
      "api.bilibili.com",
      "hdslb.com",
      "bilivideo.com",
      "bilivideo.cn",
      "hf-mirror.com",
      "huggingface.co",
      "hf.co",
      "api.deepseek.com",
      "biliskipad.bakapiano.com",
    ].map((host) => `// @connect      ${host}`),
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
    banner: {
      js: `${header}\n\n/*\n${license}\n*/\n/*\n${petNotice.replaceAll("*/", "* /")}\n*/\n/*\n${notices.join("\n\n").replaceAll("*/", "* /")}\n*/`,
    },
    metafile: true,
    logLevel: "silent",
    plugins: [
      ...(petPreviewSource
        ? [
            {
              name: "local-pet-preview",
              setup(builder) {
                builder.onLoad({ filter: /[\\/]extension[\\/]pet-assets\.js$/ }, () => ({
                  contents: petPreviewSource,
                  loader: "js",
                }));
              },
            },
          ]
        : []),
      {
        name: "bundled-asr",
        setup(builder) {
          builder.onResolve({ filter: /^biliskip:asr-worker$/ }, (args) => ({
            path: args.path,
            namespace: "asr",
          }));
          builder.onLoad({ filter: /.*/, namespace: "asr" }, () => ({
            contents: `export default ${JSON.stringify(worker.outputFiles[0].text)};`,
            loader: "js",
          }));
        },
      },
    ],
  });
  const code = result.outputFiles[0].text;
  assert.ok(
    Buffer.byteLength(code) < 2 * 1024 * 1024,
    "Userscript must fit within the Greasy Fork source limit.",
  );
  return { code, inputs: Object.keys(result.metafile.inputs) };
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
