globalThis.BiliSkipPopup = function mountPopup({ root, background, command, openOptions }) {
  const $ = (id) => root.getElementById(id);
  const P = globalThis.BiliSkipPlayer;
  const actionNames = ["analyze", "refresh", "online", "toggle", "skip", "undo", "upload"];
  let active;
  let current;
  let sending = false;
  let polling = false;
  let epoch = 0;
  let recordRendered = "";
  let problem = "";
  let disposed = false;

  async function page(action, index) {
    let result;
    try {
      result = await command(active.tabId, {
        type: "BILISKIP_CONTROL",
        action,
        route: current?.video?.route,
        recordToken: current?.recordToken || "",
        index,
      });
    } catch {
      throw new Error("请刷新 B站视频页，让播放器控制器加载后重试。");
    }
    if (!result?.ok) {
      throw new Error(result?.error?.message || "请重新加载扩展，再刷新 B站视频页。");
    }
    return result.data;
  }
  function renderRecords() {
    const token = current?.recordToken || "none";
    if (token === recordRendered) {
      return;
    }
    recordRendered = token;
    $("segments").replaceChildren();
    $("meter").replaceChildren();
    const record = current?.record;
    $("summary").textContent = record ? `查看 ${record.segments.length} 个广告标记` : "广告标记";
    if (!record) {
      return;
    }
    for (const [index, segment] of record.segments.entries()) {
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.style.left = `${(segment.start / record.video.duration) * 100}%`;
      mark.style.width = `${((segment.end - segment.start) / record.video.duration) * 100}%`;
      mark.title = `${segment.brand} ${P.stamp(segment.start)}–${P.stamp(segment.end)}`;
      $("meter").append(mark);
      const row = document.createElement("article");
      row.className = "segment";
      const title = document.createElement("strong");
      title.textContent = `${P.stamp(segment.start)}–${P.stamp(segment.end)} · ${segment.brand} · ${segment.confidence.toFixed(2)}`;
      const reason = document.createElement("p");
      reason.className = "reason";
      reason.textContent = segment.reason;
      const actions = document.createElement("div");
      actions.className = "actions";
      for (const [action, label] of [
        ["preview", `试听第 ${index + 1} 段边界`],
        ["jump", `跳至第 ${index + 1} 段结束`],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.dataset.segmentAction = action;
        button.addEventListener("click", (event) => {
          if (event.isTrusted) {
            run(action, index);
          }
        });
        actions.append(button);
      }
      row.append(title, reason, actions);
      $("segments").append(row);
    }
    if (!record.segments.length) {
      $("segments").textContent = "本轮识别为 0 段广告。";
    }
  }
  function render() {
    if (disposed) {
      return;
    }
    const settings = current?.settings || active?.settings || {};
    const record = current?.record;
    const busy = sending || current?.busy;
    const available = Boolean(current?.video);
    $("video-title").textContent =
      record?.video.title || current?.videoTitle || active?.video?.bvid || "请打开 B站标准视频页";
    $("source").textContent = record
      ? P.sourceLabel(record.source)
      : current?.analyzing
        ? "分析中"
        : "本地优先";
    $("status").textContent =
      problem ||
      (!current?.busy && current?.warning) ||
      current?.message ||
      (active?.video ? "正在连接视频页…" : "打开 B站视频后，点击工具栏的 BiliSkip 图标即可操作。");
    $("status").classList.toggle("error", Boolean(problem) || current?.stage === "error");
    for (const name of actionNames) {
      $(name).disabled = !available || busy;
    }
    $("analyze").textContent =
      !settings.hasKey || !settings.consent
        ? "设置 Key 与授权"
        : record
          ? "重新分析（再次计费）"
          : "分析当前视频";
    $("online").disabled = !available || busy || !settings.sharedRead;
    $("toggle").textContent = settings.autoSkip ? "自动跳过：开" : "开启自动跳过";
    $("skip").disabled = busy || !current?.player?.canSkip;
    $("undo").disabled = busy || !current?.player?.canUndo;
    $("upload").hidden = !record || !settings.sharedUpload;
    renderRecords();
    for (const button of root.querySelectorAll("[data-segment-action]")) {
      button.disabled = busy || !current?.player?.ready;
    }
    const lines = [];
    if (current?.subtitleSource) {
      lines.push(P.subtitleLabel(current.subtitleSource));
    }
    if (record) {
      lines.push(
        `${record.cueCount} 句字幕 · ${record.model} · ${(record.elapsedMs / 1000).toFixed(2)} 秒`,
      );
      if (record.usage) {
        lines.push(
          `参考费用：空闲 ¥${record.usage.offPeakCny.toFixed(6)} / 高峰 ¥${record.usage.peakCny.toFixed(6)}（${record.usage.asOf}）`,
        );
      }
    }
    if (current?.metrics) {
      lines.push(
        `本视频近期记录：模型请求 ${current.metrics.apiCalls} 次 · 缓存命中 ${current.metrics.cacheHits} 次`,
      );
    }
    $("meta").textContent = lines.join("\n");
    $("upload-status").textContent =
      settings.sharedUpload && settings.autoUpload
        ? "新识别结果自动上传：开 · 可在设置中关闭"
        : "自动上传：关 · 可在设置中调整";
  }
  async function poll() {
    if (disposed || !active?.video || polling || sending) {
      return;
    }
    polling = true;
    const started = epoch;
    try {
      const result = await page("state");
      if (started === epoch) {
        current = result;
        problem = "";
      }
    } catch (error) {
      if (started === epoch) {
        current = null;
        problem = error.message;
      }
    } finally {
      polling = false;
      render();
    }
  }
  async function run(action, index) {
    if (disposed || !current?.video || sending) {
      return;
    }
    sending = true;
    epoch++;
    problem = "";
    render();
    try {
      current = await page(action, index);
    } catch (error) {
      problem = error.message;
    } finally {
      sending = false;
      render();
    }
  }
  for (const action of actionNames) {
    $(action).addEventListener("click", (event) => {
      if (event.isTrusted) {
        run(action);
      }
    });
  }
  $("options").addEventListener("click", (event) => {
    if (event.isTrusted) {
      openOptions();
    }
  });
  background({ type: "GET_ACTIVE" })
    .then(async (data) => {
      if (disposed) {
        return;
      }
      active = data;
      render();
      await poll();
    })
    .catch((error) => {
      problem = error.message;
      render();
    });
  // Both platforms stop UI polling when the panel closes; the controller stays alive.
  const interval = setInterval(poll, 500);
  return () => {
    disposed = true;
    epoch++;
    clearInterval(interval);
  };
};
