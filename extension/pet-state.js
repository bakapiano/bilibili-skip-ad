// Presentation only: a completion is billable here only after observing its live job.
globalThis.BiliSkipPetState = function createPetState() {
  let route = "";
  let activityId;
  let lastSkipId;
  let skipCard = null;
  let wasBusy = false;
  const liveJobs = new Set();
  function usageValues(usage) {
    return usage && Number.isFinite(usage.costCny) && usage.costCny >= 0
      ? { cost: usage.costCny.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") }
      : null;
  }
  return (state) => {
    const taskStarted = Boolean(state.busy) && !wasBusy;
    wasBusy = Boolean(state.busy);
    const next = state.video?.route || "";
    if (next !== route || state.activityId !== activityId) {
      route = next;
      activityId = state.activityId;
      liveJobs.clear();
      // Mounting, refreshing or changing videos starts from the current playback state.
      lastSkipId = state.player?.lastSkip?.id;
      skipCard = null;
    }
    const card = (scene, key = scene, values = {}, mood = "idle", persistent = false) => ({
      key: `${route}:${activityId ?? ""}:${key}`,
      scene,
      values,
      mood,
      persistent,
      visible: Boolean(route),
    });
    const display = (value) => {
      const defaults = globalThis.BiliSkipPetAssets.dialogues[value.scene];
      const custom = state.settings?.petDialogues?.[value.scene] || {};
      const title = (custom.title ?? defaults.title).replace(
        /\{(seconds|cost)\}/g,
        (_, token) => value.values[token] ?? "",
      );
      return { ...value, title };
    };
    const job = state.job;
    if (job?.id && job.status === "running") {
      liveJobs.add(job.id);
      if (liveJobs.size > 50) {
        liveJobs.delete(liveJobs.values().next().value);
      }
    }
    const skip = state.player?.lastSkip;
    const newSkip = skip?.id !== lastSkipId;
    if (newSkip) {
      lastSkipId = skip?.id;
      skipCard = null;
      if (
        skip?.automatic === true &&
        skip.route === route &&
        Number.isSafeInteger(skip.id) &&
        skip.id > 0 &&
        Number.isFinite(skip.seconds) &&
        skip.seconds > 0
      ) {
        const seconds = Math.max(0.1, skip.seconds).toFixed(1).replace(/\.0$/, "");
        skipCard = card("skip", `skip:${skip.id}`, { seconds }, "done");
      }
    }
    if (
      !skip ||
      state.exempt ||
      state.stage === "error" ||
      // Cache application can skip before the same task's finally block clears busy.
      (taskStarted && !newSkip)
    ) {
      skipCard = null;
    }
    if (skipCard) {
      return display(skipCard);
    }
    if (state.stage === "error" || (job?.status === "error" && liveJobs.has(job.id))) {
      return display(card("error", `error:${job?.id || state.message}`, {}, "error"));
    }
    if (job?.id && liveJobs.has(job.id) && job.status === "done" && job.stage === "done") {
      const values = usageValues(job.usage);
      return display(card(values ? "done" : "doneUnknown", `done:${job.id}`, values || {}, "done"));
    }
    if (state.busy) {
      const stage = job?.status === "running" ? job.stage : state.stage;
      const isAsr = String(stage).startsWith("asr") || /转写|音频/.test(state.message || "");
      return display(
        card(
          isAsr ? "asr" : state.analyzing ? "analyzing" : "loading",
          `busy:${stage}`,
          {},
          "working",
          true,
        ),
      );
    }
    if (state.exempt) {
      return display(card("exempt"));
    }
    if (state.record && ["local-cache", "shared"].includes(state.record.source)) {
      return {
        ...card("cache", `cache:${state.record.key}:${state.record.source}`, {}, "done"),
        title: "",
      };
    }
    if (state.record) {
      return display(card("record", `record:${state.record.key}`));
    }
    return display(card("idle"));
  };
};
