(() => {
  "use strict";
  if (globalThis.__biliskipV1) globalThis.__biliskipV1.destroy();
  const P = globalThis.BiliSkipPlayer;
  const timeline = new globalThis.BiliSkipTimeline();
  const abort = new AbortController();
  let ref = null, generation = 0, routeSince = 0, video = null, observedSource = "", mediaRoute = null, awaitMedia = false;
  let state = {}, settings = { autoSkip: false, autoAnalyze: false, confidenceThreshold: 0.9, hasKey: false, consent: false };
  let loading = false, analyzing = false, stage = "loading", message = "正在准备…", lastSkip = null, recordRendered = "";
  const ignored = new Set(), completed = new Set(), autoAttempted = new Set();
  let seekIntent = null, externalSeek = false;
  const host = document.createElement("div");
  host.id = "biliskip-extension-root";
  host.style.cssText = "position:fixed;right:18px;bottom:64px;z-index:2147483600;display:none;max-width:calc(100vw - 24px)";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host{all:initial;color-scheme:dark}*{box-sizing:border-box}.panel{width:326px;max-width:calc(100vw - 24px);color:#ecf2ff;background:#111b2bef;border:1px solid #40516b;border-radius:14px;box-shadow:0 12px 40px #0005;font:13px/1.55 system-ui,sans-serif;overflow:hidden}
    header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #304058}strong{font-size:14px;letter-spacing:.3px}.brand{color:#68dfc0}.badge{margin-left:auto;font-size:11px;color:#a7b8d1}.body{padding:12px}.status{white-space:pre-wrap;margin-bottom:10px;min-height:20px}.error{color:#ffb6b6}.actions{display:flex;gap:6px;flex-wrap:wrap}button{font:inherit;color:#e9f4ff;background:#25354d;border:1px solid #52647f;border-radius:7px;padding:5px 9px;cursor:pointer}button:hover{background:#354b6b}button:disabled{opacity:.45;cursor:default}.primary{background:#0f725f;border-color:#39b79d}.icon{padding:1px 6px;font-size:14px}.small{font-size:11px;color:#aebed4;margin-top:8px}.list{max-height:240px;overflow:auto;margin-top:8px}.row{padding:9px 0;border-top:1px solid #34465e}.row strong{font-size:12px;display:block;margin-bottom:5px}.reason{font-size:11px;color:#b4c2d7;margin:5px 0}.meter{height:6px;border-radius:4px;background:#30415a;position:relative;margin:10px 0;overflow:hidden}.mark{position:absolute;height:100%;background:#f6bd60}.hidden{display:none!important}details>summary{cursor:pointer;color:#c8d7ed;margin-top:8px}button:focus-visible,summary:focus-visible{outline:2px solid #7de8d0;outline-offset:2px}
  `;
  shadow.append(style);
  const panel = document.createElement("section"); panel.className = "panel"; panel.setAttribute("aria-label", "BiliSkip 广告跳过"); shadow.append(panel);
  const header = document.createElement("header"); panel.append(header);
  const brand = document.createElement("strong"); brand.className = "brand"; brand.textContent = "BiliSkip"; header.append(brand);
  const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = "本地优先"; header.append(badge);
  function button(label, fn, parent, cls = "") {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.className = cls;
    node.addEventListener("click", event => { if (event.isTrusted) fn(); }, { signal: abort.signal }); parent.append(node); return node;
  }
  const body = document.createElement("div"); body.className = "body";
  const collapse = button("收起", () => { body.hidden = !body.hidden; collapse.textContent = body.hidden ? "展开" : "收起"; collapse.setAttribute("aria-expanded", String(!body.hidden)); }, header, "icon");
  collapse.setAttribute("aria-label", "收起或展开 BiliSkip 面板"); collapse.setAttribute("aria-expanded", "true");
  panel.append(body);
  const status = document.createElement("div"); status.className = "status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); body.append(status);
  const actions = document.createElement("div"); actions.className = "actions"; body.append(actions);
  const analyzeButton = button("分析当前视频", () => {
    if (!settings.hasKey || !settings.consent) send({ type: "OPEN_OPTIONS" }).catch(showError);
    else analyze(Boolean(state.record), false);
  }, actions, "primary");
  const refreshButton = button("读取缓存", () => refresh(), actions);
  const toggle = button("开启自动跳过", () => toggleSkip(), actions);
  const skip = button("跳过当前广告", () => { const segment = currentSegment(); if (segment) jump(segment); }, actions);
  const undo = button("撤销跳过", () => undoSkip(), actions);
  button("设置", () => send({ type: "OPEN_OPTIONS" }).catch(showError), actions);
  const meter = document.createElement("div"); meter.className = "meter"; meter.setAttribute("aria-label", "广告时间轴"); body.append(meter);
  const details = document.createElement("details"); body.append(details);
  const summary = document.createElement("summary"); summary.textContent = "广告标记"; details.append(summary);
  const list = document.createElement("div"); list.className = "list"; details.append(list);
  const meta = document.createElement("div"); meta.className = "small"; body.append(meta);
  const share = button("上传此标记为候选", () => upload(), body); share.classList.add("hidden");
  const hint = document.createElement("div"); hint.className = "small"; hint.textContent = "原生进度条金色区间为广告。自动跳过开启时，定位进广告会跳至末尾；试听与撤销可暂时保留片段。"; body.append(hint);
  document.body.append(host);

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
      if (/context invalidated|Receiving end does not exist/i.test(error.message)) throw new Error("扩展已更新，请刷新视频页面。");
      throw error;
    }
  }
  function showError(error) { stage = "error"; host.dataset.errorCode = error.code || "MESSAGE"; message = error.message || "操作未完成，请重试。"; render(); }
  function valid() {
    return Boolean(ref && P.parse(location.href)?.route === ref.route && state.record && video && !awaitMedia &&
      video.readyState >= 1 && Date.now() - routeSince > 600 && P.matches(state.record, ref, video.duration));
  }
  function currentSegment() { return valid() ? P.at(state.record.segments, video.currentTime, ignored) : null; }
  function seekTo(target, kind) {
    seekIntent = { video, target, kind, route: ref.route };
    externalSeek = false;
    video.currentTime = target;
  }
  function isOwnSeek() {
    return Boolean(seekIntent && seekIntent.video === video && seekIntent.route === ref?.route &&
      Math.abs(video.currentTime - seekIntent.target) <= 0.35);
  }
  function seeking() {
    if (!isOwnSeek()) {
      seekIntent = null; externalSeek = true;
      ignored.clear(); completed.clear(); lastSkip = null;
    }
  }
  function seeked() {
    if (!video || video.seeking) return;
    const explicit = externalSeek || !isOwnSeek();
    seekIntent = null; externalSeek = false;
    if (explicit) {
      ignored.clear(); completed.clear(); lastSkip = null;
      host.dataset.lastAction = "seek";
      // An explicit timeline seek is also honored while the player is paused.
      const segment = currentSegment();
      if (segment && settings.autoSkip && P.automatic(state.record, segment, settings.confidenceThreshold)) {
        jump(segment); return;
      }
    }
    render();
  }
  function jump(segment) {
    if (!valid() || video.seeking) return;
    const index = state.record.segments.indexOf(segment);
    lastSkip = { index, from: video.currentTime, to: Math.min(video.duration, segment.end + 0.05), route: ref.route };
    completed.add(index);
    seekTo(lastSkip.to, "skip");
    host.dataset.lastJump = `${lastSkip.from.toFixed(3)}:${lastSkip.to.toFixed(3)}`;
    host.dataset.lastAction = "skip";
    render();
  }
  function undoSkip() {
    if (!valid() || !lastSkip || lastSkip.route !== ref.route || video.seeking) return;
    ignored.add(lastSkip.index);
    const target = lastSkip.from;
    lastSkip = null;
    seekTo(Math.max(0, target), "undo");
    host.dataset.lastAction = "undo";
    render();
  }
  async function toggleSkip() {
    if (!ref) return;
    const value = !settings.autoSkip, previous = settings.autoSkip;
    settings.autoSkip = value;
    if (value) { ignored.clear(); completed.clear(); lastSkip = null; }
    render();
    try { settings = await send({ type: "SET_AUTO_SKIP", video: ref, enabled: value }); }
    catch (error) { settings.autoSkip = previous; showError(error); }
    render();
  }
  function apply(result, epoch) {
    if (epoch !== generation) return;
    const changed = state.record?.key !== result.record?.key || state.record?.createdAt !== result.record?.createdAt;
    state = result; settings = result.settings || settings;
    host.dataset.build = settings.buildVersion || "";
    host.dataset.errorCode = result.error?.code || "";
    stage = result.error ? "error" : result.record ? "ready" : "idle";
    message = result.error?.message || result.warning || (result.record ? `${result.record.segments.length} 个广告区间已就绪。` : `已读取 ${result.cueCount} 条字幕，等待分析。`);
    if (changed) { recordRendered = ""; ignored.clear(); completed.clear(); lastSkip = null; }
    render(); maybeAuto();
  }
  async function refresh() {
    if (!ref || loading || analyzing) return;
    const epoch = generation; loading = true; stage = "loading"; message = "正在读取字幕并查询本地缓存…"; render();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { apply(await send({ type: "GET_PAGE_STATE", video: ref }), epoch); break; }
        catch (error) {
          if (error.code !== "SENDER" || attempt === 2) throw error;
          message = "正在跟随视频页面切换…"; render();
          await new Promise(resolve => setTimeout(resolve, 300));
          if (epoch !== generation || abort.signal.aborted) return;
        }
      }
    }
    catch (error) { if (epoch === generation) showError(error); }
    finally { if (epoch === generation) { loading = false; render(); maybeAuto(); } }
  }
  async function analyze(force, automatic) {
    if (!ref || analyzing || loading) return;
    const epoch = generation;
    analyzing = true; stage = "model"; message = "正在准备广告识别…"; render();
    try { apply(await send({ type: "ANALYZE", video: ref, force, automatic }), epoch); }
    catch (error) { if (epoch === generation) showError(error); }
    finally { if (epoch === generation) { analyzing = false; render(); } }
  }
  function maybeAuto() {
    if (!ref || state.record || !state.cueCount || loading || analyzing || document.visibilityState !== "visible" ||
        !settings.autoAnalyze || !settings.consent || !settings.hasKey || autoAttempted.has(ref.route)) return;
    autoAttempted.add(ref.route); analyze(false, true);
  }
  async function upload() {
    if (!state.record || !ref) return;
    share.disabled = true;
    try {
      const receipt = await send({ type: "UPLOAD", video: ref, key: state.record.key });
      message = `候选已提交，状态：${receipt.status}`; stage = "ready";
    } catch (error) { showError(error); }
    finally { share.disabled = false; render(); }
  }
  function renderRecords() {
    const record = state.record;
    const token = record ? `${record.key}:${record.createdAt}` : "none";
    if (token === recordRendered) return;
    recordRendered = token; list.replaceChildren(); meter.replaceChildren();
    summary.textContent = record ? `查看 ${record.segments.length} 个广告标记` : "广告标记";
    if (!record) return;
    for (const [index, segment] of record.segments.entries()) {
      const marker = document.createElement("span"); marker.className = "mark";
      marker.style.left = `${segment.start / record.video.duration * 100}%`;
      marker.style.width = `${(segment.end - segment.start) / record.video.duration * 100}%`;
      marker.title = `${segment.brand} ${P.stamp(segment.start)}–${P.stamp(segment.end)}`; meter.append(marker);
      const row = document.createElement("div"); row.className = "row";
      const title = document.createElement("strong"); title.textContent = `${P.stamp(segment.start)}–${P.stamp(segment.end)} · ${segment.brand} · ${segment.confidence.toFixed(2)}`;
      const reason = document.createElement("div"); reason.className = "reason"; reason.textContent = segment.reason;
      row.append(title, reason);
      button(`试听第 ${index + 1} 段边界`, () => {
        if (!valid() || video.seeking) return;
        ignored.add(index); lastSkip = null; seekTo(Math.max(0, segment.start - 2), "preview");
        host.dataset.lastAction = "preview"; render();
      }, row);
      button(`跳至第 ${index + 1} 段结束`, () => jump(segment), row);
      list.append(row);
    }
    if (!record.segments.length) { const text = document.createElement("div"); text.textContent = "本轮识别为 0 段广告。"; list.append(text); }
  }
  function render() {
    const segment = currentSegment();
    if (segment && settings.autoSkip && valid() && !video.paused && !video.seeking && !externalSeek &&
      !completed.has(state.record.segments.indexOf(segment)) && P.automatic(state.record, segment, settings.confidenceThreshold)) {
      jump(segment); return;
    }
    host.dataset.state = stage;
    host.dataset.cacheSource = state.record?.source || "";
    host.dataset.video = ref?.route || "";
    const playback = segment ? `当前广告：${segment.brand} · ${P.stamp(segment.start)} → ${P.stamp(segment.end)}` :
      lastSkip ? `已跳过 ${state.record?.segments[lastSkip.index]?.brand || "广告"}，可撤销返回。` : "";
    const content = stage === "error" || loading || analyzing ? message :
      awaitMedia ? "等待新视频媒体就绪…" : playback || message;
    if (status.textContent !== content) status.textContent = content;
    status.classList.toggle("error", stage === "error");
    badge.textContent = state.record ? P.sourceLabel(state.record.source) : analyzing ? "分析中" : "本地优先";
    analyzeButton.textContent = !settings.hasKey || !settings.consent ? "设置 Key 与授权" : state.record ? "重新分析（再次计费）" : "分析当前视频";
    analyzeButton.disabled = loading || analyzing;
    refreshButton.disabled = loading || analyzing;
    toggle.textContent = settings.autoSkip ? "自动跳过：开" : "开启自动跳过";
    skip.disabled = !segment || video?.seeking;
    undo.disabled = !lastSkip || !valid() || video?.seeking;
    share.classList.toggle("hidden", !settings.sharedUpload || !state.record);
    renderRecords();
    timeline.sync(valid() ? state.record : null, video);
    const usage = state.record?.usage;
    meta.textContent = state.record ? `${state.record.cueCount} 句字幕 · ${state.record.model} · ${(state.record.elapsedMs / 1000).toFixed(2)} 秒` +
      (usage ? `\n参考费用：空闲 ¥${usage.offPeakCny.toFixed(6)} / 高峰 ¥${usage.peakCny.toFixed(6)}（${usage.asOf}）` : "") +
      (state.metrics ? `\n本视频近期记录：模型请求 ${state.metrics.apiCalls} 次 · 缓存命中 ${state.metrics.cacheHits} 次` : "") :
      "分析时将字幕发送给 DeepSeek；结果保存在本机。";
    if (state.metrics) { host.dataset.apiCalls = String(state.metrics.apiCalls); host.dataset.cacheHits = String(state.metrics.cacheHits); }
    else { delete host.dataset.apiCalls; delete host.dataset.cacheHits; }
  }
  function mediaLoaded() {
    mediaRoute = P.parse(location.href)?.route || null;
    awaitMedia = Boolean(ref && mediaRoute !== ref.route);
    observedSource = video?.currentSrc || ""; seekIntent = null; externalSeek = false; render();
  }
  function detachMedia() {
    if (!video) return;
    video.removeEventListener("timeupdate", render); video.removeEventListener("loadedmetadata", mediaLoaded);
    video.removeEventListener("seeking", seeking); video.removeEventListener("seeked", seeked);
  }
  function tick() {
    const next = P.parse(location.href);
    const candidate = Array.from(document.querySelectorAll("video")).filter(element => element.getBoundingClientRect().width > 100)
      .sort((a, b) => { const x = a.getBoundingClientRect(), y = b.getBoundingClientRect(); return y.width * y.height - x.width * x.height; })[0] || null;
    if (next?.route !== ref?.route) {
      awaitMedia = Boolean(ref && candidate && candidate === video && candidate.currentSrc === observedSource && mediaRoute !== next?.route);
      ref = next; generation++; routeSince = Date.now(); state = {}; lastSkip = null; recordRendered = "";
      seekIntent = null; externalSeek = false; timeline.clear();
      delete host.dataset.lastJump; delete host.dataset.lastAction;
      loading = false; analyzing = false; ignored.clear(); completed.clear(); stage = "loading"; message = "正在准备当前视频…";
      if (ref) refresh();
    }
    if (candidate !== video) {
      detachMedia();
      video = candidate; observedSource = video?.currentSrc || ""; awaitMedia = false;
      mediaRoute = video?.readyState >= 1 ? ref?.route || null : null;
      seekIntent = null; externalSeek = false;
      if (video) {
        video.addEventListener("timeupdate", render); video.addEventListener("loadedmetadata", mediaLoaded);
        video.addEventListener("seeking", seeking); video.addEventListener("seeked", seeked);
      }
    } else if (video && video.currentSrc !== observedSource) { observedSource = video.currentSrc; mediaRoute = ref?.route || null; awaitMedia = false; }
    host.style.display = ref ? "block" : "none";
    if (ref) { render(); maybeAuto(); }
  }
  const onMessage = (data, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (data.type === "BILISKIP_PROGRESS" && data.route === ref?.route) {
      if (data.job?.status === "error") { stage = "error"; message = data.job.message; }
      else if (loading || analyzing) message = data.job?.message || data.message || message;
      render();
    } else if (data.type === "BILISKIP_SETTINGS") {
      const wasAutomatic = settings.autoAnalyze;
      const wasSkip = settings.autoSkip;
      settings = data.settings;
      if (!wasSkip && settings.autoSkip) { ignored.clear(); completed.clear(); lastSkip = null; }
      if (!wasAutomatic && settings.autoAnalyze && ref) autoAttempted.delete(ref.route);
      render(); maybeAuto();
    } else if (data.type === "BILISKIP_ANALYZE_FROM_POPUP") { analyze(false, false); respond({ ok: true }); }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener("visibilitychange", maybeAuto, { signal: abort.signal });
  const interval = setInterval(tick, 400);
  globalThis.__biliskipV1 = { destroy() {
    clearInterval(interval); abort.abort(); chrome.runtime.onMessage.removeListener(onMessage);
    detachMedia(); timeline.clear();
    host.remove();
  } };
  tick();
})();
