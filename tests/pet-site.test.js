import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { SITE_FILES } from "../scripts/build-site.js";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url));
const screenshots = ["pet-bubble.jpg", "pet-player.jpg", "pet-settings.jpg"];

test("README and homepage explain pet availability and use the same actual UI screenshots", async () => {
  const readme = (await read("README.md")).toString();
  const html = (await read("server/site/index.html")).toString();
  const dom = new JSDOM(html);
  const pet = dom.window.document.getElementById("pet");
  assert.ok(pet);
  assert.equal(pet.getAttribute("aria-labelledby"), "pet-title");
  assert.ok(dom.window.document.querySelector('#home-navigation a[href="#pet"]'));
  assert.ok(dom.window.document.querySelector('.intro a[href="#pet"]'));
  for (const text of [readme, pet.textContent]) {
    assert.match(text, /0\.2/);
    assert.match(text, /10%/);
    assert.match(text, /镜像/);
    assert.match(text, /上传/);
    assert.match(text, /DSH/);
  }
  assert.match(pet.textContent, /首次安装默认关闭/);
  assert.match(pet.textContent, /设置 → 宠物 → 开启显示/);
  assert.match(readme, /## 宠物：吃白饭，也干活/);
  assert.equal(pet.querySelectorAll("img").length, screenshots.length);
  for (const name of screenshots) {
    const image = pet.querySelector(`img[src="/assets/${name}?v={{ASSET_VERSION}}"]`);
    assert.ok(image, name);
    assert.ok(image.alt.length > 12);
    assert.equal(image.getAttribute("loading"), "lazy");
    assert.equal(image.getAttribute("decoding"), "async");
    assert.ok(image.closest("figure").querySelector("figcaption"));
    assert.ok(readme.includes(`server/site/assets/${name}`));
    const bytes = await read(`server/site/assets/${name}`);
    assert.equal(bytes.toString("hex", 0, 2), "ffd8");
    assert.equal(bytes.toString("hex", bytes.length - 2), "ffd9");
    assert.ok(bytes.length < 200 * 1024);
  }
  assert.ok(
    pet.querySelector('a[href="https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget"]'),
  );
  dom.window.close();
});

test("pet screenshots are explicit same-origin build and deployment assets", async () => {
  for (const name of screenshots) {
    assert.ok(SITE_FILES.includes(`assets/${name}`));
    for (const installer of ["server/deploy/site.sh", "server/deploy/install.sh"]) {
      assert.ok((await read(installer)).toString().includes(`site/assets/${name}`));
    }
  }
  const css = (await read("server/site/site.css")).toString();
  assert.match(css, /\.pet-layout/);
  assert.match(css, /@media \(max-width: 700px\)/);
});
