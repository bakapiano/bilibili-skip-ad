import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
export const SITE_FILES = [
  "index.html",
  "privacy.html",
  "site.css",
  "assets/ad-markers.png",
  "assets/auto-skip.png",
];
export async function buildSite(outputRoot, archivePath) {
  const manifest = JSON.parse(await readFile(path.join(root, "extension/manifest.json"), "utf8"));
  const version = manifest.version;
  const stylesheet = await readFile(path.join(root, "server/site/site.css"));
  const assetHash = createHash("sha256").update(stylesheet);
  for (const file of SITE_FILES.filter((name) => name.startsWith("assets/"))) {
    assetHash.update(await readFile(path.join(root, "server/site", file)));
  }
  const assetVersion = assetHash.digest("hex").slice(0, 12);
  const files = [...SITE_FILES, "assets/icon.png"];
  for (const file of files) {
    const destination = path.join(outputRoot, "site", file);
    await mkdir(path.dirname(destination), { recursive: true });
    if (file.endsWith(".html")) {
      const template = await readFile(path.join(root, "server/site", file), "utf8");
      const html = template
        .replaceAll("{{VERSION}}", version)
        .replaceAll("{{ASSET_VERSION}}", assetVersion);
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), "Unresolved site template token");
      await writeFile(destination, html, "utf8");
    } else {
      await copyFile(
        path.join(
          root,
          file === "assets/icon.png" ? "extension/icons/icon-128.png" : `server/site/${file}`,
        ),
        destination,
      );
    }
  }
  if (archivePath) {
    const archive = await readFile(archivePath);
    const name = `biliskip-${version}.zip`;
    const downloadRoot = path.join(outputRoot, "site/downloads");
    await mkdir(downloadRoot, { recursive: true });
    const hash = createHash("sha256").update(archive).digest("hex");
    for (const filename of [name, "biliskip.zip"]) {
      await copyFile(archivePath, path.join(downloadRoot, filename));
      await writeFile(
        path.join(downloadRoot, `${filename}.sha256`),
        `${hash}  ${filename}\n`,
        "utf8",
      );
      files.push(`downloads/${filename}`, `downloads/${filename}.sha256`);
    }
  }
  return { version, assetVersion, files: files.map((file) => `site/${file}`) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], "Usage: node scripts/build-site.js <verified-extension.zip>");
  const result = await buildSite(path.join(root, ".tmp/site-build"), path.resolve(process.argv[2]));
  console.log(JSON.stringify(result));
}
