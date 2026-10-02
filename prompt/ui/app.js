const $ = (id) => document.getElementById(id);
const state = {
  csrf: "",
  cases: [],
  current: null,
  selected: new Set(),
  productionPrompt: "",
  productionProtocol: "pipe",
  run: null,
  poll: null,
  prompts: [],
  epoch: 0,
  visible: [],
  outlierPage: 0,
  outlierKey: null,
  detailEpoch: 0,
  runEpoch: 0,
  datasets: [],
  datasetRevision: "",
  samplePage: 0,
  runs: [],
  sampleRuns: [],
  debugRun: null,
  workspace: "overview",
  resultsWorkspace: "overview",
  exclusionTarget: null,
};
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) {
    el.textContent = text;
  }
  if (className) {
    el.className = className;
  }
  return el;
};
const json = (value) => JSON.stringify(value, null, 2);
const datasetId = () => $("cohort-filter").value;
function belongs(item) {
  return (
    datasetId() === "all" ||
    (datasetId() === "community" ? item.referenceCount > 0 : item.datasets?.includes(datasetId()))
  );
}
function datasetQuery() {
  return new URLSearchParams({ dataset: datasetId(), view: $("metric-view").value });
}
function setWorkspace(name) {
  if (name === "issues") {
    $("outlier-filter").value = "noted";
    $("outlier-search").value = "";
    state.outlierPage = 0;
  } else if (name === "overview" && state.workspace === "issues") {
    $("outlier-filter").value = "all";
    state.outlierPage = 0;
  }
  state.workspace = name;
  if (["overview", "issues"].includes(name)) {
    state.resultsWorkspace = name;
  }
  for (const view of ["overview", "samples", "compare", "debug"]) {
    $(`${view}-view`).hidden = view !== (name === "issues" ? "overview" : name);
    $(`tab-${view}`).setAttribute("aria-pressed", String(view === name));
  }
  $("tab-issues").setAttribute("aria-pressed", String(name === "issues"));
  $("result-heading").textContent = name === "issues" ? "问题样本 · 原因与复核" : "测试集结果";
  $("outlier-heading").textContent = name === "issues" ? "带原因标签的样本" : "差异较大样本";
  renderOutliers();
  const url = new URL(location.href);
  if (name === "issues") {
    url.searchParams.set("workspace", "issues");
  } else {
    url.searchParams.delete("workspace");
  }
  globalThis.history.replaceState(null, "", url);
}
function renderDatasets() {
  $("dataset-cards").replaceChildren();
  for (const set of state.datasets) {
    const button = node(
      "button",
      undefined,
      `dataset-card${set.id === datasetId() ? " active" : ""}`,
    );
    button.dataset.dataset = set.id;
    button.append(
      node("strong", set.name),
      node("span", `${set.active} 有效 / ${set.total} 总数`),
      node("small", `已移除 ${set.removed} · ${set.description}`),
    );
    button.addEventListener("click", () => changeDataset(set.id).catch((e) => toast(e.message)));
    $("dataset-cards").append(button);
  }
  const members = state.cases.filter(belongs);
  const removed = members.filter((s) => s.exclusion?.excluded).length;
  $("dataset-counts").textContent =
    `总样本 ${members.length} · 有效 ${members.length - removed} · 已移除 ${removed} · 有社区对照 ${members.filter((s) => !s.exclusion?.excluded && s.referenceCount > 0).length}`;
  $("prepare-dataset-run").disabled = members.length === removed;
}
function toast(text) {
  $("toast").textContent = text;
  setTimeout(() => {
    $("toast").textContent = "";
  }, 6000);
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "x-lab-token": state.csrf, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "omit",
    redirect: "error",
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}
const stamp = (value) =>
  `${Math.floor(value / 60)
    .toString()
    .padStart(2, "0")}:${(value % 60).toFixed(2).padStart(5, "0")}`;
