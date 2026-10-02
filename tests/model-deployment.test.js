import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ASR_MODEL } from "../extension/lib/asr-config.js";
import { ASR_ASSETS, ASR_ASSET_BASE } from "../userscript/asr-assets.js";

test("model deployment and Nginx expose the exact pinned data path and retain API routing", async () => {
  const nginx = await readFile(new URL("../server/deploy/nginx.conf", import.meta.url), "utf8");
  const path = new URL(ASR_MODEL.url).pathname;
  assert.ok(nginx.includes(`location = ${path} {`));
  assert.ok(nginx.includes(`alias /srv/biliskipad${path};`));
  assert.match(nginx, /Access-Control-Allow-Origin "\*"/);
  assert.match(nginx, /max-age=31536000, immutable/);
  assert.match(nginx, /location \/v1\//);
  assert.match(nginx, /max_ranges 1/);
  const shell = await readFile(new URL("../server/deploy/model.sh", import.meta.url), "utf8");
  assert.ok(shell.includes(ASR_MODEL.sha256));
  assert.ok(shell.includes(String(ASR_MODEL.bytes)));
  assert.match(shell, /sha256sum --check/);
  assert.match(shell, /trap rollback EXIT/);
  const manifest = JSON.parse(
    await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
  );
  assert.ok(manifest.host_permissions.includes(`${new URL(ASR_MODEL.url).origin}/*`));
  assert.equal(
    manifest.host_permissions.some((host) => /huggingface|hf\.co/.test(host)),
    false,
  );
});

test("SRI resource deployment pins binaries and serves immutable public files separately", async () => {
  const nginx = await readFile(new URL("../server/deploy/nginx.conf", import.meta.url), "utf8");
  const shell = await readFile(
    new URL("../server/deploy/asr-resources.sh", import.meta.url),
    "utf8",
  );
  const path = new URL(ASR_ASSET_BASE).pathname;
  assert.ok(nginx.includes(`location ^~ ${path}/ {`));
  assert.ok(nginx.includes(`alias /srv/biliskipad${path}/;`));
  assert.match(nginx, /application\/wasm wasm/);
  assert.match(nginx, /disable_symlinks on/);
  assert.match(shell, /sha256sum --check/);
  assert.match(shell, /trap rollback EXIT/);
  for (const asset of ASR_ASSETS) {
    assert.ok(shell.includes(asset.sha256));
    assert.ok(shell.includes(String(asset.bytes)));
  }
});

test("both deployment packages include the badge module required by the cache API", async () => {
  for (const file of ["deploy.ps1", "deploy-api.ps1", "deploy/api.sh"]) {
    const text = await readFile(new URL(`../server/${file}`, import.meta.url), "utf8");
    assert.ok(text.includes("server/badges.js"), file);
  }
});
