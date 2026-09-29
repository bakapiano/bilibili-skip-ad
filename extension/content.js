(() => {
  "use strict";
  if (globalThis.__biliskipV1) {
    globalThis.__biliskipV1.destroy();
  }
  const P = globalThis.BiliSkipPlayer;
  const timeline = new globalThis.BiliSkipTimeline();
  const abort = new AbortController();
  let ref = null;
  let generation = 0;
  let routeSince = 0;
  let video = null;
  let observedSource = "";
  let mediaRoute = null;
  let awaitMedia = false;
  let state = {};
  let settings = {
    autoSkip: false,
    autoAnalyze: false,
    confidenceThreshold: 0.9,
    hasKey: false,
    consent: false,
  };
  let loading = false;
  let analyzing = false;
  let stage = "loading";
  let message = "正在准备…";
  let lastSkip = null;
  const ignored = new Set();
  const completed = new Set();
  const autoAttempted = new Set();
  let seekIntent = null;
  let externalSeek = false;
  // A hidden diagnostic node preserves test/debug state; controls live in popup.html.
  const host = document.createElement("div");
  host.id = "biliskip-extension-root";
  host.hidden = true;
  document.body.append(host);
  let uploading = false;
  let displayedMessage = "";

  async function send(payload) {
    try {
      const response = await chrome.runtime.sendMessage(payload);
      if (!response?.ok) {
        const error = new Error(response?.error?.message || "扩展响应未完成，请刷新视频页。");
        error.code = response?.error?.code || "MESSAGE";
        throw error;
      }
      return response.data;
    } catch (error) {
      if (/context invalidated|Receiving end does not exist/i.test(error.message)) {
        throw new Error("扩展已更新，请刷新视频页面。", { cause: error });
      }
      throw error;
    }
  }
  function showError(error) {
    stage = "error";
    host.dataset.errorCode = error.code || "MESSAGE";
    message = error.message || "操作未完成，请重试。";
    render();
  }
  function valid() {
    return Boolean(
      ref &&
      P.parse(location.href)?.route === ref.route &&
      state.record &&
      video &&
      !awaitMedia &&
      video.readyState >= 1 &&
      Date.now() - routeSince > 600 &&
      P.matches(state.record, ref, video.duration),
    );
  }
  function currentSegment() {
    return valid() ? P.at(state.record.segments, video.currentTime, ignored) : null;
  }
  function seekTo(target, kind) {
    seekIntent = { video, target, kind, route: ref.route };
    externalSeek = false;
    video.currentTime = target;
  }
  function isOwnSeek() {
    return Boolean(
      seekIntent &&
      seekIntent.video === video &&
      seekIntent.route === ref?.route &&
      Math.abs(video.currentTime - seekIntent.target) <= 0.35,
    );
  }
  function seeking() {
    if (!isOwnSeek()) {
      seekIntent = null;
      externalSeek = true;
      ignored.clear();
      completed.clear();
      lastSkip = null;
    }
  }
  function seeked() {
    if (!video || video.seeking) {
      return;
    }
    const explicit = externalSeek || !isOwnSeek();
    seekIntent = null;
    externalSeek = false;
    if (explicit) {
      ignored.clear();
      completed.clear();
      lastSkip = null;
      host.dataset.lastAction = "seek";
      // An explicit timeline seek is also honored while the player is paused.
      const segment = currentSegment();
      if (
        segment &&
        settings.autoSkip &&
        P.automatic(state.record, segment, settings.confidenceThreshold)
      ) {
        jump(segment);
        return;
      }
    }
    render();
  }
  function jump(segment) {
    if (!valid() || video.seeking) {
      return;
    }
    const index = state.record.segments.indexOf(segment);
    lastSkip = {
      index,
      from: video.currentTime,
      to: Math.min(video.duration, segment.end + 0.05),
      route: ref.route,
    };
    completed.add(index);
    seekTo(lastSkip.to, "skip");
    host.dataset.lastJump = `${lastSkip.from.toFixed(3)}:${lastSkip.to.toFixed(3)}`;
    host.dataset.lastAction = "skip";
    render();
  }
  function undoSkip() {
    if (!valid() || !lastSkip || lastSkip.route !== ref.route || video.seeking) {
      return;
    }
    ignored.add(lastSkip.index);
    const target = lastSkip.from;
    lastSkip = null;
    seekTo(Math.max(0, target), "undo");
    host.dataset.lastAction = "undo";
    render();
  }
  async function toggleSkip() {
    if (!ref) {
      return;
    }
    const value = !settings.autoSkip;
    const previous = settings.autoSkip;
    settings.autoSkip = value;
    if (value) {
      ignored.clear();
      completed.clear();
      lastSkip = null;
    }
    render();
    try {
      settings = await send({ type: "SET_AUTO_SKIP", video: ref, enabled: value });
    } catch (error) {
      settings.autoSkip = previous;
      showError(error);
    }
    render();
  }
  function apply(result, epoch) {
    if (epoch !== generation) {
      return;
    }
    const changed =
      state.record?.key !== result.record?.key ||
      state.record?.createdAt !== result.record?.createdAt;
    state = result;
    settings = result.settings || settings;
    host.dataset.build = settings.buildVersion || "";
    host.dataset.errorCode = result.error?.code || "";
    stage = result.error ? "error" : result.record ? "ready" : "idle";
    message =
      result.error?.message ||
      result.warning ||
      result.notice ||
      (result.record
        ? `${result.record.segments.length} 个广告区间已就绪。`
        : `已读取 ${result.cueCount} 条字幕，等待分析。`);
    if (changed) {
      ignored.clear();
      completed.clear();
      lastSkip = null;
    }
    render();
    maybeAuto();
  }
  async function refresh(preferShared = false) {
    if (!ref || loading || analyzing) {
      return;
    }
    const epoch = generation;
    loading = true;
    stage = "loading";
    message = preferShared ? "正在读取字幕并查询线上缓存…" : "正在读取字幕并查询缓存…";
    render();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          apply(await send({ type: "GET_PAGE_STATE", video: ref, preferShared }), epoch);
          break;
        } catch (error) {
          if (error.code !== "SENDER" || attempt === 2) {
            throw error;
          }
          message = "正在跟随视频页面切换…";
          render();
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (epoch !== generation || abort.signal.aborted) {
            return;
          }
        }
      }
    } catch (error) {
      if (epoch === generation) {
        showError(error);
      }
    } finally {
      if (epoch === generation) {
        loading = false;
        render();
        maybeAuto();
      }
    }
  }
  async function analyze(force, automatic) {
    if (!ref || analyzing || loading) {
      return;
    }
    const epoch = generation;
    analyzing = true;
    stage = "model";
    message = "正在准备广告识别…";
    render();
    try {
      apply(await send({ type: "ANALYZE", video: ref, force, automatic }), epoch);
    } catch (error) {
      if (epoch === generation) {
        showError(error);
      }
    } finally {
      if (epoch === generation) {
        analyzing = false;
        render();
      }
    }
  }
  function maybeAuto() {
    if (
      !ref ||
      state.record ||
      !state.cueCount ||
      loading ||
      analyzing ||
      document.visibilityState !== "visible" ||
      !settings.autoAnalyze ||
      !settings.consent ||
      !settings.hasKey ||
      autoAttempted.has(ref.route)
    ) {
      return;
    }
    autoAttempted.add(ref.route);
    analyze(false, true);
  }
  async function upload() {
    if (!state.record || !ref || uploading) {
      return;
    }
    const epoch = generation;
    uploading = true;
    state.warning = "";
    message = "正在上传线上缓存…";
    render();
    try {
      const receipt = await send({ type: "UPLOAD", video: ref, key: state.record.key });
      if (epoch !== generation) {
        return;
      }
      message =
        receipt.status === "accepted"
          ? "已提交线上缓存，可点击「读取线上缓存」验证。"
          : "候选已提交，状态：" + receipt.status;
      host.dataset.errorCode = "";
      stage = "ready";
    } catch (error) {
      if (epoch === generation) {
        showError(error);
      }
    } finally {
      if (epoch === generation) {
        uploading = false;
        render();
      }
    }
  }
  function render() {
    const segment = currentSegment();
    if (
      segment &&
      settings.autoSkip &&
      valid() &&
      !video.paused &&
      !video.seeking &&
      !externalSeek &&
      !completed.has(state.record.segments.indexOf(segment)) &&
      P.automatic(state.record, segment, settings.confidenceThreshold)
    ) {
      jump(segment);
      return;
    }
    host.dataset.state = stage;
    host.dataset.cacheSource = state.record?.source || "";
    host.dataset.subtitleSource = state.subtitleSource || "";
    host.dataset.video = ref?.route || "";
    const playback = segment
      ? "当前广告：" + segment.brand + " · " + P.stamp(segment.start) + " → " + P.stamp(segment.end)
      : lastSkip
        ? "已跳过 " + (state.record?.segments[lastSkip.index]?.brand || "广告") + "，可撤销返回。"
        : "";
    displayedMessage =
      stage === "error" || loading || analyzing || uploading
        ? message
        : awaitMedia
          ? "等待新视频媒体就绪…"
          : playback || message;
    timeline.sync(valid() ? state.record : null, video);
    if (state.metrics) {
      host.dataset.apiCalls = String(state.metrics.apiCalls);
      host.dataset.cacheHits = String(state.metrics.cacheHits);
    } else {
      delete host.dataset.apiCalls;
      delete host.dataset.cacheHits;
    }
  }
  function snapshot() {
    const busy = loading || analyzing || uploading;
    return {
      ...state,
      video: ref,
      videoTitle: state.video?.title || "",
      settings,
      stage,
      message: displayedMessage,
      busy,
      analyzing,
      uploading,
      recordToken: state.record ? state.record.key + ":" + state.record.createdAt : "",
      player: {
        ready: valid() && !video.seeking,
        canSkip: Boolean(currentSegment() && !video?.seeking),
        canUndo: Boolean(lastSkip && valid() && !video.seeking),
        currentTime: video?.currentTime || 0,
        paused: video?.paused ?? true,
      },
    };
  }
  function control(data) {
    // Polling reads existing page state; only explicit refresh reloads subtitles.
    tick();
    if (data.action === "state") {
      return snapshot();
    }
    const fail = (code, text) => {
      throw Object.assign(new Error(text), { code });
    };
    if (!ref || data.route !== ref.route) {
      fail("SENDER", "视频已切换，请等待弹窗更新后重试。");
    }
    if (loading || analyzing || uploading) {
      fail("BUSY", "当前任务正在进行，请稍后操作。");
    }
    if (
      ["analyze", "skip", "undo", "preview", "jump", "upload"].includes(data.action) &&
      data.recordToken !== snapshot().recordToken
    ) {
      fail("CACHE", "广告标记已更新，请等待弹窗更新后重试。");
    }
    if (["skip", "undo", "preview", "jump"].includes(data.action) && (!valid() || video.seeking)) {
      fail("PLAYER", "请等待当前视频媒体就绪。");
    }
    switch (data.action) {
      case "analyze":
        if (!settings.hasKey || !settings.consent) {
          send({ type: "OPEN_OPTIONS" }).catch(showError);
        } else {
          analyze(Boolean(state.record), false);
        }
        break;
      case "refresh":
        refresh();
        break;
      case "online":
        if (!settings.sharedRead) {
          fail("SHARED_DISABLED", "请在设置中开启线上查询。");
        }
        refresh(true);
        break;
      case "toggle":
        toggleSkip();
        break;
      case "skip": {
        const segment = currentSegment();
        if (segment) {
          jump(segment);
        }
        break;
      }
      case "undo":
        undoSkip();
        break;
      case "preview":
      case "jump": {
        const index = data.index;
        if (!Number.isInteger(index) || index < 0 || !state.record.segments[index]) {
          fail("MESSAGE", "广告区间编号异常。");
        }
        if (data.action === "jump") {
          jump(state.record.segments[index]);
        } else {
          ignored.add(index);
          lastSkip = null;
          seekTo(Math.max(0, state.record.segments[index].start - 2), "preview");
          host.dataset.lastAction = "preview";
          render();
        }
        break;
      }
      case "upload":
        if (!settings.sharedUpload || !state.record) {
          fail("SHARED_DISABLED", "请开启共享上传并准备当前视频标记。");
        }
        upload();
        break;
      default:
        fail("MESSAGE", "播放器操作类型异常。");
    }
    return snapshot();
  }
  function mediaLoaded() {
    mediaRoute = P.parse(location.href)?.route || null;
    awaitMedia = Boolean(ref && mediaRoute !== ref.route);
    observedSource = video?.currentSrc || "";
    seekIntent = null;
    externalSeek = false;
    render();
  }
  function detachMedia() {
    if (!video) {
      return;
    }
    video.removeEventListener("timeupdate", render);
    video.removeEventListener("loadedmetadata", mediaLoaded);
    video.removeEventListener("seeking", seeking);
    video.removeEventListener("seeked", seeked);
  }
  function tick() {
    const next = P.parse(location.href);
    const candidate =
      Array.from(document.querySelectorAll("video"))
        .filter((element) => element.getBoundingClientRect().width > 100)
        .sort((a, b) => {
          const x = a.getBoundingClientRect();
          const y = b.getBoundingClientRect();
          return y.width * y.height - x.width * x.height;
        })[0] || null;
    if (next?.route !== ref?.route) {
      awaitMedia = Boolean(
        ref &&
        candidate &&
        candidate === video &&
        candidate.currentSrc === observedSource &&
        mediaRoute !== next?.route,
      );
      ref = next;
      generation++;
      routeSince = Date.now();
      state = {};
      lastSkip = null;
      seekIntent = null;
      externalSeek = false;
      timeline.clear();
      delete host.dataset.lastJump;
      delete host.dataset.lastAction;
      loading = false;
      analyzing = false;
      uploading = false;
      ignored.clear();
      completed.clear();
      stage = "loading";
      message = "正在准备当前视频…";
      if (ref) {
        refresh();
      }
    }
    if (candidate !== video) {
      detachMedia();
      video = candidate;
      observedSource = video?.currentSrc || "";
      awaitMedia = false;
      mediaRoute = video?.readyState >= 1 ? ref?.route || null : null;
      seekIntent = null;
      externalSeek = false;
      if (video) {
        video.addEventListener("timeupdate", render);
        video.addEventListener("loadedmetadata", mediaLoaded);
        video.addEventListener("seeking", seeking);
        video.addEventListener("seeked", seeked);
      }
    } else if (video && video.currentSrc !== observedSource) {
      observedSource = video.currentSrc;
      mediaRoute = ref?.route || null;
      awaitMedia = false;
    }
    if (ref) {
      render();
      maybeAuto();
    }
  }
  const onMessage = (data, sender, respond) => {
    if (sender.id !== chrome.runtime.id) {
      return;
    }
    if (data.type === "BILISKIP_PROGRESS" && data.route === ref?.route) {
      if (data.job?.status === "error") {
        stage = "error";
        message = data.job.message;
      } else if (loading || analyzing) {
        message = data.job?.message || data.message || message;
      }
      render();
    } else if (data.type === "BILISKIP_SETTINGS") {
      const wasAutomatic = settings.autoAnalyze;
      const wasSkip = settings.autoSkip;
      settings = data.settings;
      if (!wasSkip && settings.autoSkip) {
        ignored.clear();
        completed.clear();
        lastSkip = null;
      }
      if (!wasAutomatic && settings.autoAnalyze && ref) {
        autoAttempted.delete(ref.route);
      }
      render();
      maybeAuto();
    } else if (data.type === "BILISKIP_CONTROL") {
      if (sender.url !== chrome.runtime.getURL("popup.html")) {
        respond({ ok: false, error: { code: "SENDER", message: "操作来源应为扩展弹窗。" } });
        return;
      }
      try {
        respond({ ok: true, data: control(data) });
      } catch (error) {
        respond({ ok: false, error: { code: error.code || "MESSAGE", message: error.message } });
      }
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener("visibilitychange", maybeAuto, { signal: abort.signal });
  const interval = setInterval(tick, 400);
  globalThis.__biliskipV1 = {
    destroy() {
      clearInterval(interval);
      abort.abort();
      chrome.runtime.onMessage.removeListener(onMessage);
      detachMedia();
      timeline.clear();
      host.remove();
    },
  };
  tick();
})();
