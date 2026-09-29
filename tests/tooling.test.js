import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import * as prettier from "prettier";

const root = fileURLToPath(new URL("../", import.meta.url));
const eslint = new ESLint({ cwd: root });

test("MIT declarations match and distributable archives retain the license", async () => {
  const license = await readFile(path.join(root, "LICENSE"), "utf8");
  assert.match(license, /^MIT License\n/);
  assert.match(license, /Copyright \(c\) 2026 bakapiano/);
  assert.equal(await readFile(path.join(root, "extension/LICENSE"), "utf8"), license);
  for (const [file, manifest] of [
    ["package.json", (data) => data],
    ["package-lock.json", (data) => data.packages[""]],
  ]) {
    assert.equal(
      manifest(JSON.parse(await readFile(path.join(root, file), "utf8"))).license,
      "MIT",
    );
  }
  assert.match(
    await readFile(path.join(root, "scripts/package-extension.ps1"), "utf8"),
    /FullName -ne 'LICENSE'/,
  );
  assert.match(await readFile(path.join(root, "server/deploy.ps1"), "utf8"), /'LICENSE',/);
  assert.match(
    await readFile(path.join(root, "server/deploy/install.sh"), "utf8"),
    /LICENSE\|package\.json/,
  );
});

test("ESLint covers all maintained JavaScript sources and module extensions", async () => {
  async function sources(directory) {
    const files = [];
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await sources(relative)));
      } else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) {
        files.push(relative);
      }
    }
    return files;
  }

  const files = [
    "eslint.config.js",
    ...(await sources("extension")),
    ...(await sources("userscript")),
    ...(await sources("scripts")),
    ...(await sources("server")),
    ...(await sources("tests")),
    "scripts/example.cjs",
    "scripts/example.mjs",
  ];
  for (const file of files) {
    assert.equal(await eslint.isPathIgnored(file), false, file);
    const config = await eslint.calculateConfigForFile(file);
    assert.equal(config.rules["no-undef"][0], 2, file);
    assert.equal(config.rules.curly[0], 2, file);
    assert.equal(config.rules["one-var"][0], 2, file);
  }
});

test("ESLint enforces explicit blocks, separate declarations and strict comparisons", async () => {
  const [result] = await eslint.lintText(
    "var first = 1, second = 2; if (first == second) console.log(first);",
    { filePath: "scripts/example.js" },
  );
  const rules = new Set(result.messages.map((message) => message.ruleId));
  for (const rule of ["no-var", "one-var", "eqeqeq", "curly"]) {
    assert.ok(rules.has(rule), rule);
  }
});

test("ESLint isolates Node, browser pages and extension worker globals", async () => {
  const cases = [
    ["scripts/example.js", "process.exitCode = 0;", "document"],
    ["extension/options.js", "document.title = chrome.runtime.id;", "process"],
    ["extension/background.js", "chrome.runtime.getManifest();", "document"],
  ];
  for (const [filePath, source, wrongGlobal] of cases) {
    const [valid] = await eslint.lintText(source, { filePath });
    assert.deepEqual(valid.messages, [], filePath);
    const [invalid] = await eslint.lintText(`${wrongGlobal}.example();`, { filePath });
    assert.ok(
      invalid.messages.some((message) => message.ruleId === "no-undef"),
      filePath,
    );
  }
});

test("temporary scripts and generated output stay outside maintained lint scope", async () => {
  for (const directory of [".tmp", "data", "runs", "dist", ".models", ".runtime"]) {
    assert.equal(await eslint.isPathIgnored(`${directory}/example.js`), true, directory);
  }
});

test("Prettier expands compressed statements and enforces the shared format", async () => {
  const config = await prettier.resolveConfig(path.join(root, "extension/content.js"));
  assert.equal(config.tabWidth, 2);
  assert.equal(config.printWidth, 100);
  assert.equal(config.endOfLine, "lf");
  const options = { ...config, parser: "babel" };
  const compressed = "function example(){const value=1;return value;}\r\n";
  assert.equal(await prettier.check(compressed, options), false);
  const formatted = await prettier.format(compressed, options);
  assert.equal(formatted, "function example() {\n  const value = 1;\n  return value;\n}\n");
  assert.equal(await prettier.check(formatted, options), true);
});
