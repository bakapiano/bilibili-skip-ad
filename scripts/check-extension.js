import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { BUILD_VERSION } from "../extension/lib/constants.js";

const root = fileURLToPath(new URL("../extension/", import.meta.url));
async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await walk(file)));
    } else {
      result.push(file);
    }
  }
  return result;
}
const files = await walk(root);
assert.equal(
  await readFile(path.join(root, "LICENSE"), "utf8"),
  await readFile(path.join(root, "../LICENSE"), "utf8"),
  "Extension license must match the repository license.",
);
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, "module");
assert.equal(manifest.version, BUILD_VERSION);
assert.deepEqual(manifest.permissions, ["storage"]);
assert.equal(manifest.externally_connectable, undefined);
assert.equal(manifest.web_accessible_resources, undefined);
assert.equal(
  manifest.content_security_policy.extension_pages,
  "script-src 'self'; object-src 'none'; base-uri 'none'",
);
const allowedHosts = [
  "https://www.bilibili.com/*",
  "https://api.bilibili.com/*",
  "https://*.hdslb.com/*",
  "https://api.deepseek.com/*",
  "https://biliskipad.bakapiano.com/*",
];
assert.deepEqual(manifest.host_permissions, allowedHosts);
const iconSizes = [16, 32, 48, 128];
assert.deepEqual(Object.keys(manifest.icons).map(Number), iconSizes);
for (const size of iconSizes) {
  const resource = manifest.icons[size];
  assert.equal(resource, `icons/icon-${size}.png`);
  const png = await readFile(path.join(root, resource));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.toString("ascii", 12, 16), "IHDR", resource);
  assert.equal(png.readUInt32BE(16), size, resource);
  assert.equal(png.readUInt32BE(20), size, resource);
  assert.equal(png[24], 8, `${resource}: expected 8-bit PNG`);
  assert.equal(png[25], 6, `${resource}: expected RGBA PNG`);
}
assert.deepEqual(manifest.action.default_icon, {
  16: manifest.icons[16],
  32: manifest.icons[32],
  48: manifest.icons[48],
});
const resources = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...manifest.content_scripts.flatMap((script) => script.js),
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
for (const resource of resources) {
  assert.ok((await stat(path.join(root, resource))).isFile(), `Missing resource: ${resource}`);
}
let jsCount = 0;
for (const file of files) {
  const relative = path.relative(root, file);
  if (file.endsWith(".png")) {
    assert.ok(Object.values(manifest.icons).includes(relative.split(path.sep).join("/")), relative);
    continue;
  }
  const text = await readFile(file, "utf8");
  // Print file names only when failing a credential scan.
  assert.ok(!/\bsk-[a-zA-Z0-9]{24,}\b/.test(text), `Credential-like literal in ${relative}`);
  assert.ok(!/SESSDATA\s*[:=]|bili_jct\s*[:=]/i.test(text), `Session literal in ${relative}`);
  assert.ok(
    !/workers\.dev|pages\.dev|cloudflare/i.test(text),
    `Unexpected shared service in ${relative}`,
  );
  if (file.endsWith(".js")) {
    jsCount++;
    const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `${relative}: ${syntax.stderr}`);
    assert.ok(!/\beval\s*\(|new\s+Function\s*\(/.test(text), `Dynamic code in ${relative}`);
    for (const match of text.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      assert.ok(match[1].startsWith("."), `External module in ${relative}`);
      assert.ok(
        (await stat(path.resolve(path.dirname(file), match[1]))).isFile(),
        `Missing import in ${relative}`,
      );
    }
  }
  if (file.endsWith(".html")) {
    assert.ok(!/\son\w+\s*=/i.test(text), `Inline handler in ${relative}`);
    for (const match of text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      if (/^(?:https?:|#)/.test(match[1])) {
        continue;
      }
      assert.ok(
        (await stat(path.resolve(path.dirname(file), match[1]))).isFile(),
        `Missing HTML asset in ${relative}`,
      );
    }
    for (const script of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(script[1], /\bsrc=["'][^"']+["']/);
      assert.equal(script[2].trim(), "");
      assert.ok(!/\bsrc=["']https?:/i.test(script[1]), `Remote script in ${relative}`);
    }
  }
}
console.log(
  `Extension check passed: ${files.length} files, ${jsCount} JavaScript syntax checks, manifest/icons/resources/imports/CSP/secret scan.`,
);
