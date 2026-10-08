import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { playerAssetsSource } from "../scripts/build-ui-assets.js";
import { Resvg } from "@resvg/resvg-js";
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { BUILD_VERSION } from "../extension/lib/constants.js";

test("checked-in player assets exactly match shared popup, styles and reviewed icons", async () => {
  const actual = await readFile(new URL("../extension/player-assets.js", import.meta.url), "utf8");
  assert.equal(actual, await playerAssetsSource());
});

test("manifest, package metadata and settings UI share the release version", async () => {
  const json = async (file) =>
    JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  const manifest = await json("extension/manifest.json");
  const pkg = await json("package.json");
  const lock = await json("package-lock.json");
  assert.equal(manifest.version, BUILD_VERSION);
  assert.equal(pkg.version, BUILD_VERSION);
  assert.equal(lock.version, BUILD_VERSION);
  assert.equal(lock.packages[""].version, BUILD_VERSION);
  const html = await readFile(new URL("../extension/options.html", import.meta.url), "utf8");
  assert.ok(html.includes(`v${BUILD_VERSION} · Chrome 扩展`));
});

test("extension and website icons reproduce the approved SVG with source license notices", async () => {
  const svg = await readFile(
    new URL("../store/icons/biliskip-tv-coin.svg", import.meta.url),
    "utf8",
  );
  for (const size of [16, 32, 48, 128]) {
    assert.deepEqual(
      await readFile(new URL(`../extension/icons/icon-${size}.png`, import.meta.url)),
      new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng(),
    );
  }
  for (const file of ["extension/icons/icon.svg", "server/site/assets/site-icon.svg"]) {
    assert.equal(await readFile(new URL(`../${file}`, import.meta.url), "utf8"), svg);
  }
  assert.match(svg, /ISC License/);
  assert.match(svg, /Cole Bemis/);
  assert.doesNotMatch(svg, /<script|<foreignObject/);
  const options = await readFile(new URL("../extension/options.html", import.meta.url), "utf8");
  assert.equal(
    (options.match(/type="checkbox"/g) || []).length,
    (options.match(/role="switch"/g) || []).length,
  );
  assert.doesNotMatch(options, /默认关闭|默认开启|id="save"/);
  assert.match(options, /github.com\/bakapiano\/bilibili-skip-ad/);
});

test("project links use distinct home and GitHub icons in desktop/mobile settings and shared assets", async () => {
  const dom = new JSDOM(
    await readFile(new URL("../extension/options.html", import.meta.url), "utf8"),
  );
  for (const selector of [".sidebar-links", ".mobile-project-links"]) {
    const links = dom.window.document.querySelector(selector).querySelectorAll("a");
    assert.equal(links.length, 2);
    for (const [index, name] of ["home", "github"].entries()) {
      const icon = links[index].querySelector("img");
      assert.equal(icon.getAttribute("src"), `icons/link-${name}.svg`);
      assert.equal(icon.getAttribute("alt"), "");
      assert.equal(links[index].target, "_blank");
      assert.match(links[index].rel, /noopener/);
      assert.doesNotMatch(links[index].textContent, /↗/);
    }
  }
  const sandbox = {};
  vm.runInNewContext(await playerAssetsSource(), sandbox);
  for (const [key, filename] of [
    ["homeIcon", "link-home.svg"],
    ["githubIcon", "link-github.svg"],
  ]) {
    assert.equal(
      sandbox.BiliSkipPlayerAssets[key],
      await readFile(new URL(`../extension/icons/${filename}`, import.meta.url), "utf8"),
    );
  }
  assert.notEqual(sandbox.BiliSkipPlayerAssets.homeIcon, sandbox.BiliSkipPlayerAssets.githubIcon);
  assert.match(sandbox.BiliSkipPlayerAssets.githubIcon, /Copyright \(c\) 2026 GitHub Inc/);
  dom.window.close();
});
