import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { buildSite, SITE_FILES } from "../scripts/build-site.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const greasyForkUrl =
  "https://greasyfork.org/zh-CN/scripts/597956-biliskip-ai-%E5%B9%BF%E5%91%8A%E8%B7%B3%E8%BF%87";
const chromeStoreUrl = "https://chromewebstore.google.com/detail/oebfplajlnbkabikbcadhhjhjdijahjk";

test("native install choices display the corresponding instructions without site JavaScript", async (t) => {
  const html = await readFile(path.join(root, "server/site/index.html"), "utf8");
  const css = await readFile(path.join(root, "server/site/site.css"), "utf8");
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const chrome = document.getElementById("install-chrome");
  const userscript = document.getElementById("install-userscript");
  const chromePanel = document.getElementById(chrome.getAttribute("aria-controls"));
  const userscriptPanel = document.getElementById(userscript.getAttribute("aria-controls"));
  assert.equal(chrome.name, userscript.name);
  assert.equal(chrome.type, "radio");
  assert.equal(userscript.type, "radio");
  assert.equal(chrome.labels.length, 1);
  assert.equal(userscript.labels.length, 1);
  for (const radio of [userscript, chrome]) {
    const icons = radio.labels[0].querySelectorAll("svg.install-option-icon");
    assert.equal(icons.length, 1);
    assert.equal(icons[0].getAttribute("aria-hidden"), "true");
    assert.equal(icons[0].getAttribute("focusable"), "false");
    assert.equal(icons[0].getAttribute("viewBox"), "0 0 32 32");
    assert.equal(icons[0].querySelectorAll("script,image,use,foreignObject").length, 0);
    assert.ok(radio.labels[0].querySelector(".install-option-copy strong").textContent);
  }
  assert.equal(document.querySelector('input[name="install-method"]'), userscript);
  assert.equal(userscript.defaultChecked, true);
  assert.equal(chrome.defaultChecked, false);
  assert.equal(chrome.closest("fieldset").querySelector("legend").textContent, "选择安装方式");
  const expectSelection = (isChrome) => {
    // jsdom caches computed styles after native :checked changes. Reattach the
    // same stylesheet to evaluate each state; live Chrome checks the transition.
    style.remove();
    document.head.append(style);
    assert.equal(chrome.checked, isChrome);
    assert.equal(userscript.checked, !isChrome);
    assert.equal(dom.window.getComputedStyle(chromePanel).display, isChrome ? "block" : "none");
    assert.equal(dom.window.getComputedStyle(userscriptPanel).display, isChrome ? "none" : "block");
  };
  expectSelection(false);
  assert.match(userscriptPanel.textContent, /安装此脚本/);
  assert.match(userscriptPanel.textContent, /BiliSkip · 打开面板/);
  assert.equal(userscriptPanel.querySelector("a.download").href, greasyForkUrl);
  assert.equal(userscriptPanel.querySelector("a.download").target, "_blank");
  chrome.labels[0].click();
  expectSelection(true);
  assert.match(chromePanel.textContent, /chrome:\/\/extensions/);
  assert.equal(chromePanel.querySelector("a.download").getAttribute("href"), chromeStoreUrl);
  assert.equal(chromePanel.querySelector("a.download").target, "_blank");
  assert.match(chromePanel.querySelector("a.download").rel, /noopener/);
  assert.match(chromePanel.querySelector(".steps li").textContent, /添加至 Chrome/);
  const offline = chromePanel.querySelector("details.offline-install");
  assert.equal(offline.open, false);
  assert.equal(
    offline.querySelector("a[download]").getAttribute("href"),
    "/downloads/biliskip.zip",
  );
  userscript.labels[0].click();
  expectSelection(false);
  assert.equal(document.querySelectorAll("script").length, 1);
  assert.equal(
    document.querySelector("script").getAttribute("src"),
    "/stats.js?v={{ASSET_VERSION}}",
  );
  assert.equal(document.querySelector("script").defer, true);
  assert.equal(document.querySelector("script").textContent, "");
});

test("public installation docs share the released Chrome store entry", async () => {
  for (const file of ["README.md", "docs/extension.md", "server/site/index.html"]) {
    const text = await readFile(path.join(root, file), "utf8");
    assert.ok(text.includes(chromeStoreUrl), file);
    assert.equal(text.includes("authuser="), false, file);
  }
});

