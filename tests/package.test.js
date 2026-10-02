import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));

test(
  "Windows PowerShell ZIP writer uses slash paths and preserves nested extension bytes",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const temporary = await mkdtemp(path.join(root, ".tmp", "zip-regression-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const archive = path.join(temporary, "extension.zip");
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        path.join(root, "scripts/write-extension-zip.ps1"),
        "-ExtensionRoot",
        path.join(root, "extension"),
        "-ArchivePath",
        archive,
      ],
      { stdio: "pipe" },
    );
    const zip = await readFile(archive);
    const eocd = zip.length - 22;
    assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
    const count = zip.readUInt16LE(eocd + 10);
    let cursor = zip.readUInt32LE(eocd + 16);
    const names = [];
    for (let index = 0; index < count; index++) {
      assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
      const nameLength = zip.readUInt16LE(cursor + 28);
      const extraLength = zip.readUInt16LE(cursor + 30);
      const commentLength = zip.readUInt16LE(cursor + 32);
      const name = zip.toString("utf8", cursor + 46, cursor + 46 + nameLength);
      assert.equal(name.includes("\\"), false, name);
      assert.equal(name.startsWith("/"), false, name);
      assert.equal(name.split("/").includes(".."), false, name);
      names.push(name);
      const method = zip.readUInt16LE(cursor + 10);
      const compressedSize = zip.readUInt32LE(cursor + 20);
      const local = zip.readUInt32LE(cursor + 42);
      assert.equal(zip.readUInt32LE(local), 0x04034b50);
      const dataOffset = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
      const data = method === 8 ? inflateRawSync(compressed) : compressed;
      assert.deepEqual(data, await readFile(path.join(root, "extension", name)), name);
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    for (const name of ["manifest.json", "LICENSE", "icons/icon-128.png", "lib/model-output.js"]) {
      assert.ok(names.includes(name), name);
    }
    assert.ok(names.includes("asr/vendor/runtime.wasm"));
    for (const name of [
      "NOTICE.md",
      "LICENSE",
      "ONNXRUNTIME-LICENSE",
      "ONNXRUNTIME-NOTICES",
      "SILERO-LICENSE",
      "FUNASR-MODEL-LICENSE",
    ]) {
      assert.ok(names.includes(`asr/vendor/${name}`), name);
    }
    assert.equal(
      names.some((name) => name.endsWith(".onnx")),
      false,
    );
  },
);
