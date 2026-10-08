import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

// All released icons derive from the reviewed SVG, including its third-party notices.
const source = await readFile(
  new URL("../store/icons/biliskip-tv-coin.svg", import.meta.url),
  "utf8",
);
for (const size of [16, 32, 48, 128]) {
  const renderer = new Resvg(source, { fitTo: { mode: "width", value: size } });
  const target = new URL(`../extension/icons/icon-${size}.png`, import.meta.url);
  await writeFile(target, renderer.render().asPng());
  console.log(`Generated ${fileURLToPath(target)}`);
}
for (const filename of ["../extension/icons/icon.svg", "../server/site/assets/site-icon.svg"]) {
  await writeFile(new URL(filename, import.meta.url), source, "utf8");
}