test("README and website share the published Greasy Fork installation entry", async () => {
  for (const file of ["README.md", "userscript/README.md", "server/site/index.html"]) {
    const text = await readFile(path.join(root, file), "utf8");
    assert.ok(text.includes(greasyForkUrl), file);
    assert.equal(text.includes(`${greasyForkUrl}/post-install`), false, file);
  }
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.ok(readme.indexOf("### 油猴版") < readme.indexOf("### Chrome 扩展"));
  const privacy = (await readFile(path.join(root, "server/site/privacy.html"), "utf8")).replace(
    /\s+/g,
    " ",
  );
  assert.match(privacy, /油猴版/);
  assert.match(privacy, /GM 专属存储/);
  assert.match(privacy, /当前页面内存/);
});
test("landing page build resolves versions and ships only explicit public assets", async (t) => {
  const tmp = path.join(root, ".tmp");
  await mkdir(tmp, { recursive: true });
  const output = await mkdtemp(path.join(tmp, "site-test-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const result = await buildSite(output);
  const manifest = JSON.parse(await readFile(path.join(root, "extension/manifest.json"), "utf8"));
  assert.equal(result.version, manifest.version);
  assert.deepEqual(
    result.files,
    [...SITE_FILES, "assets/icon.png"].map((file) => `site/${file}`),
  );
  for (const name of ["index.html", "privacy.html"]) {
    const html = await readFile(path.join(output, "site", name), "utf8");
    assert.equal(html.includes("{{"), false);
    assert.ok(html.includes(manifest.version));
    assert.match(html, /name="viewport"/);
    assert.equal(/\son\w+=|<iframe\b/i.test(html), false);
    const dom = new JSDOM(html);
    const scripts = [...dom.window.document.querySelectorAll("script")];
    assert.equal(scripts.length, name === "privacy.html" ? 0 : 1);
    for (const script of scripts) {
      assert.equal(script.getAttribute("src"), `/stats.js?v=${result.assetVersion}`);
      assert.equal(script.textContent, "");
    }
    dom.window.close();
    for (const [, resource] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if (
        resource.startsWith("https:") ||
        resource.startsWith("/downloads/") ||
        resource.split(/[?#]/)[0] === "/" ||
        resource === "/healthz"
      ) {
        continue;
      }
      const target = resource.split(/[?#]/)[0].slice(1);
      assert.ok((await readFile(path.join(output, "site", target))).length > 0, resource);
    }
  }
  assert.deepEqual((await readdir(path.join(output, "site"))).sort(), [
    "assets",
    "index.html",
    "privacy.html",
    "site.css",
    "stats.js",
  ]);
});

test("site download links and privacy descriptions match extension settings", async () => {
  const home = await readFile(path.join(root, "server/site/index.html"), "utf8");
  const privacy = (await readFile(path.join(root, "server/site/privacy.html"), "utf8")).replace(
    /\s+/g,
    " ",
  );
  assert.match(home, /\/downloads\/biliskip-\{\{VERSION\}\}\.zip/);
  assert.match(home, /href="\/downloads\/biliskip\.zip" download/);
  assert.match(home, /导入时选择解压后的文件夹/);
  assert.ok(home.indexOf('id="install"') < home.indexOf('class="screenshots"'));
  assert.match(home, /chrome:\/\/extensions/);
  assert.match(home, /默认上传/);
  assert.match(home, /单独关闭自动上传/);
  assert.match(privacy, /每段最多 10 条证据，每条最多 500 字符/);
  assert.match(privacy, /7 个 UTC/);
  assert.match(privacy, /1000ms/);
  assert.match(home, /<h1>B站植入广告跳过插件<\/h1>/);
  assert.match(home, /实际效果/);
  assert.equal(/工作方式示意|把时间，|观看节奏|把注意力/.test(home), false);
});

test("site publishes identical versioned and stable download bytes with matching checksums", async (t) => {
  const tmp = path.join(root, ".tmp");
  await mkdir(tmp, { recursive: true });
  const output = await mkdtemp(path.join(tmp, "site-download-test-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  // Byte-copy fixture; deploy.ps1 separately verifies a real ZIP against extension sources.
  const bytes = Buffer.from("synthetic archive bytes for download-copy regression");
  const input = path.join(output, "input.zip");
  await writeFile(input, bytes);
  const result = await buildSite(output, input);
  const hash = createHash("sha256").update(bytes).digest("hex");
  for (const name of [`biliskip-${result.version}.zip`, "biliskip.zip"]) {
    const file = `site/downloads/${name}`;
    assert.ok(result.files.includes(file));
    assert.deepEqual(await readFile(path.join(output, file)), bytes);
    assert.equal(await readFile(path.join(output, `${file}.sha256`), "utf8"), `${hash}  ${name}\n`);
  }
});

test("site-only build preserves the selected published ZIP version and emits no downloads", async (t) => {
  const output = await mkdtemp(path.join(root, ".tmp", "site-only-test-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const result = await buildSite(output, undefined, { version: "0.1.6" });
  assert.equal(result.version, "0.1.6");
  assert.equal(
    result.files.some((file) => file.includes("downloads/")),
    false,
  );
  const home = await readFile(path.join(output, "site/index.html"), "utf8");
  assert.match(home, /biliskip-0\.1\.6\.zip\.sha256/);
  assert.equal(
    result.files.some((file) => /results\.(html|js)$/.test(file)),
    false,
  );
  const installer = await readFile(path.join(root, "server/deploy/site.sh"), "utf8");
  assert.match(installer, /cmp "\$previous\/site\/downloads\/biliskip\.zip"/);
  assert.match(installer, /trap rollback EXIT/);
});

test("Nginx serves the landing page alongside unchanged API forwarding and limits", async () => {
  const nginx = await readFile(path.join(root, "server/deploy/nginx.conf"), "utf8");
  assert.match(nginx, /root \/srv\/biliskipad\/current\/site;/);
  assert.match(nginx, /try_files \/index\.html =404/);
  assert.match(nginx, /location \/v1\//);
  assert.match(nginx, /client_max_body_size 64k/);
  assert.match(nginx, /proxy_set_header X-Real-IP \$remote_addr/);
  assert.match(nginx, /location = \/healthz/);
  assert.match(nginx, /script-src 'self'/);
  assert.match(nginx, /connect-src 'self'/);
  assert.match(nginx, /location = \/stats\.js/);
  assert.doesNotMatch(nginx, /unsafe-inline|unsafe-eval/);
  for (const name of ["biliskip.zip", "biliskip.zip.sha256"]) {
    const start = nginx.indexOf(`location = /downloads/${name} {`);
    assert.ok(start >= 0);
    assert.ok(nginx.slice(start, start + 180).includes("expires -1;"));
  }
  const installer = await readFile(path.join(root, "server/deploy/install.sh"), "utf8");
  for (const file of [...SITE_FILES, "assets/icon.png"]) {
    assert.ok(installer.includes(`site/${file}`));
  }
  assert.match(installer, /Landing page readiness check failed/);
  assert.ok(installer.includes("site/downloads/biliskip.zip|site/downloads/biliskip.zip.sha256"));
  assert.ok(installer.includes('"$previous_release/site/downloads"/biliskip-*.zip*'));
  assert.ok(
    installer.includes('cp -p -- "$old_download" "$release_dir/site/downloads/$download_name"'),
  );
  assert.ok(installer.includes("[[ ! -e $release_dir/site/downloads/$download_name ]]"));
});

test("home statistics request only public aggregates and render numbers with textContent", async (t) => {
  const html = await readFile(path.join(root, "server/site/index.html"), "utf8");
  const source = await readFile(path.join(root, "server/site/stats.js"), "utf8");
  const valid = {
    schema_version: 1,
    basis: "latest-active-per-video-part-ad-duration",
    cached_videos: 1234,
    saved_seconds: 3661.9,
  };
  const cases = [
    { data: valid, videos: "1,234 个", saved: "1 小时 1 分 1 秒" },
    { data: { ...valid, cached_videos: 0, saved_seconds: 0 }, videos: "0 个", saved: "0 秒" },
    { data: { ...valid, saved_seconds: 59.999 }, videos: "1,234 个", saved: "59 秒" },
    { data: { ...valid, saved_seconds: -1 } },
    { data: { ...valid, cached_videos: '<img src=x onerror="alert(1)">' } },
    { data: { ...valid, basis: "other" } },
    { data: { ...valid, schema_version: 2 } },
    { status: 503 },
    { error: true },
  ];
  for (const item of cases) {
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://cache.example.com/" });
    t.after(() => dom.window.close());
    dom.window.AbortSignal = AbortSignal;
    let calls = 0;
    dom.window.fetch = async (url, options) => {
      calls++;
      assert.equal(url, "/v1/stats");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers, undefined);
      if (item.error) {
        throw new Error("Simulated network error");
      }
      return { ok: item.status !== 503, json: async () => item.data };
    };
    await dom.window.eval(source);
    const document = dom.window.document;
    assert.equal(calls, 1);
    assert.equal(document.getElementById("stats-videos").textContent, item.videos || "—");
    assert.equal(document.getElementById("stats-saved").textContent, item.saved || "—");
    assert.match(
      document.getElementById("stats-status").textContent,
      item.saved ? /各计一次/ : /暂时不可用/,
    );
    assert.equal(document.querySelectorAll(".cache-statistics img").length, 0);
  }
});

test("site theme navigation icons and real demo links are present on every page", async () => {
  const css = await readFile(new URL("../server/site/site.css", import.meta.url), "utf8");
  assert.match(css, /--link: #245fd5/);
  assert.doesNotMatch(css, /#156a54|#16634f|#eef7f3|#0e4f3e/);
  for (const file of ["index.html", "privacy.html"]) {
    const dom = new JSDOM(
      await readFile(new URL(`../server/site/${file}`, import.meta.url), "utf8"),
    );
    const links = [...dom.window.document.querySelectorAll(".site-header nav a")];
    assert.equal(links.length, 4);
    assert.equal(dom.window.document.querySelectorAll('a[href*="/results"]').length, 0);
    for (const link of links) {
      assert.ok(link.querySelector('svg[aria-hidden="true"]'));
    }
    if (file === "index.html") {
      const demo = dom.window.document.querySelector(".demo-result");
      assert.match(demo.textContent, /转转/);
      assert.match(demo.textContent, /0\.98/);
      assert.match(demo.textContent, /35\.492/);
      assert.ok(demo.querySelector('a[href="https://www.bilibili.com/video/BV1pFUDBKE8X/?t=167"]'));
    }
    dom.window.close();
  }
});
