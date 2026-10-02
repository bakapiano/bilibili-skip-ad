import { createServer } from "node:http";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { once } from "node:events";
import {
  LabData,
  sampleSummary,
  saveJson,
  readJson,
  validId,
  attachTranscript,
  DEFAULT_RUNS,
  sampleVideo,
} from "./data.js";
import { LabRunner, sampleInput } from "./runner.js";
import { INSTRUCTIONS } from "../extension/lib/constants.js";
import { compactPromptData } from "../extension/lib/prompt.js";
import { METRIC_POLICY, referenceSnapshot, evaluate, compareRuns } from "./metrics.js";
import { annotateRun } from "./observations.js";
import { compareConfigurations } from "./experiments/configuration-comparison.js";
import {
  ExclusionStore,
  exclusionFor,
  datasetOverview,
  datasetRunView,
  comparisonProjection,
  inputKey,
} from "./datasets.js";

const UI_ROOT = fileURLToPath(new URL("./ui/", import.meta.url));
const TYPES = {
  "/": "text/html; charset=utf-8",
  "/app.js": "application/javascript; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
  "/experiments.html": "text/html; charset=utf-8",
};
async function body(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) {
    throw new Error("请求须为JSON。");
  }
  if (Number(request.headers["content-length"]) > 512 * 1024) {
    throw new Error("请求体超过512KiB。");
  }
  const parts = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 512 * 1024) {
      throw new Error("请求体超过512KiB。");
    }
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
export function createLabServer({
  db = new LabData(),
  runsRoot = DEFAULT_RUNS,
  fetcher = fetch,
  keyProvider,
} = {}) {
  const runner = new LabRunner({ db, runsRoot, fetcher, keyProvider });
  const exclusions = new ExclusionStore(db.root);
  let mutatingDataset = false;
  async function runFiles() {
    const files = await readdir(runsRoot).catch(() => []);
    return files.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f));
  }
  const csrf = randomBytes(32).toString("hex");
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 15000 },
    async (request, response) => {
      const send = (status, value) => {
        if (response.destroyed) {
          return;
        }
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(value));
      };
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      response.setHeader("Referrer-Policy", "no-referrer");
      const host = `127.0.0.1:${server.address()?.port}`;
      const origin = `http://${host}`;
      if (
        request.headers.host !== host ||
        request.headers["sec-fetch-site"] === "cross-site" ||
        (request.headers.origin && request.headers.origin !== origin)
      ) {
        send(403, { error: "只接受本机同源请求。" });
        return;
      }
      try {
        const url = new URL(request.url, origin);
        if (url.origin !== origin) {
          throw new Error("请求目标必须为本机靶场。");
        }
        if (request.method === "GET" && Object.hasOwn(TYPES, url.pathname)) {
          const bytes = await readFile(
            path.join(UI_ROOT, url.pathname === "/" ? "index.html" : url.pathname.slice(1)),
          );
          response.writeHead(200, { "Content-Type": TYPES[url.pathname] });
          response.end(bytes);
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/bootstrap") {
          send(200, {
            csrf,
            productionPrompt: INSTRUCTIONS,
            productionProtocol: "partition-ad-only",
            hasEnvironmentKey: Boolean(await runner.keyProvider()),
            dataRoot: db.root,
            activeRun: runner.active?.id || null,
            metricPolicy: METRIC_POLICY,
            protocols: ["pipe", "partition-ad-only"],
          });
          return;
        }
        const supplied = request.headers["x-lab-token"] || "";
        if (
          typeof supplied !== "string" ||
          supplied.length !== csrf.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf))
        ) {
          send(403, { error: "靶场会话校验失败，请刷新本机页面。" });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/cases") {
          const [samples, ledger] = await Promise.all([db.list(), exclusions.read()]);
          send(200, {
            cases: samples.map((s) => ({
              ...sampleSummary(s),
              exclusion: exclusionFor(s, ledger),
            })),
            datasets: datasetOverview(samples, ledger),
            datasetRevision: ledger.revision,
            audit: await readJson(path.join(db.root, "audit.json"), null),
          });
          return;
        }
        if (request.method === "GET" && url.pathname.startsWith("/api/case/")) {
          const sample = await db.get(url.pathname.slice("/api/case/".length));
          let input = null;
          if (sample.transcript.context) {
            try {
              input = compactPromptData(
                (await sampleInput(sample, { allowAlternate: true })).context,
              );
            } catch {
              /* Surface the invalid/missing input through the case, never run it. */
            }
          }
          const evaluation = sample.baseline
            ? evaluate(sampleVideo(sample), sample.baseline.segments, referenceSnapshot(sample))
            : null;
          send(200, {
            sample,
            input,
            evaluation,
            exclusion: exclusionFor(sample, await exclusions.read()),
          });
          return;
        }
        if (request.method === "GET" && url.pathname.startsWith("/api/case-runs/")) {
          const sample = await db.get(url.pathname.slice("/api/case-runs/".length));
          const [samples, ledger] = await Promise.all([db.list(), exclusions.read()]);
          const history = [];
          for (const file of await runFiles()) {
            const run = annotateRun(await readJson(path.join(runsRoot, file)));
            if (!run.results.some((row) => inputKey(row) === inputKey(sample))) {
              continue;
            }
            const view = datasetRunView(run, samples, ledger, { caseId: sample.id });
            if (view.results.length) {
              history.push({
                id: run.id,
                name: run.name || "历史批次",
                prompt: run.prompt,
                promptSha256: run.promptSha256,
                settings: run.settings,
                experiment: run.experiment,
                startedAt: run.startedAt,
                status: run.status,
                results: view.results,
              });
            }
          }
          send(200, {
            runs: history.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
            datasetRevision: ledger.revision,
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/runs") {
          const files = await runFiles();
          const rows = [];
          for (const file of files.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))) {
            const run = await readJson(path.join(runsRoot, file));
            rows.push({
              id: run.id,
              name: run.name || "历史批次",
              schemaVersion: run.schemaVersion,
              sampleIds: run.sampleIds || [...new Set(run.results.map((r) => r.caseId))],
              dataset: run.dataset || null,
              startedAt: run.startedAt,
              status:
                runner.active?.id === run.id
                  ? run.status
                  : ["running", "preparing"].includes(run.status)
                    ? "interrupted"
                    : run.status,
              plannedCalls: run.plannedCalls,
              completed: run.results.length,
              promptSha256: run.promptSha256,
            });
          }
          send(200, {
            runs: rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100),
          });
          return;
        }
        if (request.method === "GET" && url.pathname.startsWith("/api/run/")) {
          const id = url.pathname.slice(9);
          if (!validId(id)) {
            throw new Error("运行ID格式异常。");
          }
          const result = await readJson(path.join(runsRoot, `${id}.json`));
          if (["running", "preparing"].includes(result.status) && runner.active?.id !== id) {
            result.status = "interrupted";
          }
          const [samples, ledger] = await Promise.all([db.list(), exclusions.read()]);
          send(
            200,
            annotateRun(
              datasetRunView(result, samples, ledger, {
                dataset: url.searchParams.get("dataset") || "all",
                original: url.searchParams.get("view") === "original",
              }),
            ),
          );
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/compare") {
          const baseline = url.searchParams.get("baseline");
          const candidate = url.searchParams.get("candidate");
          if (!validId(baseline) || !validId(candidate) || baseline === candidate) {
            throw new Error("请选择两个不同的有效批次。");
          }
          const reports = await Promise.all(
            [baseline, candidate].map((id) => readJson(path.join(runsRoot, `${id}.json`))),
          );
          const [samples, ledger] = await Promise.all([db.list(), exclusions.read()]);
          const options = {
            dataset: url.searchParams.get("dataset") || "all",
            original: url.searchParams.get("view") === "original",
            caseId: url.searchParams.get("case") || null,
          };
          if (options.caseId && !validId(options.caseId)) {
            throw new Error("样本ID格式异常。");
          }
          const views = reports.map((r) => datasetRunView(r, samples, ledger, options));
          const compare =
            url.searchParams.get("configuration") === "1" ? compareConfigurations : compareRuns;
          send(200, {
            ...compare(...views.map(comparisonProjection)),
            datasetRevision: ledger.revision,
            datasetViews: views.map((v) => v.datasetView),
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/prompts") {
          const directory = path.join(db.root, "prompts");
          const files = await readdir(directory).catch(() => []);
          send(200, {
            prompts: await Promise.all(
              files
                .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
                .map((file) => readJson(path.join(directory, file))),
            ),
          });
          return;
        }
        if (request.method !== "POST" || request.headers.origin !== origin) {
          send(404, { error: "接口不存在或方法异常。" });
          return;
        }
        const payload = await body(request);
        if (url.pathname === "/api/run") {
          if (mutatingDataset) {
            throw new Error("测试集正在更新，请稍后运行。");
          }
          send(202, await runner.start(payload, payload.apiKey));
          return;
        }
        if (url.pathname === "/api/cancel") {
          send(200, runner.cancel(payload.id));
          return;
        }
        if (url.pathname === "/api/exclusion") {
          if (runner.active || mutatingDataset) {
            throw new Error("请等待当前任务完成后修改有效测试集。");
          }
          mutatingDataset = true;
          try {
            const sample = await db.get(payload.id);
            const key = await runner.keyProvider();
            if (
              typeof payload.reason === "string" &&
              ((key && payload.reason.includes(key)) ||
                /\bsk-[A-Za-z0-9_-]{24,}\b|SESSDATA\s*[:=]/.test(payload.reason))
            ) {
              throw new Error("请移除原因中的凭据信息。");
            }
            const ledger = await exclusions.change(sample, payload);
            send(200, {
              exclusion: exclusionFor(sample, ledger),
              datasetRevision: ledger.revision,
            });
          } finally {
            mutatingDataset = false;
          }
          return;
        }
        if (url.pathname === "/api/prompt") {
          if (
            typeof payload.name !== "string" ||
            !payload.name.trim() ||
            payload.name.length > 100 ||
            typeof payload.prompt !== "string" ||
            !payload.prompt.trim() ||
            payload.prompt.length > 30000
          ) {
            throw new Error("Prompt名称或内容格式异常。");
          }
          const key = await runner.keyProvider();
          if (key && payload.prompt.includes(key)) {
            throw new Error("请移除Prompt中的凭据。");
          }
          const prompt = {
            id: randomUUID(),
            name: payload.name,
            prompt: payload.prompt,
            createdAt: new Date().toISOString(),
          };
          await saveJson(path.join(db.root, "prompts", `${prompt.id}.json`), prompt);
          send(201, prompt);
          return;
        }
        if (url.pathname === "/api/transcript") {
          if (runner.active) {
            throw new Error("请等待当前批次完成后修改字幕。");
          }
          const sample = await db.get(payload.id);
          await attachTranscript(sample, payload.context, { kind: "manual-import" });
          await db.save(sample);
          await db.manifest();
          send(200, sampleSummary(sample));
          return;
        }
        if (url.pathname === "/api/review") {
          if (runner.active) {
            throw new Error("请等待当前批次完成后保存人工参考。");
          }
          const sample = await db.get(payload.id);
          if (
            typeof payload.note !== "string" ||
            payload.note.length > 4000 ||
            !Array.isArray(payload.segments) ||
            payload.segments.length > 50
          ) {
            throw new Error("人工参考格式异常。");
          }
          let end = 0;
          for (const range of payload.segments) {
            if (
              !Number.isFinite(range.start) ||
              !Number.isFinite(range.end) ||
              range.start < end ||
              range.end <= range.start ||
              range.end > sampleVideo(sample).duration
            ) {
              throw new Error("人工区间应排序、互不重叠且在视频范围内。");
            }
            end = range.end;
          }
          sample.review = {
            status: "complete",
            segments: payload.segments.map(({ start, end }) => ({ start, end })),
            note: payload.note,
            reviewedAt: new Date().toISOString(),
            source: "local-user-review",
            preserve: sample.review?.preserve || [],
          };
          await db.save(sample);
          await db.manifest();
          send(200, sampleSummary(sample));
          return;
        }
        send(404, { error: "接口不存在。" });
      } catch (error) {
        send(400, {
          error: error.code === "ENOENT" ? "本地文件不存在。" : String(error.message).slice(0, 500),
        });
      }
    },
  );
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  server.setTimeout(15000, (socket) => socket.destroy());
  server.runner = runner;
  return server;
}
async function main() {
  const port = Number(process.env.BILISKIP_LAB_PORT || 43820);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("本机端口应为1024至65535。");
  }
  const server = createLabServer({ db: new LabData(process.env.BILISKIP_LAB_DATA) });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  console.log(`BiliSkip Prompt Lab: http://127.0.0.1:${port}/`);
  console.log("仅本机访问；执行按钮才发送字幕到DeepSeek。数据和运行记录保持本地。");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
