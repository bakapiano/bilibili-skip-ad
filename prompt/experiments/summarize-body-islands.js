import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_RUNS, readJson } from "../data.js";

// Combined/derived records retain source usage for inspection; charge each source request once.
export function summarizeExperimentRuns(runs) {
  const unique = new Map(runs.map((run) => [run.id, run]));
  const totals = {
    apiCalls: 0,
    promptTokens: 0,
    outputTokens: 0,
    cacheHit: 0,
    cacheMiss: 0,
    offPeakCny: 0,
    peakCny: 0,
    failedResults: 0,
  };
  const countedRuns = [];
  const excludedDerivedRuns = [];
  for (const run of unique.values()) {
    if (!run.name?.startsWith("正文岛-")) {
      continue;
    }
    if (run.experiment?.derived || run.experiment?.variant === "repair-only-frozen") {
      excludedDerivedRuns.push(run.id);
      continue;
    }
    countedRuns.push(run.id);
    for (const row of run.results) {
      totals.apiCalls += row.apiCalls || 0;
      totals.failedResults += row.status === "error" ? 1 : 0;
      for (const field of [
        "promptTokens",
        "outputTokens",
        "cacheHit",
        "cacheMiss",
        "offPeakCny",
        "peakCny",
      ]) {
        totals[field] += row.usage?.[field] || 0;
      }
    }
  }
  return { countedRuns, excludedDerivedRuns, totals };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const files = (await readdir(DEFAULT_RUNS)).filter((file) => /^[a-f0-9-]{36}\.json$/.test(file));
  const runs = await Promise.all(files.map((file) => readJson(path.join(DEFAULT_RUNS, file))));
  console.log(JSON.stringify(summarizeExperimentRuns(runs), null, 2));
}
