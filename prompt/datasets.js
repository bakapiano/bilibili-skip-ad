import path from "node:path";
import { randomUUID } from "node:crypto";
import { digest, readJson, saveJson, sampleSummary, sampleVideo } from "./data.js";
import { aggregateMetrics, evaluateRun } from "./metrics.js";

export const TEST_SETS = [
  { id: "community", name: "全部社区对照", description: "字幕完整，具有有效社区广告区间" },
  {
    id: "community-1000",
    name: "社区固定 1000 条",
    description: "原567条有效输入与新增433条，按采集顺序冻结；沿用全局移除记录",
  },
  { id: "community-542", name: "社区随机采集", description: "随机哈希桶采集的字幕样本" },
  {
    id: "community-expanded",
    name: "扩充随机采集",
    description: "新增随机哈希桶样本，保留字幕与社区对照",
  },
  { id: "legacy", name: "历史回归集", description: "历史模型标注与已确认正文案例" },
  { id: "all", name: "全部字幕输入", description: "所有有字幕输入，保留缺少参考的样本" },
];

export function inputKey(value) {
  const video = value.video || sampleVideo(value);
  const hash =
    value.transcriptSha256 ||
    value.transcript?.context?.transcript_sha256 ||
    value.baseline?.transcript_sha256;
  return digest({ bvid: video?.bvid, page: video?.page, cid: video?.cid, transcriptSha256: hash });
}

export function inTestSet(sample, id) {
  if (!TEST_SETS.some((s) => s.id === id)) {
    throw new Error("测试集标识异常。");
  }
  return (
    id === "all" ||
    (id === "community"
      ? sampleSummary(sample).referenceCount > 0
      : (sample.datasets || ["legacy"]).includes(id))
  );
}

export class ExclusionStore {
  constructor(root) {
    this.file = path.join(root, "exclusions.json");
    this.queue = Promise.resolve();
  }
  async read() {
    const value = await readJson(this.file, { version: 1, entries: {}, events: [] });
    if (value.version !== 1 || !value.entries || !Array.isArray(value.events)) {
      throw new Error("移除记录格式异常，请核对本地数据。");
    }
    return { ...value, revision: digest({ entries: value.entries, events: value.events }) };
  }
  change(sample, options) {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        if (
          typeof options.excluded !== "boolean" ||
          typeof options.reason !== "string" ||
          !options.reason.trim() ||
          options.reason.length > 1000
        ) {
          throw new Error("请填写1至1000字符的移除或恢复原因。");
        }
        const current = await this.read();
        if (options.revision !== current.revision) {
          throw new Error("测试集已在其他页面更新，请刷新后再操作。");
        }
        const key = inputKey(sample);
        const event = {
          id: randomUUID(),
          key,
          caseId: sample.id,
          video: sampleVideo(sample),
          excluded: options.excluded,
          reason: options.reason.trim(),
          at: new Date().toISOString(),
        };
        current.entries[key] = event;
        current.events.push(event);
        await saveJson(this.file, { version: 1, entries: current.entries, events: current.events });
        return this.read();
      });
    this.queue = task;
    return task;
  }
}

export function exclusionFor(sample, ledger) {
  return ledger.entries[inputKey(sample)] || null;
}

export function datasetOverview(samples, ledger) {
  return TEST_SETS.map((set) => {
    const members = samples.filter((sample) => inTestSet(sample, set.id));
    const active = members.filter((sample) => !exclusionFor(sample, ledger)?.excluded);
    return {
      ...set,
      total: members.length,
      active: active.length,
      removed: members.length - active.length,
      referenced: active.filter((s) => sampleSummary(s).referenceCount > 0).length,
    };
  });
}

export function datasetRunView(
  run,
  samples,
  ledger,
  { dataset = "all", original = false, caseId = null } = {},
) {
  if (!TEST_SETS.some((s) => s.id === dataset)) {
    throw new Error("测试集标识异常。");
  }
  const byKey = new Map(samples.map((s) => [inputKey(s), s]));
  const byId = new Map();
  for (const sample of samples) {
    byId.set(sample.id, sample);
    for (const origin of sample.source?.origins || []) {
      if (origin.kind === "legacy") {
        byId.set(origin.id, sample);
      }
    }
  }
  const evaluated = evaluateRun(run);
  const rows = [];
  for (const row of evaluated.results) {
    const sample = byKey.get(inputKey(row));
    const sameCase = !caseId || sample?.id === caseId;
    if (!sameCase || (dataset !== "all" && (!sample || !inTestSet(sample, dataset)))) {
      continue;
    }
    const exclusion = ledger.entries[inputKey(row)] || null;
    rows.push({
      ...row,
      currentCaseId: sample?.id || null,
      exclusion,
      excludedFromDataset: !original && Boolean(exclusion?.excluded),
    });
  }
  const member = (sample) =>
    sample && (!caseId || sample.id === caseId) && inTestSet(sample, dataset);
  const expected = Array.isArray(run.sampleIds)
    ? run.sampleIds.filter((id) => member(byId.get(id)))
    : null;
  const expectedActive = expected?.filter(
    (id) => original || !exclusionFor(byId.get(id), ledger)?.excluded,
  );
  const activeRows = rows.filter((row) => !row.excludedFromDataset);
  const planned = expectedActive
    ? expectedActive.length * (run.repeats || 1)
    : dataset === "all" && !caseId
      ? run.plannedCalls
      : rows.length;
  const counts = datasetOverview(samples, ledger).find((s) => s.id === dataset);
  const coveredInputs = new Set(activeRows.map(inputKey)).size;
  return {
    ...evaluated,
    results: rows,
    metrics: aggregateMetrics(activeRows),
    originalMetrics: evaluated.metrics,
    datasetView: {
      dataset,
      original,
      revision: ledger.revision,
      total: counts.total,
      active: counts.active,
      removed: counts.removed,
      results: rows.length,
      removedResults: rows.length - activeRows.length,
      activeResults: activeRows.length,
      plannedCalls: planned,
      missing: Math.max(0, planned - activeRows.length),
      coveredInputs,
      remainingInputs: Math.max(0, (original ? counts.total : counts.active) - coveredInputs),
      excluded: rows
        .filter((r) => r.excludedFromDataset)
        .map((r) => ({
          caseId: r.currentCaseId || r.caseId,
          bvid: r.bvid,
          reason: r.exclusion.reason,
          at: r.exclusion.at,
        })),
    },
  };
}

export function comparisonProjection(view) {
  const results = view.results.filter((r) => !r.excludedFromDataset);
  const selectedComplete =
    results.length === view.datasetView.plannedCalls && results.every((r) => r.status === "done");
  return {
    ...view,
    parentStatus: view.status,
    // A failed row outside this exact, shared scope must not block a complete sample comparison.
    status: view.status === "partial" && selectedComplete ? "done" : view.status,
    results,
    plannedCalls: view.datasetView.plannedCalls,
  };
}