const badge = (text, kind = "") => node("span", text, `badge ${kind}`);
function link(video, text, start) {
  const a = node("a", text);
  const u = new URL(`https://www.bilibili.com/video/${video.bvid}/`);
  u.searchParams.set("p", video.page);
  if (start !== undefined) {
    u.searchParams.set("t", Math.floor(start));
  }
  a.href = u.href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
function ranges(segments) {
  return segments.map((s) => `${stamp(s.start)}–${stamp(s.end)}`).join("、") || "无区间";
}
function timeline(label, segments, duration, kind = "") {
  const row = node("div", undefined, "timeline-row");
  row.append(node("span", label));
  const bar = node("div", undefined, "timeline");
  for (const segment of segments) {
    const block = node("span", undefined, `interval ${kind}`);
    block.style.left = `${Math.max(0, (segment.start / duration) * 100)}%`;
    block.style.width = `${Math.min(100, ((segment.end - segment.start) / duration) * 100)}%`;
    block.title = `${stamp(segment.start)}–${stamp(segment.end)} ${segment.brand || ""}`;
    bar.append(block);
  }
  row.append(bar);
  return row;
}
function detail(title, text) {
  const d = node("details");
  d.append(node("summary", title), node("pre", text));
  return d;
}
function communitySegments(sample) {
  return (sample.community?.segments || [])
    .filter((s) => s.category === "sponsor" && s.actionType === "skip" && s.comparable)
    .map((s) => ({ start: s.segment[0], end: s.segment[1], brand: `社区 / 票数 ${s.votes}` }));
}
function segmentsTable(segments, video) {
  const table = node("table");
  const head = node("tr");
  for (const t of ["时间 / 原视频", "对象与理由", "评分"]) {
    head.append(node("th", t));
  }
  const thead = node("thead");
  thead.append(head);
  table.append(thead);
  const body = node("tbody");
  for (const s of segments) {
    const tr = node("tr");
    const time = node("td");
    time.append(link(video, `${stamp(s.start)} → ${stamp(s.end)}`, s.start));
    const reason = node("td");
    reason.append(node("strong", s.brand || ""), node("p", s.reason || ""));
    tr.append(time, reason, node("td", s.confidence === undefined ? "—" : String(s.confidence)));
    body.append(tr);
  }
  table.append(body);
  const wrap = node("div", undefined, "scroll-table");
  wrap.append(table);
  return wrap;
}
function renderCases() {
  const search = $("search").value.toLowerCase();
  const score = $("score-filter").value;
  const status = $("transcript-filter").value;
  const issue = $("issue-filter").value;
  const split = $("split-filter").value;
  const cohort = $("cohort-filter").value;
  const membership = $("membership-filter").value;
  const rows = state.cases.filter(
    (c) =>
      `${c.video.title} ${c.video.bvid}`.toLowerCase().includes(search) &&
      (cohort === "all" ||
        (cohort === "community" ? c.referenceCount > 0 : c.datasets?.includes(cohort))) &&
      (membership === "all" ||
        (membership === "removed" ? c.exclusion?.excluded : !c.exclusion?.excluded)) &&
      (score === "all" ||
        (score === "high" && c.segmentCount > c.belowThreshold) ||
        (score === "low" && c.belowThreshold > 0)) &&
      (status === "all" || c.transcriptStatus === status) &&
      (split === "all" || c.split === split) &&
      (issue === "all" ||
        (issue === "protected" && c.protected) ||
        (issue === "community" && c.referenceCount > 0) ||
        (issue === "gap" &&
          c.comparison &&
          (c.comparison.onlyFirstSeconds > 10 || c.comparison.onlySecondSeconds > 10)) ||
        (issue === "v5" && c.promptVersion === "ad-cues-v5-obvious") ||
        (issue === "reviewed" && c.reviewed)),
  );
  state.visible = rows;
  const pages = Math.ceil(rows.length / 20);
  state.samplePage = Math.min(state.samplePage, Math.max(0, pages - 1));
  $("sample-page").textContent = `${pages ? state.samplePage + 1 : 0} / ${pages}`;
  $("sample-prev").disabled = state.samplePage === 0;
  $("sample-next").disabled = state.samplePage + 1 >= pages;
  $("case-list").replaceChildren();
  for (const item of rows.slice(state.samplePage * 20, (state.samplePage + 1) * 20)) {
    const row = node(
      "div",
      undefined,
      `case-row${state.current?.sample.id === item.id ? " active" : ""}`,
    );
    const check = node("input");
    check.type = "checkbox";
    check.checked = state.selected.has(item.id);
    check.disabled = Boolean(item.exclusion?.excluded);
    check.setAttribute("aria-label", `选中${item.video.bvid}`);
    check.addEventListener("change", () => {
      if (check.checked) {
        if (state.selected.size >= 1000) {
          check.checked = false;
          toast("一次最多选择1000个样本。");
          return;
        }
        state.selected.add(item.id);
      } else {
        state.selected.delete(item.id);
      }
      $("selected-count").textContent = `已选 ${state.selected.size}`;
      updateCallCount();
    });
    const button = node("button");
    button.append(
      node("strong", item.video.title),
      node("small", `${item.video.bvid} · ${item.promptVersion} · ${item.split}`),
      node(
        "small",
        `${item.transcriptStatus} · ${item.hasBaseline ? `${item.segmentCount} 段 / ${(item.coverage * 100).toFixed(1)}%` : "模型待运行"} · 社区 ${item.referenceCount} 段${item.protected ? " · 50%保护" : ""}`,
      ),
    );
    button.addEventListener("click", () => selectCase(item.id).catch((e) => toast(e.message)));
    row.append(check, button);
    const action = node("button", item.exclusion?.excluded ? "恢复" : "移除", "membership-action");
    action.addEventListener("click", () => openExclusion(item));
    row.append(action);
    if (item.exclusion) {
      button.append(
        node(
          "small",
          `${item.exclusion.excluded ? "已移除" : "已恢复"}：${item.exclusion.reason} · ${item.exclusion.at}`,
        ),
      );
    }
    $("case-list").append(row);
  }
  if (!rows.length) {
    $("case-list").append(node("p", "当前筛选下没有样本。", "empty"));
  }
  $("selected-count").textContent = `已选 ${state.selected.size} / 显示 ${rows.length}`;
  updateCallCount();
}
async function selectCase(id) {
  const epoch = ++state.epoch;
  const value = await api(`/api/case/${id}`);
  if (epoch !== state.epoch) {
    return;
  }
  state.current = value;
  state.debugRun = null;
  state.detailEpoch++;
  $("outlier-detail").replaceChildren(node("p", "请选择下方实验结果，或运行新Prompt。", "empty"));
  $("sample-comparison").replaceChildren();
  setWorkspace("debug");
  renderCases();
  renderSample();
  await loadSampleRuns(id);
}
function renderSample() {
  const { sample, input } = state.current;
  const p = sample.baseline || {
    video: sample.video,
    segments: [],
    prompt_version: "待运行",
    labels: null,
  };
  const summary = state.cases.find((c) => c.id === sample.id) || { protected: false };
  $("debug-title").textContent = p.video.title;
  $("debug-context").textContent =
    `${$("cohort-filter").selectedOptions[0].textContent} / ${p.video.bvid} · 相同字幕下比较不同 Prompt`;
  const root = $("sample-panel");
  root.replaceChildren();
  const title = node("div", undefined, "title-row");
  title.append(node("h2", p.video.title), link(p.video, "打开原视频 ↗"));
  root.append(
    title,
    node(
      "p",
      `${p.video.bvid} · P${p.video.page} · CID ${p.video.cid} · ${stamp(p.video.duration)}`,
      "muted small",
    ),
  );
  const tags = node("div", undefined, "badges");
  tags.append(
    badge(`模型缓存 ${p.prompt_version}`),
    badge(
      `字幕 ${sample.transcript.status}`,
      sample.transcript.status === "exact" ? "exact" : "warning",
    ),
    badge(`社区 ${sample.community.status}`),
    badge(`${sample.split}`),
  );
  if (summary.protected) {
    tags.append(badge("50% 保护", "warning"));
  }
  root.append(tags);
  const membership = state.cases.find((c) => c.id === sample.id);
  if (membership) {
    const action = node(
      "button",
      membership.exclusion?.excluded ? "恢复到有效测试集" : "从有效测试集移除",
      "membership-action",
    );
    action.addEventListener("click", () => openExclusion(membership));
    root.append(action);
    if (membership.exclusion) {
      root.append(
        node(
          "p",
          `${membership.exclusion.excluded ? "移除" : "恢复"}原因：${membership.exclusion.reason} · ${membership.exclusion.at}`,
          "notice",
        ),
      );
    }
  }
  if (state.current.evaluation?.available) {
    const cards = node("div", undefined, "metric-cards");
    metricCards(cards, { meanIou: state.current.evaluation.iou, ...state.current.evaluation });
    root.append(cards);
  }
  root.append(
    timeline(sample.baseline ? "历史模型" : "模型待运行", p.segments, p.video.duration),
    timeline("社区 sponsor", communitySegments(sample), p.video.duration, "community"),
  );
  root.append(segmentsTable(p.segments, p.video));
  const reference = communitySegments(sample);
  root.append(
    node(
      "p",
      reference.length
        ? `社区 sponsor / skip：${ranges(reference)}`
        : "社区当前没有同CID且时长匹配的 sponsor/skip；此状态仅表示缺少可比标注。",
      "muted small",
    ),
  );
  if (summary.comparison) {
    root.append(node("pre", json({ 社区对照差异_非准确率: summary.comparison })));
  }
  root.append(
    detail("社区接口原始选取字段 / 类别 / 投票 / 时长校验", json(sample.community)),
    detail("历史模型输出字段 / 证据", json(p.labels)),
  );
  if (input) {
    root.append(
      detail(`完整模型输入（${sample.transcript.context.cues.length} 条字幕）`, input),
      detail(
        "带时间戳字幕",
        sample.transcript.context.cues
          .map((c) => `${c.id}|${stamp(c.from)} → ${stamp(c.to)}|${c.content}`)
          .join("\n"),
      ),
    );
  } else {
    root.append(
      node("p", "该记录只有广告标记，完整字幕待补齐。可从扩展缓存导出后导入。", "notice"),
    );
  }
  const importer = node("div", undefined, "import-row");
  const file = node("input");
  file.type = "file";
  file.accept = ".json";
  file.setAttribute("aria-label", "导入字幕JSON");
  const upload = node("button", "导入字幕JSON");
  upload.addEventListener("click", async () => {
    try {
      if (!file.files[0]) {
        throw new Error("请选择包含video与cues的JSON。");
      }
      const context = JSON.parse(await file.files[0].text());
      await api("/api/transcript", { id: sample.id, context });
      await refresh();
      await selectCase(sample.id);
    } catch (e) {
      toast(e.message);
    }
  });
  importer.append(file, upload);
  root.append(importer);
  const review = node("details", undefined, "review-form");
  review.append(node("summary", "保存人工复核参考（独立于历史模型 / 社区）"));
  const textarea = node("textarea");
  textarea.value = json(sample.review?.segments || []);
  textarea.setAttribute("aria-label", "人工广告区间JSON");
  const note = node("input");
  note.placeholder = "复核说明：依据字幕还是已观看原视频？";
  note.value = sample.review?.note || "";
  const save = node("button", "确认人工区间并保存本地");
  save.addEventListener("click", async () => {
    try {
      const segments = JSON.parse(textarea.value);
      await api("/api/review", { id: sample.id, segments, note: note.value });
      toast("人工参考已保存到本地；生产缓存保持原样。");
      await refresh();
      await selectCase(sample.id);
    } catch (e) {
      toast(e.message);
    }
  });
  review.append(
    node("p", '格式：[{"start":10,"end":20}]。空数组表示人工确认零广告。', "muted small"),
    textarea,
    note,
    save,
  );
  root.append(review);
  $("run-current").disabled = !input || Boolean(membership?.exclusion?.excluded);
  updateCallCount();
}
async function loadSampleRuns(id) {
  const epoch = state.epoch;
  $("sample-run-status").textContent = "正在读取该样本的Prompt实验…";
  try {
    const result = await api(`/api/case-runs/${id}`);
    if (epoch !== state.epoch || state.current?.sample.id !== id) {
      return;
    }
    state.sampleRuns = result.runs;
    $("sample-run-status").textContent =
      `${result.runs.length} 个实验批次 · 原始请求与输出独立保留`;
    const root = $("sample-runs");
    root.replaceChildren();
    for (const run of result.runs) {
      const card = node("article", undefined, "sample-experiment");
      card.append(
        node("strong", run.name),
        node("small", `${run.startedAt} · Prompt ${run.promptSha256.slice(0, 12)}`),
      );
      const use = node("button", "载入此 Prompt");
      const protocol = run.experiment?.protocol || run.settings?.experimentalProtocol || "pipe";
      const experimental = Boolean(
        run.experiment?.pipeline ||
        run.experiment?.derived ||
        !["pipe", "partition-ad-only"].includes(protocol) ||
        run.settings?.thinking === "enabled",
      );
      use.disabled = experimental;
      if (experimental) {
        card.append(
          node(
            "p",
            "实验协议：请通过 prompt/experiments 中的对应运行器复现；下方可查看各阶段输入与输出。",
            "notice",
          ),
        );
        use.textContent = "专用实验运行器";
      }
      use.addEventListener("click", () => {
        $("prompt").value = run.prompt;
        $("output-protocol").value = protocol;
        $("run-name").value = `${run.name.slice(0, 70)}-debug`;
        $("prompt").focus();
      });
      card.append(use);
      for (const row of run.results) {
        const view = node(
          "button",
          `第${row.repeat}轮 · ${row.status} · IoU ${percent(row.evaluation?.iou)} · 查看结果`,
        );
        view.addEventListener("click", () =>
          showOutlier(row, run, false).catch((e) => toast(e.message)),
        );
        card.append(view);
      }
      root.append(card);
    }
    if (!result.runs.length) {
      root.append(
        node("p", "该样本暂无实验。可载入生产Prompt或草稿，点击“运行当前样本”。", "empty"),
      );
    }
    for (const select of ["debug-baseline", "debug-candidate"]) {
      const chosen = $(select).value;
      $(select).replaceChildren(
        new Option("选择实验", ""),
        ...result.runs.map((r) => new Option(`${r.name} · ${r.promptSha256.slice(0, 8)}`, r.id)),
      );
      if (result.runs.some((r) => r.id === chosen)) {
        $(select).value = chosen;
      }
    }
  } catch (error) {
    if (epoch === state.epoch) {
      $("sample-run-status").textContent = `实验记录读取失败：${error.message}`;
    }
  }
}
async function refresh() {
  const result = await api("/api/cases");
  state.cases = result.cases;
  state.datasets = result.datasets || [];
  state.datasetRevision = result.datasetRevision || "";
  for (const id of state.selected) {
    if (!state.cases.some((c) => c.id === id && belongs(c) && !c.exclusion?.excluded)) {
      state.selected.delete(id);
    }
  }
  renderDatasets();
  $("audit-summary").textContent = json(
    result.audit
      ? { counts: result.audit.counts, flags: result.audit.flags }
      : "运行 npm run lab:collect -- audit 可生成初筛",
  );
  renderCases();
}
async function refreshPrompts() {
  state.prompts = (await api("/api/prompts")).prompts;
  $("saved-prompts").replaceChildren(
    new Option("载入已保存草稿", ""),
    ...state.prompts.map((p) => new Option(p.name, p.id)),
  );
}
async function history() {
  const rows = (await api("/api/runs")).runs;
  state.runs = rows;
  const members = new Set(state.cases.filter(belongs).map((s) => s.id));
  const scoped = rows.filter((r) => !r.sampleIds || r.sampleIds.some((id) => members.has(id)));
  for (const id of ["run-history", "baseline-run", "candidate-run"]) {
    const selected = $(id).value;
    $(id).replaceChildren(
      new Option("选择批次", ""),
      ...scoped.map(
        (r) =>
          new Option(
            `${r.name || "历史批次"} · ${r.startedAt.slice(0, 19)} · ${r.status} · ${r.completed}/${r.plannedCalls}`,
            r.id,
          ),
      ),
    );
    if (scoped.some((r) => r.id === selected)) {
      $(id).value = selected;
    }
  }
}
const percent = (value) =>
  !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(value > 0 && value < 0.0001 ? 4 : 2)}%`;
const points = (value) =>
  !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(3)} 个百分点`;
