import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { petAssetsSource } from "./build-pet-assets.js";
import { bundleUserscript } from "./build-userscript.js";

// Explicit local-preview command: the selected image stays in ignored dist/ outputs.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.argv[2] || path.join(root, "assets/pet/character.png");
const image = await readFile(path.resolve(source));
const soundDirectory = process.argv[3];
const sounds = soundDirectory
  ? await Promise.all(
      ["Ya1.mp3", "Ya2.mp3"].map((name) => readFile(path.resolve(soundDirectory, name))),
    )
  : await Promise.all(
      ["press.mp3", "release.mp3"].map((name) => readFile(path.join(root, "assets/pet", name))),
    );
const petPreviewSource = await petAssetsSource({ image, enabled: true, sounds });
const output = path.join(root, "dist/biliskip-pet-preview");
await mkdir(output, { recursive: true });
await cp(path.join(root, "extension"), path.join(output, "extension"), { recursive: true });
await writeFile(path.join(output, "extension/pet-assets.js"), petPreviewSource);
const manifest = JSON.parse(await readFile(path.join(output, "extension/manifest.json")));
manifest.name = "BiliSkip · 小宠物本地预览";
await writeFile(
  path.join(output, "extension/manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
const bundle = await bundleUserscript({ petPreviewSource });
await writeFile(
  path.join(output, "biliskip-pet-preview.user.js"),
  bundle.code.replace(
    "// @name         BiliSkip · AI 广告跳过",
    "// @name         BiliSkip · 小宠物本地预览",
  ),
);
await cp(path.join(root, "store/pet-preview"), output, { recursive: true });
for (const file of ["pet.js", "pet-state.js"]) {
  await cp(path.join(root, "extension", file), path.join(output, file));
}
await writeFile(path.join(output, "pet-assets.js"), petPreviewSource);
await cp(path.join(root, "docs/pet-preview.md"), path.join(output, "README.md"));
const info = {
  localPreview: true,
  buildVersion: manifest.version,
  image: { bytes: image.length, sha256: createHash("sha256").update(image).digest("hex") },
  sounds:
    sounds?.map((bytes) => ({
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })) || [],
  fees: "One token-based estimate selected at usage receipt using Beijing peak/off-peak rules; cache reuse costs zero model calls.",
};
await writeFile(path.join(output, "preview-build.json"), JSON.stringify(info, null, 2) + "\n");
console.log(JSON.stringify({ output, ...info }, null, 2));
