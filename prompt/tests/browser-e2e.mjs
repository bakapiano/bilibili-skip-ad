import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLabServer } from "../server.js";
import { LabData, digest, saveJson } from "../data.js";
import { normalize } from "../../extension/lib/core.js";
import { MODEL } from "../../extension/lib/constants.js";
import { video, body, pipeOutput, usage } from "../../tests/extension/fixtures.js";

// Optional browser regression: model fetches are synthetic and all browser traffic is localhost-only.
const { chromium } = await import(process.env.BILISKIP_PLAYWRIGHT_MODULE || "playwright");
await mkdir(".tmp", { recursive: true });
const root = await mkdtemp(path.resolve(".tmp/prompt-environment-e2e-"));
const db = new LabData(path.join(root, "data"));
for (const [bvid, title, reference] of [
  [video.bvid, "合成有广告样本", [{ start: 10, end: 20 }]],
  ["BV1eVaz6UENn", "合成零广告样本", []],
]) {
  const context = await normalize({ ...video, bvid, title }, body);
  await db.save({
    id: randomUUID(),
    video: context.video,
    createdAt: new Date().toISOString(),
    baseline: null,
    transcript: { status: "ready", context },
    datasets: ["synthetic"],
    split: "development",
    community: { status: "missing", segments: [] },
    review: { status: "complete", segments: reference },
  });
}
let modelCalls = 0;
const mockServer = createLabServer({
  db,
  runsRoot: path.join(root, "runs"),
  keyProvider: () => "synthetic-e2e-key",
  fetcher: async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer synthetic-e2e-key");
    modelCalls++;
    const request = JSON.parse(options.body);
    const negative = request.messages[1].content.includes("合成零广告样本");
    const candidate = request.messages[0].content === "synthetic-candidate";
    const output = candidate
      ? negative
        ? pipeOutput
        : pipeOutput.replace("0.98", "0.80")
      : negative
        ? "NONE"
        : pipeOutput;
    return new Response(
      JSON.stringify({
        model: MODEL,
        choices: [{ finish_reason: "stop", message: { content: output } }],
        usage,
      }),
    );
  },
});
mockServer.listen(0, "127.0.0.1");
await once(mockServer, "listening");
const origin = `http://127.0.0.1:${mockServer.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BILISKIP_CHROME_EXECUTABLE
    ? { executablePath: process.env.BILISKIP_CHROME_EXECUTABLE }
    : {}),
});
const report = { artifactRoot: root, modelCalls: 0, pageErrors: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1550, height: 1100 } });
  page.on("pageerror", (e) => report.pageErrors.push(e.message));
  await page.route("**/*", (route) => {
    assert.equal(new URL(route.request().url()).origin, origin);
    return route.continue();
  });
  await page.goto(origin);
  await page.locator("#dataset-cards button").first().waitFor();
  assert.equal(await page.locator("#overview-view").isVisible(), true);
  await page.selectOption("#cohort-filter", "all");
  await page.click("#tab-samples");
  assert.equal(await page.locator(".case-row").count(), 2);
  await page.click("#select-visible");
  await page.click("#debug-selected");
  const runs = [];
  for (const prompt of ["synthetic-baseline", "synthetic-candidate"]) {
    await page.fill("#prompt", prompt);
    await page.fill("#run-name", prompt);
    await page.check("#consent");
    const response = page.waitForResponse(
      (r) => r.url() === `${origin}/api/run` && r.request().method() === "POST",
    );
    await page.click("#run-selected");
    const started = await (await response).json();
    assert.ok(started.id);
    await page.waitForFunction(
      (hash) => {
        const text = document.getElementById("run-status").textContent;
        return text.startsWith("done") && text.includes(hash);
      },
      digest(prompt).slice(0, 12),
    );
    assert.equal(await page.locator("#run-metrics .metric-card").count(), 3);
    runs.push(started.id);
  }
  await page.waitForFunction(
    (id) => [...document.getElementById("candidate-run").options].some((o) => o.value === id),
    runs[1],
  );
  await page.click("#tab-compare");
  await page.selectOption("#baseline-run", runs[0]);
  await page.selectOption("#candidate-run", runs[1]);
  const compared = page.waitForResponse((r) => r.url().startsWith(`${origin}/api/compare?`));
  await page.click("#compare-runs");
  report.comparison = await (await compared).json();
  assert.equal(report.comparison.verdict, "blocked");
  assert.equal(report.comparison.hardRegressions, 1);
  assert.equal(report.comparison.paired, 2);
  assert.equal(report.comparison.before.meanIou, 1);
  assert.equal(report.comparison.after.adMissRate, 1);
  await page.locator("#comparison-results tbody tr").first().waitFor();
  assert.equal(await page.locator("#comparison-results tbody tr").count(), 2);
  await page.locator("#comparison-panel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, "comparison.png") });
  assert.equal(modelCalls, 4);
  report.modelCalls = modelCalls;
  const stored = await readFile(path.join(root, "runs", `${runs[1]}.json`), "utf8");
  await page.click("#tab-samples");
  await page.fill("#search", "合成零广告");
  await page.locator(".case-row button").first().click();
  await page.waitForFunction(() =>
    document.getElementById("sample-run-status").textContent.includes("2 个实验"),
  );
  assert.equal(await page.locator("#debug-view").isVisible(), true);
  await page.locator("#sample-runs button").filter({ hasText: "载入此 Prompt" }).first().click();
  assert.equal(await page.locator("#prompt").inputValue(), "synthetic-candidate");
  await page.selectOption("#debug-baseline", runs[0]);
  await page.selectOption("#debug-candidate", runs[1]);
  await page.click("#compare-sample");
  await page.waitForFunction(() =>
    document.getElementById("sample-comparison").textContent.includes("blocked"),
  );
  await page.locator("#sample-runs button").filter({ hasText: "查看结果" }).first().click();
  await page.locator("#outlier-detail .outlier-subtitles h4").waitFor();
  await page.locator("#outlier-detail .membership-action").click();
  assert.equal(await page.locator("#exclusion-dialog").isVisible(), true);
  await page.click("#confirm-exclusion");
  assert.equal(await page.locator("#exclusion-dialog").isVisible(), true);
  await page.fill("#exclusion-reason", "Synthetic reason: reference requires review");
  const exclusionResponse = page.waitForResponse((r) => r.url() === `${origin}/api/exclusion`);
  await page.click("#confirm-exclusion");
  assert.equal((await exclusionResponse).status(), 200);
  await page.waitForFunction(() =>
    document.getElementById("dataset-counts").textContent.includes("已移除 1"),
  );
  await page.click("#tab-overview");
  await page.waitForFunction(() =>
    document.getElementById("run-status").textContent.includes("可计分 1"),
  );
  assert.match(await page.locator("#run-metrics").textContent(), /0.00%/);
  await page.selectOption("#metric-view", "original");
  await page.waitForFunction(() =>
    document.getElementById("run-status").textContent.includes("可计分 2"),
  );
  assert.match(await page.locator("#run-metrics").textContent(), /5.26%/);
  await page.selectOption("#metric-view", "current");
  await page.click("#tab-samples");
  await page.selectOption("#membership-filter", "removed");
  assert.match(await page.locator("#case-list").textContent(), /Synthetic reason/);
  await page.locator(".case-row .membership-action").click();
  await page.fill("#exclusion-reason", "Synthetic review: restored");
  await page.click("#confirm-exclusion");
  await page.waitForFunction(() =>
    document.getElementById("dataset-counts").textContent.includes("已移除 0"),
  );
  assert.equal(await readFile(path.join(root, "runs", `${runs[1]}.json`), "utf8"), stored);
  assert.equal(modelCalls, 4);
  report.removalRestoration = true;
  report.historicalRunUnchanged = true;
  report.samplePromptComparison = true;
  const actualOrigin = process.env.BILISKIP_REAL_LAB_ORIGIN;
  if (actualOrigin) {
    const actual = await browser.newPage({ viewport: { width: 1550, height: 1100 } });
    actual.on("pageerror", (e) => report.pageErrors.push(e.message));
    await actual.route("**/*", (route) => {
      assert.equal(new URL(route.request().url()).origin, actualOrigin);
      assert.equal(route.request().method(), "GET");
      return route.continue();
    });
    await actual.goto(
      `${actualOrigin}/?run=834d0889-6228-41f1-b08b-cbe968617ab8&dataset=community`,
    );
    await actual.locator("#outlier-table tbody tr").first().waitFor();
    assert.equal(await actual.locator("#overview-view").isVisible(), true);
    assert.match(await actual.locator("#dataset-counts").textContent(), /总样本 570/);
    const issueCount = Number(await actual.locator("#issue-count").textContent());
    assert.ok(Number.isInteger(issueCount) && issueCount >= 0);
    await actual.click("#tab-issues");
    assert.equal(await actual.locator("#outlier-filter").inputValue(), "noted");
    assert.equal(await actual.locator("#outlier-table tbody tr").count(), Math.min(10, issueCount));
    assert.equal(
      await actual.locator("#outlier-table .reason-summary").count(),
      Math.min(10, issueCount),
    );
    await actual.reload();
    await actual.waitForFunction(
      () => document.getElementById("tab-issues").getAttribute("aria-pressed") === "true",
    );
    assert.equal(await actual.locator("#outlier-filter").inputValue(), "noted");
    report.prominentIssueEntry = true;
    await actual.screenshot({ path: path.join(root, "actual-data.png") });
    await actual.fill("#outlier-search", "BV1Lmd2BAEad");
    await actual.locator("#outlier-table tbody button").first().click();
    await actual.locator("#outlier-detail .outlier-subtitles h4").waitFor();
    assert.equal(await actual.locator("#debug-view").isVisible(), true);
    await actual.click("#back-to-dataset");
    assert.equal(await actual.locator("#tab-issues").getAttribute("aria-pressed"), "true");
    await actual.locator("#outlier-table tbody button").first().click();
    await actual.locator("#outlier-detail .outlier-subtitles h4").waitFor();
    await actual.waitForFunction(() =>
      /\d+ 个实验/.test(document.getElementById("sample-run-status").textContent),
    );
    await actual.locator("#outlier-detail .membership-action").click();
    await actual.fill("#exclusion-reason", "仅验证输入框，不提交真实样本移除");
    await actual.screenshot({ path: path.join(root, "removal-dialog.png") });
    await actual.click("#cancel-exclusion");
    await actual.screenshot({ path: path.join(root, "sample-debug.png") });
    await actual.selectOption("#cohort-filter", "community-542");
    await actual.click("#tab-samples");
    assert.match(await actual.locator("#dataset-counts").textContent(), /总样本 542/);
    assert.equal(await actual.locator(".case-row").count(), 20);
    await actual.click("#select-visible");
    await actual.click("#debug-selected");
    assert.match(await actual.locator("#call-count").textContent(), /542 次批量调用/);
    await actual.fill("#confirmed-calls", "1");
    await actual.check("#consent");
    await actual.click("#run-selected");
    assert.match(await actual.locator("#toast").textContent(), /542/);
    await actual.reload();
    await actual.locator("#dataset-cards button").first().waitFor();
    await actual.setViewportSize({ width: 390, height: 844 });
    await actual.screenshot({ path: path.join(root, "mobile.png"), fullPage: true });
    assert.equal(
      await actual.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    report.actualInputs = 614;
    report.communityInputs = 542;
    report.actualPaidCalls = 0;
  }
  assert.deepEqual(report.pageErrors, []);
  await saveJson(path.join(root, "report.json"), report);
  console.log(
    JSON.stringify(
      {
        ...report,
        comparison: {
          verdict: report.comparison.verdict,
          paired: report.comparison.paired,
          before: report.comparison.before,
          after: report.comparison.after,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  mockServer.closeAllConnections();
  await new Promise((resolve) => mockServer.close(resolve));
}