function metricCards(root, metrics, before) {
  root.replaceChildren();
  for (const [key, title] of [
    ["meanIou", "平均 IoU ↑"],
    ["bodySkipRate", "正文误跳率 ↓"],
    ["adMissRate", "广告遗漏率 ↓"],
  ]) {
    const card = node("div", undefined, "metric-card");
    card.append(node("span", title), node("strong", percent(metrics?.[key])));
    if (before) {
      card.append(
        node(
          "small",
          `基线 ${percent(before[key])} · Δ ${points(!Number.isFinite(metrics?.[key]) || !Number.isFinite(before[key]) ? null : metrics[key] - before[key])}`,
        ),
      );
    }
    root.append(card);
  }
}
function updateCallCount() {
  const calls = state.selected.size * Number($("repeats").value);
  $("call-count").textContent =
    `${state.current ? `当前样本：${state.current.sample.video?.bvid || state.current.sample.baseline?.video.bvid}，单样本运行 ${$("repeats").value} 次。` : ""} 勾选 ${state.selected.size} 个样本 × ${$("repeats").value} 轮 = ${calls} 次批量调用。`;
  $("run-current").disabled =
    !state.current?.input ||
    Boolean(state.cases.find((c) => c.id === state.current?.sample.id)?.exclusion?.excluded);
  $("run-selected").disabled = state.selected.size === 0;
}
const OUTLIER_PAGE_SIZE = 10;
const resultKey = (row) => `${row.caseId}:${row.repeat}`;
const seconds = (value) => (Number.isFinite(value) ? `${value.toFixed(3)} 秒` : "—");
function resultSignals(row) {
  const signals = [];
  if (row.exclusion?.excluded) {
    signals.push("已从有效集移除");
  }
  if (row.status !== "done") {
    signals.push("执行 / 格式失败");
  } else {
    if (row.evaluation?.bodyPreserveOverlap > 0.001) {
      signals.push("正文保护违例");
    }
    if (row.evaluation?.protectedByCoverage) {
      signals.push("50%保护");
    }
    if (row.segments?.some((s) => s.confidence < 0.9)) {
      signals.push("低分过滤");
    }
    if (row.segments?.length === 0) {
      signals.push("模型零广告");
    }
    if (!row.evaluation?.available) {
      signals.push("缺少可计分参考");
    }
  }
  if (row.observation) {
    signals.push(row.observation.title);
  }
  return signals;
}
function renderOutliers() {
  const search = $("outlier-search").value.trim().toLowerCase();
  const filter = $("outlier-filter").value;
  const sort = $("outlier-sort").value;
  const eligible = (state.run?.results || []).filter((row) => !row.excludedFromDataset);
  const noted = eligible.filter((row) => row.observation).length;
  $("issue-count").textContent = String(noted);
  $("noted-count").textContent = String(noted);
  $("preserve-count").textContent = String(
    eligible.filter((row) => row.evaluation?.bodyPreserveOverlap > 0.001).length,
  );
  $("show-noted").setAttribute("aria-pressed", String(filter === "noted"));
  $("show-preserve").setAttribute("aria-pressed", String(filter === "preserve"));
  $("show-all-results").setAttribute("aria-pressed", String(filter === "all"));
  const rows = (state.run?.results || []).filter((row) => {
    const text =
      `${row.bvid} ${row.title} ${(row.segments || []).map((s) => s.brand).join(" ")}`.toLowerCase();
    return (
      text.includes(search) &&
      (filter === "removed" ? row.exclusion?.excluded : !row.excludedFromDataset) &&
      (filter === "all" ||
        filter === "removed" ||
        (filter === "noted" && row.observation) ||
        (filter === "preserve" && row.evaluation?.bodyPreserveOverlap > 0.001) ||
        (filter === "protected" && row.evaluation?.protectedByCoverage) ||
        (filter === "low" && row.segments?.some((s) => s.confidence < 0.9)) ||
        (filter === "none" && row.status === "done" && row.segments?.length === 0) ||
        (filter === "error" && row.status !== "done"))
    );
  });
  const field = {
    "body-seconds": "bodySkipSeconds",
    "body-rate": "bodySkipRate",
    "miss-seconds": "adMissSeconds",
    "miss-rate": "adMissRate",
    iou: "iou",
  }[sort];
  rows.sort((a, b) => {
    const x = a.evaluation?.[field];
    const y = b.evaluation?.[field];
    if (Number.isFinite(x) !== Number.isFinite(y)) {
      return Number.isFinite(x) ? -1 : 1;
    }
    return (
      (Number.isFinite(x) ? (sort === "iou" ? x - y : y - x) : 0) ||
      a.bvid.localeCompare(b.bvid) ||
      a.repeat - b.repeat
    );
  });
  const pages = Math.ceil(rows.length / OUTLIER_PAGE_SIZE);
  state.outlierPage = Math.min(state.outlierPage, Math.max(0, pages - 1));
  $("outlier-count").textContent = state.run
    ? `本批次 ${state.run.results.length} 条 · 当前筛选 ${rows.length} 条 · 每页 ${OUTLIER_PAGE_SIZE} 条`
    : "选择批次后展示";
  $("outlier-page").textContent = `${pages ? state.outlierPage + 1 : 0} / ${pages}`;
  $("outlier-prev").disabled = state.outlierPage === 0;
  $("outlier-next").disabled = state.outlierPage + 1 >= pages;
  const root = $("outlier-table");
  root.replaceChildren();
  if (!rows.length) {
    root.append(
      node(
        "p",
        state.run
          ? filter === "noted" && !noted
            ? "当前批次暂无原因标签，可点击“全部结果”查看区间差异。"
            : "当前筛选下没有结果。"
          : "请先选择运行批次。",
        "empty",
      ),
    );
    return;
  }
  const table = node("table");
  const head = node("tr");
  for (const title of [
    "视频 / 复核线索",
    "IoU",
    "正文误跳率 / 额外秒数",
    "广告遗漏率 / 遗漏秒数",
    "操作",
  ]) {
    head.append(node("th", title));
  }
  const thead = node("thead");
  thead.append(head);
  table.append(thead);
  const body = node("tbody");
  for (const row of rows.slice(
    state.outlierPage * OUTLIER_PAGE_SIZE,
    (state.outlierPage + 1) * OUTLIER_PAGE_SIZE,
  )) {
    const tr = node("tr", undefined, resultKey(row) === state.outlierKey ? "selected-result" : "");
    tr.dataset.bvid = row.bvid;
    const title = node("td");
    title.append(node("strong", row.title), node("small", `${row.bvid} · 第${row.repeat}次`));
    const signals = node("div", undefined, "badges");
    for (const text of resultSignals(row)) {
      signals.append(badge(text, "warning"));
    }
    title.append(signals);
    if (row.observation) {
      title.append(node("p", row.observation.text, "reason-summary"));
    }
    const bodyRate = node("td", percent(row.evaluation?.bodySkipRate));
    bodyRate.append(node("small", seconds(row.evaluation?.bodySkipSeconds)));
    const missRate = node("td", percent(row.evaluation?.adMissRate));
    missRate.append(node("small", seconds(row.evaluation?.adMissSeconds)));
    const action = node("td");
    const button = node("button", "调试 / 查看差异");
    button.addEventListener("click", () => showOutlier(row).catch((error) => toast(error.message)));
    action.append(button);
    const membership = state.cases.find((c) => c.id === (row.currentCaseId || row.caseId));
    if (membership) {
      const remove = node(
        "button",
        membership.exclusion?.excluded ? "恢复" : "移除",
        "membership-action",
      );
      remove.addEventListener("click", () => openExclusion(membership));
      action.append(remove);
    }
    tr.append(title, node("td", percent(row.evaluation?.iou)), bodyRate, missRate, action);
    body.append(tr);
  }
  table.append(body);
  root.append(table);
}
function subtractRanges(first, second) {
  const result = [];
  for (const a of first) {
    let pieces = [{ start: a.start, end: a.end }];
    for (const b of second) {
      pieces = pieces.flatMap((p) => {
        if (b.end <= p.start || b.start >= p.end) {
          return [p];
        }
        return [
          ...(b.start > p.start ? [{ start: p.start, end: b.start }] : []),
          ...(b.end < p.end ? [{ start: b.end, end: p.end }] : []),
        ];
      });
    }
    result.push(...pieces);
  }
  return result;
}
function rangeLinks(label, items, video) {
  const p = node("p", undefined, "range-links");
  p.append(node("strong", `${label}：`));
  if (!items.length) {
    p.append(node("span", "无区间"));
  }
  for (const s of items) {
    p.append(link(video, `${stamp(s.start)}–${stamp(s.end)}`, s.start));
  }
  return p;
}
async function showOutlier(row, sourceRun = state.run, loadHistory = true) {
  const runId = sourceRun.id;
  const epoch = ++state.detailEpoch;
  state.debugRun = sourceRun;
  setWorkspace("debug");
  state.outlierKey = resultKey(row);
  renderOutliers();
  const root = $("outlier-detail");
  root.replaceChildren();
  const video = row.video || row.baseline?.video;
  const reference =
    row.referenceSnapshot?.ranges ||
    (row.communityReference?.segments || [])
      .filter((s) => s.comparable && s.category === "sponsor" && s.actionType === "skip")
      .map((s) => ({ start: s.segment[0], end: s.segment[1] }));
  const effective = row.evaluation?.effective || [];
  const extra = subtractRanges(effective, reference);
  const missing = subtractRanges(reference, effective);
  const preserve = row.referenceSnapshot?.preserve || [];
  const title = node("div", undefined, "title-row");
  title.append(
    node("h3", row.title),
    link(video, "打开原视频 ↗", extra[0]?.start ?? missing[0]?.start ?? 0),
  );
  root.append(
    title,
    node(
      "p",
      `${row.bvid} · 第${row.repeat}次 · 本轮状态 ${row.status} · 批次 ${sourceRun.name || runId}`,
      "muted small",
    ),
  );
  const cards = node("div", undefined, "metric-cards");
  metricCards(cards, { ...row.evaluation, meanIou: row.evaluation?.iou });
  root.append(cards);
  const signals = resultSignals(row);
  if (signals.length) {
    root.append(node("p", signals.join(" · "), "notice"));
  }
  if (row.observation) {
    const note = node("div", undefined, "outlier-observation");
    note.append(
      node("strong", row.observation.title),
      node("p", row.observation.text),
      node("small", row.observation.basis),
    );
    root.append(note);
  }
  if (row.error) {
    root.append(node("p", row.error.message, "error"));
  }
  const membership = state.cases.find((c) => c.id === (row.currentCaseId || row.caseId));
  if (membership) {
    const action = node(
      "button",
      membership.exclusion?.excluded ? "恢复到有效测试集" : "移除该样本并填写原因",
      "membership-action",
    );
    action.addEventListener("click", () => openExclusion(membership));
    root.append(action);
    if (membership.exclusion) {
      root.append(
        node(
          "p",
          `最近资格变更：${membership.exclusion.reason} · ${membership.exclusion.at}`,
          "notice",
        ),
      );
    }
  }
  const referenceLabel = row.referenceSnapshot?.kind === "human" ? "人工参考" : "社区参考";
  root.append(
    timeline(referenceLabel, reference, video.duration, "community"),
    timeline("本轮原始标记", row.segments || [], video.duration, "current"),
    timeline("实际自动跳过", effective, video.duration, "human"),
    timeline("额外标记", extra, video.duration, "extra"),
    timeline("遗漏参考", missing, video.duration, "missing"),
    rangeLinks(referenceLabel, reference, video),
    rangeLinks("实际自动跳过", effective, video),
    rangeLinks("额外标记", extra, video),
    rangeLinks("遗漏参考", missing, video),
  );
  if (preserve.length) {
    root.append(rangeLinks("人工确认正文保护区", preserve, video));
  }
  root.append(node("h4", "本轮模型输出（含各片段评分）"), segmentsTable(row.segments || [], video));
  root.append(detail("本轮原始回复", row.rawOutput || "本轮尚未取得回复"));
  if (row.reasoningContent) {
    root.append(detail("本轮思考模式返回内容（reasoning_content）", row.reasoningContent));
  }
  if (row.stages?.length) {
    root.append(
      node(
        "p",
        "多阶段实验：完整实际请求与回复按阶段保存在下方，费用与复用来源见实验协议。",
        "notice",
      ),
    );
  } else {
    root.append(detail("本轮实际模型输入（请求快照）", json(row.request?.messages || [])));
  }
  if (sourceRun.experiment) {
    root.append(detail("实验协议与阶段来源", json(sourceRun.experiment)));
  }
  if (row.sourceRunId && row.sourceStages) {
    root.append(
      detail(
        "复用的上游输入与来源（本次新增费用单独统计）",
        json({
          sourceRunId: row.sourceRunId,
          sourceRepeat: row.sourceRepeat,
          originalCandidates: row.originalCandidates,
          sourceUsage: row.sourceUsage,
          sourceStages: row.sourceStages,
        }),
      ),
    );
  }
  if (row.explanation) {
    root.append(detail("模型分段与对象归属", json(row.explanation)));
  }
  if (row.probe) {
    root.append(detail("专项正文检查（按样本来源解释）", json(row.probe)));
  }
  if (row.repair) {
    root.append(detail("程序修剪与原始保护判定", json(row.repair)));
  }
  for (const [index, stage] of (row.stages || []).entries()) {
    root.append(
      detail(`第${index + 1}阶段 · ${stage.name || "局部分句复核"} · 实际请求与回复`, json(stage)),
    );
  }
  const subtitle = node("div", undefined, "outlier-subtitles");
  subtitle.append(node("p", "正在读取匹配本次输入指纹的字幕…", "muted"));
  root.append(subtitle);
  root.focus({ preventScroll: true });
  root.scrollIntoView({ block: "start", behavior: "smooth" });
  try {
    const value = await api(`/api/case/${row.currentCaseId || row.caseId}`);
    const { sample } = value;
    if (state.debugRun?.id !== runId || epoch !== state.detailEpoch) {
      return;
    }
    state.current = value;
    state.epoch++;
    if (sample.id) {
      renderSample();
      if (loadHistory) {
        loadSampleRuns(sample.id);
      }
    }
    const context = sample.transcript?.context;
    subtitle.replaceChildren();
    if (
      !context ||
      context.transcript_sha256 !== row.transcriptSha256 ||
      context.video.bvid !== video.bvid ||
      context.video.cid !== video.cid ||
      context.video.page !== video.page
    ) {
      subtitle.append(
        node("p", "当前样本字幕与本轮快照身份不同，请以上方实际模型输入为准。", "notice"),
      );
      return;
    }
    const diff = [...extra, ...missing, ...preserve];
    const near = context.cues.filter((c) =>
      diff.some((s) => c.to > s.start - 3 && c.from < s.end + 3),
    );
    subtitle.append(node("h4", `差异附近字幕 · ${near.length} 条`));
    if (near.length > 200) {
      subtitle.append(
        node("p", "先展示前200条附近字幕，完整带时间戳字幕可在下方展开。", "muted small"),
      );
    }
    if (!near.length) {
      subtitle.append(
        node("p", "当前样本没有差异附近的字幕，可展开下方完整字幕查看。", "muted small"),
      );
    }
    for (const cue of near.slice(0, 200)) {
      const p = node("p", undefined, "subtitle-line");
      const label = extra.some((s) => cue.to > s.start && cue.from < s.end)
        ? "额外标记"
        : missing.some((s) => cue.to > s.start && cue.from < s.end)
          ? "遗漏参考"
          : "上下文";
      p.append(
        badge(label),
        link(video, `${cue.id} · ${stamp(cue.from)}–${stamp(cue.to)}`, cue.from),
        node("span", cue.content),
      );
      subtitle.append(p);
    }
    subtitle.append(
      detail(
        `完整带时间戳字幕 · ${context.cues.length} 条`,
        context.cues
          .map((c) => `${c.id}|${stamp(c.from)} → ${stamp(c.to)}|${c.content}`)
          .join("\n"),
      ),
    );
  } catch (error) {
    if (state.debugRun?.id === runId && epoch === state.detailEpoch) {
      subtitle.replaceChildren(
        node("p", `字幕读取失败：${error.message}。本轮请求快照已在上方保留。`, "error"),
      );
    }
  }
}
function showRun(run) {
  if (state.run?.id !== run.id) {
    state.outlierPage = 0;
    state.outlierKey = null;
  }
  state.run = run;
  $("run-history").value = run.id;
  $("run-status").textContent =
    `${run.status} · ${run.results.length}/${run.plannedCalls} 次 · 可计分 ${run.metrics?.scored || 0} · 失败 ${run.metrics?.failed || 0} · Prompt ${run.promptSha256.slice(0, 12)} · 按参考标注估算`;
  if (run.datasetView) {
    $("run-status").textContent +=
      ` · ${run.datasetView.original ? "原始运行名单" : "当前有效名单"} · 此批覆盖 ${run.datasetView.coveredInputs}/${run.datasetView.original ? run.datasetView.total : run.datasetView.active} 份输入 · 本批已移除 ${run.datasetView.removedResults} 条 · 批次缺失 ${run.datasetView.missing} 条`;
  }
  metricCards($("run-metrics"), run.metrics);
  renderOutliers();
  const root = $("run-results");
  root.replaceChildren();
  if (run.results.length > 20) {
    root.append(
      node("p", "展示最近20条详细输出；本批次全部结果可通过上方差异列表筛选查看。", "notice"),
    );
  }
  for (const row of run.results.slice(-20)) {
    const card = node("article", undefined, "run-result");
    card.append(node("h3", `${row.title} · 第${row.repeat}次`));
    const metrics = node("div", undefined, "metrics");
    metrics.append(
      node("span", `${row.status} · ${row.transcriptStatus} · ${row.elapsedMs ?? "—"}ms`),
    );
    if (row.usage) {
      metrics.append(
        node("span", `输入 ${row.usage.promptTokens} / 输出 ${row.usage.outputTokens} tokens`),
        node("span", `价格快照估算 ¥${row.usage.offPeakCny}–${row.usage.peakCny}`),
      );
    }
    card.append(metrics);
    if (row.segments) {
      const video = row.video || row.baseline?.video;
      card.append(
        timeline("历史模型", row.baseline?.segments || [], video.duration),
        timeline("本轮输出", row.segments, video.duration, "current"),
        timeline("实际自动跳过", row.evaluation?.effective || [], video.duration, "human"),
      );
      const community = (row.communityReference?.segments || [])
        .filter((s) => s.comparable && s.category === "sponsor" && s.actionType === "skip")
        .map((s) => ({ start: s.segment[0], end: s.segment[1] }));
      card.append(
        timeline("社区 sponsor", community, video.duration, "community"),
        segmentsTable(row.segments, video),
      );
    }
    if (row.error) {
      card.append(node("p", row.error.message, "error"));
    }
    card.append(
      detail("原始模型输出", row.rawOutput || "未取得输出"),
      detail(
        "对照指标（时间并集差异）",
        json({
          baseline: row.comparisonToBaseline,
          community: row.comparisonToCommunity,
          human: row.comparisonToHuman,
          humanBodyOverlap: row.humanBodyOverlap,
          evaluation: row.evaluation,
        }),
      ),
      detail("本轮实际请求与API用量", json({ request: row.request, apiUsage: row.apiUsage })),
    );
    root.append(card);
  }
  $("cancel-run").disabled = run.status !== "running";
}
async function pollRun(id) {
  clearTimeout(state.poll);
  const epoch = ++state.runEpoch;
  const run = await api(`/api/run/${id}?${datasetQuery()}`);
  if (epoch !== state.runEpoch) {
    return;
  }
  showRun(run);
  const url = new URL(location.href);
  url.searchParams.set("run", id);
  url.searchParams.set("dataset", datasetId());
  globalThis.history.replaceState(null, "", url);
  if (run.status === "running") {
    state.poll = setTimeout(() => pollRun(id).catch((e) => toast(e.message)), 700);
  } else {
    await history();
    if (state.current?.sample.id) {
      await loadSampleRuns(state.current.sample.id);
    }
  }
}
async function startRun(ids) {
  if (!ids.length) {
    throw new Error("先选择一个或多个样本。");
  }
  const repeats = Number($("repeats").value);
  const calls = ids.length * repeats;
  if (calls > 3000) {
    throw new Error("单批最多3000次API调用。");
  }
  if (calls > 20 && Number($("confirmed-calls").value) !== calls) {
    throw new Error(`请在大批次计费确认框中输入 ${calls}。`);
  }
  if (!$("consent").checked) {
    throw new Error("请勾选字幕发送和计费确认。");
  }
  const run = await api("/api/run", {
    ids,
    repeats,
    prompt: $("prompt").value,
    protocol: $("output-protocol").value,
    allowAlternate: $("allow-alternate").checked,
    consent: true,
    apiKey: $("key").value,
    name: $("run-name").value,
    concurrency: Number($("concurrency").value),
    confirmedCalls: Number($("confirmed-calls").value),
    dataset: datasetId(),
    datasetRevision: state.datasetRevision,
  });
  $("key").value = "";
  $("consent").checked = false;
  $("confirmed-calls").value = "";
  await pollRun(run.id);
  toast(`已开始 ${ids.length * repeats} 次受控调用。`);
}
async function recalculate() {
  await refresh();
  await history();
  if (state.run) {
    await pollRun(state.run.id);
  }
}
async function changeDataset(id) {
  $("cohort-filter").value = id;
  state.runEpoch++;
  state.detailEpoch++;
  state.epoch++;
  state.current = null;
  state.debugRun = null;
  state.selected.clear();
  state.samplePage = 0;
  state.outlierPage = 0;
  state.sampleRuns = [];
  $("sample-runs").replaceChildren();
  $("sample-panel").replaceChildren(node("p", "请选择测试集样本", "empty"));
  $("outlier-detail").replaceChildren(node("p", "请选择该测试集中的样本或结果", "empty"));
  $("sample-comparison").replaceChildren();
  $("comparison-results").replaceChildren();
  $("comparison-metrics").replaceChildren();
  $("comparison-status").textContent = "选择两个批次，按当前测试集比较";
  $("debug-title").textContent = "从测试集中选择样本";
  renderDatasets();
  renderCases();
  setWorkspace("overview");
  await history();
  const preferred = state.runs
    .filter((r) =>
      (r.sampleIds || []).some((sampleId) =>
        state.cases.some((c) => c.id === sampleId && belongs(c)),
      ),
    )
    .sort((a, b) => b.completed - a.completed)[0];
  if (preferred) {
    await pollRun(preferred.id);
  } else {
    state.run = null;
    $("run-status").textContent = "当前测试集暂无运行批次";
    metricCards($("run-metrics"), null);
    $("run-results").replaceChildren();
    renderOutliers();
  }
}
function openExclusion(item) {
  state.exclusionTarget = {
    id: item.id,
    excluded: !item.exclusion?.excluded,
    revision: state.datasetRevision,
  };
  $("exclusion-title").textContent = item.exclusion?.excluded
    ? "恢复到有效测试集"
    : "从有效测试集移除";
  $("exclusion-target").textContent = `${item.video.title} · ${item.video.bvid}`;
  $("exclusion-reason").value = "";
  $("exclusion-error").textContent = "";
  $("confirm-exclusion").textContent = item.exclusion?.excluded ? "确认恢复" : "确认移除";
  $("exclusion-dialog").showModal();
}
$("exclusion-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const reason = $("exclusion-reason").value.trim();
  if (!reason) {
    $("exclusion-error").textContent = "请填写具体原因。";
    return;
  }
  $("confirm-exclusion").disabled = true;
  try {
    const result = await api("/api/exclusion", { ...state.exclusionTarget, reason });
    state.datasetRevision = result.datasetRevision;
    $("exclusion-dialog").close();
    await recalculate();
    if (state.current) {
      renderSample();
    }
    if (state.debugRun && state.outlierKey && state.workspace === "debug") {
      const run = await api(`/api/run/${state.debugRun.id}?${datasetQuery()}`);
      const row = run.results.find((r) => resultKey(r) === state.outlierKey);
      if (row && state.workspace === "debug") {
        await showOutlier(row, run);
      }
    }
    $("comparison-status").textContent = "有效名单已更新，请重新比较两个批次。";
    $("comparison-results").replaceChildren();
    $("comparison-metrics").replaceChildren();
    $("sample-comparison").replaceChildren();
    toast(
      result.exclusion.excluded
        ? "已从有效测试集移除，原因已保存，指标已本地重算。"
        : "已恢复到有效测试集，指标已本地重算。",
    );
  } catch (error) {
    $("exclusion-error").textContent = error.message;
    toast(error.message);
  } finally {
    $("confirm-exclusion").disabled = false;
  }
});
$("cancel-exclusion").addEventListener("click", () => $("exclusion-dialog").close());
for (const tab of ["overview", "issues", "samples", "compare", "debug"]) {
  $(`tab-${tab}`).addEventListener("click", () => setWorkspace(tab));
}
$("back-to-dataset").addEventListener("click", () => setWorkspace(state.resultsWorkspace));
for (const [id, filter] of [
  ["show-noted", "noted"],
  ["show-preserve", "preserve"],
  ["show-all-results", "all"],
]) {
  $(id).addEventListener("click", () => {
    $("outlier-filter").value = filter;
    $("outlier-search").value = "";
    state.outlierPage = 0;
    $("outlier-heading").textContent =
      filter === "noted" ? "带原因标签的样本" : filter === "preserve" ? "正文保护违例" : "全部结果";
    renderOutliers();
  });
}
$("cohort-filter").addEventListener("change", () =>
  changeDataset(datasetId()).catch((e) => toast(e.message)),
);
$("metric-view").addEventListener("change", () => recalculate().catch((e) => toast(e.message)));
$("recalculate").addEventListener("click", () => recalculate().catch((e) => toast(e.message)));
function prepareBatch(ids) {
  state.selected = new Set(ids);
  state.current = null;
  state.debugRun = null;
  state.detailEpoch++;
  state.epoch++;
  $("debug-title").textContent = `运行测试集 · ${ids.length} 个有效样本`;
  $("debug-context").textContent = "配置Prompt并核对调用数，然后运行勾选样本。";
  $("sample-runs").replaceChildren();
  $("sample-run-status").textContent = "批量模式：结果保存为新测试批次。";
  $("outlier-detail").replaceChildren(
    node("p", "批量运行后，在测试集结果中选择具体样本进入调试。", "empty"),
  );
  $("sample-panel").replaceChildren();
  $("sample-comparison").replaceChildren();
  renderCases();
  setWorkspace("debug");
}
$("prepare-dataset-run").addEventListener("click", () =>
  prepareBatch(
    state.cases
      .filter((c) => belongs(c) && !c.exclusion?.excluded && c.transcriptStatus !== "missing")
      .map((c) => c.id),
  ),
);
$("debug-selected").addEventListener("click", () => prepareBatch([...state.selected]));
$("sample-prev").addEventListener("click", () => {
  state.samplePage = Math.max(0, state.samplePage - 1);
  renderCases();
});
$("sample-next").addEventListener("click", () => {
  state.samplePage++;
  renderCases();
});
$("compare-sample").addEventListener("click", async () => {
  try {
    if (!state.current) {
      throw new Error("请先从测试集中选择样本。");
    }
    const query = datasetQuery();
    query.set("baseline", $("debug-baseline").value);
    query.set("candidate", $("debug-candidate").value);
    query.set("case", state.current.sample.id);
    const comparison = await api(`/api/compare?${query}`);
    const root = $("sample-comparison");
    const cards = node("div", undefined, "metric-cards");
    metricCards(cards, comparison.after, comparison.before);
    root.replaceChildren(
      node(
        "p",
        `样本对比：${comparison.verdict} · 配对 ${comparison.paired} · 未配对 ${comparison.excluded.length}`,
        "notice",
      ),
      cards,
      detail("原始对比数据", json(comparison)),
    );
  } catch (error) {
    toast(error.message);
  }
});
for (const id of [
  "search",
  "membership-filter",
  "score-filter",
  "transcript-filter",
  "issue-filter",
  "split-filter",
]) {
  $(id).addEventListener(id === "search" ? "input" : "change", () => {
    state.samplePage = 0;
    renderCases();
  });
}
$("repeats").addEventListener("change", updateCallCount);
for (const id of ["outlier-search", "outlier-filter", "outlier-sort"]) {
  $(id).addEventListener(id === "outlier-search" ? "input" : "change", () => {
    state.outlierPage = 0;
    renderOutliers();
  });
}
$("outlier-prev").addEventListener("click", () => {
  state.outlierPage = Math.max(0, state.outlierPage - 1);
  renderOutliers();
});
$("outlier-next").addEventListener("click", () => {
  state.outlierPage++;
  renderOutliers();
});
$("select-visible").addEventListener("click", () => {
  for (const item of state.visible) {
    if (state.selected.size >= 1000) {
      break;
    }
    if (item.transcriptStatus !== "missing" && !item.exclusion?.excluded) {
      state.selected.add(item.id);
    }
  }
  renderCases();
});
$("clear-selected").addEventListener("click", () => {
  state.selected.clear();
  renderCases();
});
$("compare-runs").addEventListener("click", async () => {
  try {
    const query = new URLSearchParams({
      baseline: $("baseline-run").value,
      candidate: $("candidate-run").value,
      dataset: datasetId(),
      view: $("metric-view").value,
      ...($("compare-configurations").checked ? { configuration: "1" } : {}),
    });
    const comparison = await api(`/api/compare?${query}`);
    const names = {
      incomplete: "配对或执行尚未完整",
      blocked: "硬回归：需要修复",
      review: "指标退步：需要复核",
      pass: "指标通过（参考标注口径）",
      unscored: "缺少可计分参考",
    };
    $("comparison-status").textContent =
      `${names[comparison.verdict]} · 配对 ${comparison.paired} · 排除 ${comparison.excluded.length} · 退步 ${comparison.regressions} · 硬回归 ${comparison.hardRegressions} · 正文保护违例 ${comparison.after.preserveViolations + comparison.after.zeroAdFalseSkips}`;
    metricCards($("comparison-metrics"), comparison.after, comparison.before);
    const root = $("comparison-results");
    root.replaceChildren(
      detail(
        "样本覆盖、未配对原因与汇总秒数",
        json({ excluded: comparison.excluded, before: comparison.before, after: comparison.after }),
      ),
    );
    if (comparison.kind === "configuration-comparison") {
      root.prepend(
        node(
          "p",
          "当前为方案对照：输出协议与预算差异已显式保留，指标按双方有效输出配对。失败按空跳过的同名单补充口径可在下方展开。",
          "notice",
        ),
      );
      root.append(
        detail(
          "两组真实配置与失败按空跳过的补充指标",
          json({ settings: comparison.settings, operational: comparison.operational }),
        ),
      );
    }
    const table = node("table");
    const head = node("tr");
    for (const title of ["视频 / 轮次", "IoU 变化", "正文误跳率变化", "广告遗漏率变化", "状态"]) {
      head.append(node("th", title));
    }
    const thead = node("thead");
    thead.append(head);
    table.append(thead);
    const body = node("tbody");
    for (const row of comparison.rows) {
      const tr = node("tr", undefined, row.regression ? "regression" : "");
      const title = node("td");
      const button = node("button", `${row.title} · 第${row.repeat}次`);
      button.addEventListener("click", () => selectCase(row.caseId).catch((e) => toast(e.message)));
      title.append(button, node("small", row.bvid));
      tr.append(
        title,
        node("td", points(row.iouDelta)),
        node("td", points(row.bodySkipRateDelta)),
        node("td", points(row.adMissRateDelta)),
        node("td", row.hardRegression ? "硬回归" : row.regression ? "需复核" : "—"),
      );
      body.append(tr);
    }
    table.append(body);
    const wrap = node("div", undefined, "scroll-table");
    wrap.append(table);
    root.append(wrap);
  } catch (error) {
    toast(error.message);
  }
});
$("refresh").addEventListener("click", () => recalculate().catch((e) => toast(e.message)));
$("reset-prompt").addEventListener("click", () => {
  $("prompt").value = state.productionPrompt;
  $("output-protocol").value = state.productionProtocol;
});
$("save-prompt").addEventListener("click", async () => {
  try {
    await api("/api/prompt", { name: $("prompt-name").value, prompt: $("prompt").value });
    await refreshPrompts();
    toast("Prompt草稿已保存在本地。");
  } catch (e) {
    toast(e.message);
  }
});
$("saved-prompts").addEventListener("change", () => {
  const item = state.prompts.find((p) => p.id === $("saved-prompts").value);
  if (item) {
    $("prompt").value = item.prompt;
    $("prompt-name").value = item.name;
  }
});
$("run-current").addEventListener("click", () =>
  startRun(state.current ? [state.current.sample.id] : []).catch((e) => toast(e.message)),
);
$("run-selected").addEventListener("click", () =>
  startRun([...state.selected]).catch((e) => toast(e.message)),
);
$("cancel-run").addEventListener("click", () =>
  api("/api/cancel", { id: state.run?.id })
    .then(() => toast("已请求停止，已发出请求可能计费。"))
    .catch((e) => toast(e.message)),
);
$("run-history").addEventListener("change", () => {
  if ($("run-history").value) {
    pollRun($("run-history").value).catch((e) => toast(e.message));
  }
});
try {
  const requestedWorkspace = new URL(location.href).searchParams.get("workspace");
  const boot = await api("/api/bootstrap");
  state.csrf = boot.csrf;
  state.productionPrompt = boot.productionPrompt;
  state.productionProtocol = boot.productionProtocol || "pipe";
  $("output-protocol").value = state.productionProtocol;
  $("prompt").value = boot.productionPrompt;
  $("key-status").textContent = boot.hasEnvironmentKey
    ? "（已配置进程环境Key）"
    : "（当前进程尚未配置）";
  await Promise.all([refresh(), refreshPrompts(), history()]);
  const requestedSet = new URL(location.href).searchParams.get("dataset");
  if (requestedSet && [...$("cohort-filter").options].some((o) => o.value === requestedSet)) {
    $("cohort-filter").value = requestedSet;
  } else if (state.datasets.length) {
    $("cohort-filter").value = "community";
  }
  renderDatasets();
  renderCases();
  setWorkspace("overview");
  if (boot.activeRun) {
    await pollRun(boot.activeRun);
  } else {
    const requestedRun = new URL(location.href).searchParams.get("run");
    if (requestedRun && /^[a-f0-9-]{36}$/.test(requestedRun)) {
      await pollRun(requestedRun);
    } else if (state.datasets.length) {
      await changeDataset(datasetId());
    }
  }
  if (requestedWorkspace === "issues") {
    setWorkspace("issues");
  }
} catch (e) {
  toast(e.message);
}
