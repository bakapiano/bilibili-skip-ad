import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("root Markdown stays minimal and maintained documentation links resolve", async () => {
  const rootDocs = (await readdir(root)).filter((name) => name.endsWith(".md")).sort();
  assert.deepEqual(rootDocs, ["AGENTS.md", "README.md"]);
  const files = rootDocs.map((file) => path.join(root, file));
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (directory === path.join(root, "prompt") && ["data", "runs"].includes(entry.name)) {
          continue;
        }
        await collect(file);
      } else if (entry.name.endsWith(".md")) {
        files.push(file);
      }
    }
  }
  for (const directory of ["docs", "server", "store", "userscript", "prompt"]) {
    await collect(path.join(root, directory));
  }
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) {
        continue;
      }
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target.split("#")[0]));
      const relative = path.relative(root, resolved);
      assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), `${file}: ${target}`);
      assert.ok((await stat(resolved)).isFile(), `${file}: ${target}`);
    }
  }
});

test("README badges use verified channels and disclose install and ad-duration accounting", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(readme, /store\/icons\/biliskip-tv-coin\.svg/);
  assert.ok((await stat(path.join(root, "store/icons/biliskip-tv-coin.svg"))).isFile());
  assert.match(readme, /server\/site\/assets\/ad-markers\.png/);
  assert.match(readme, /img\.shields\.io\/greasyfork\/dt\/597956/);
  for (const metric of ["videos", "segments", "saved-time"]) {
    assert.ok(readme.includes(`biliskipad.bakapiano.com%2Fv1%2Fbadges%2F${metric}`));
  }
  assert.match(readme, /公开累计安装次数/);
  assert.match(readme, /每个分 P 计一次/);
  assert.doesNotMatch(readme, /chrome-web-store\/users/);
});
