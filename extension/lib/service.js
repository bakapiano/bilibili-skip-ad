import { MODEL, PROMPT_VERSION } from "./constants.js";
import { ASR_VERSION, exemptVideo } from "./asr-config.js";
import { audioTrack } from "./audio.js";
import {
  AppError,
  assert,
  cacheKey,
  identity,
  publicRecord,
  safeError,
  sharedOrigin,
  validateLabels,
  canonical,
  normalize,
  hash,
} from "./core.js";

export class AnalysisService {
  constructor({
    db,
    bili,
    model,
    shared,
    settings,
    asr,
    notify = () => {},
    taskLock = (_name, task) => task(),
  }) {
    Object.assign(this, { db, bili, model, shared, settings, asr, notify, taskLock });
    this.contexts = new Map();
    this.loading = new Map();
    this.inflight = new Map();
    this.resources = new Set();
  }
  route(input) {
    const id = identity(input);
    return `${id.bvid}:p${id.page}`;
  }
  async withResource(name, task) {
    if (this.resources.has(name)) {
      throw new AppError(
        "BUSY",
        name === "asr"
          ? "另一个视频正在本地转写，请完成后重试。"
          : "另一个视频正在请求 DeepSeek，请完成后重试。",
      );
    }
    this.resources.add(name);
    try {
      return await this.taskLock(name, task);
    } finally {
      this.resources.delete(name);
    }
  }
  async load(input, reuse = false, allowAsr = false, automatic = false, cacheOnly = false) {
    const route = this.route(input);
    const settings = await this.settings();
    const policy = JSON.stringify([
      settings.asrEnabled,
      settings.shortVideoExempt,
      settings.shortVideoMinutes,
    ]);
    const cached = this.contexts.get(route);
    if (
      reuse &&
      cached &&
      cached.policy === policy &&
      !cached.context.asrRequired &&
      Date.now() - cached.fetchedAt < 60000
    ) {
      return cached.context;
    }
    const taskKey = `${route}:${allowAsr}:${cacheOnly}:${policy}`;
    if (this.loading.has(taskKey)) {
      return this.loading.get(taskKey);
    }
    const progress = (stage, message) => this.notify(route, { stage, message });
    const promise = (async () => {
      const metadata = this.bili.metadata ? await this.bili.metadata(input) : null;
      if (metadata && exemptVideo(metadata.video, settings)) {
        return {
          video: metadata.video,
          exempt: true,
          cues: [],
          source: "",
          notice: `短视频豁免：时长小于${settings.shortVideoMinutes}分钟，已跳过字幕、转写与广告分析。`,
        };
      }
      try {
        return await this.bili.load(identity(input), progress, metadata);
      } catch (error) {
        if (error.code !== "NO_SUBTITLE" || !metadata || !settings.asrEnabled || !this.asr) {
          throw error;
        }
        const key = await hash({ video: metadata.video, asr: ASR_VERSION });
        const saved = await this.db.get("transcripts", key);
        if (saved) {
          const context = await normalize(
            metadata.video,
            saved.context.cues,
            `local-asr:${ASR_VERSION}`,
          );
          assert(
            context.transcript_sha256 === saved.context.transcript_sha256,
            "ASR_CACHE",
            "本地转写缓存校验失败。",
          );
          return context;
        }
        // Optional platform dependencies gate fresh ASR only; saved transcripts remain reusable.
        await this.asr.ensureAvailable?.();
        if (!allowAsr) {
          return {
            video: metadata.video,
            cues: [],
            asrRequired: true,
            source: "",
            notice:
              !settings.apiKey || !settings.consent
                ? settings.sharedRead
                  ? "当前无可用字幕，可手动转写后查询共享缓存。首次下载约239MB模型；转写文本按本地语音转写区块的上传开关处理。"
                  : "当前无可用字幕。开启共享缓存后，可手动转写并查询已有标记。"
                : "当前无可用字幕，可使用本地语音转写后分析。首次下载约239MB模型。",
          };
        }
        if (cacheOnly) {
          assert(settings.sharedRead, "SHARED_DISABLED", "请先开启共享缓存查询。");
        } else {
          assert(
            settings.consent && settings.apiKey,
            "CONSENT",
            "请先配置Key并同意将转写字幕发送给DeepSeek。",
          );
        }
        assert(!automatic || settings.autoAnalyze, "CONSENT", "自动分析已关闭。");
        // Reserve only the CPU path; subtitle/cache reads and model requests can proceed separately.
        const result = await this.withResource("asr", async () => {
          progress("audio", "正在获取视频音轨…");
          const track = await audioTrack(metadata.video, this.bili.fetcher);
          return this.asr.transcribe(
            metadata.video,
            track,
            settings.asrConcurrency,
            (text) => progress("asr", text),
            settings.asrModelSource,
          );
        });
        const context = await normalize(metadata.video, result.cues, `local-asr:${ASR_VERSION}`);
        await this.db.put("transcripts", {
          key,
          context,
          createdAt: Date.now(),
          asrVersion: ASR_VERSION,
          metrics: result.metrics,
        });
        try {
          const receipt = await this.uploadTranscript(context);
          if (receipt) {
            progress("asr-upload", "转写字幕已上传，用于后续准确度评估。");
          }
        } catch (error) {
          context.asrUploadWarning = `转写字幕已保存在本机，上传暂未完成：${safeError(error).message}`;
          await this.db.log({
            type: "transcript-upload-error",
            route: context.video_key,
            code: safeError(error).code,
          });
        }
        return context;
      }
    })()
      .then(async (context) => {
        this.contexts.set(route, { context, fetchedAt: Date.now(), policy });
        await this.db.put("contexts", { route, context, fetchedAt: Date.now() });
        return context;
      })
      .finally(() => this.loading.delete(taskKey));
    this.loading.set(taskKey, promise);
    return promise;
  }
  contextInfo(context) {
    return {
      video: context.video,
      video_key: context.video_key,
      transcript_sha256: context.transcript_sha256,
      cueCount: context.cues.length,
      subtitleSource: context.source,
      exempt: Boolean(context.exempt),
      asrRequired: Boolean(context.asrRequired),
    };
  }
  async metrics(context) {
    const events = (await this.db.all("events")).filter((row) => row.route === context.video_key);
    return {
      apiCalls: events.filter((row) => row.type === "api-call").length,
      cacheHits: events.filter((row) => row.type === "cache-hit").length,
    };
  }
  makeRecord(context, labels, details = {}) {
    const validated = validateLabels(context, labels);
    return {
      key: cacheKey(context),
      version: 1,
      video: context.video,
      video_key: context.video_key,
      transcript_sha256: context.transcript_sha256,
      cueCount: context.cues.length,
      labels,
      ...validated,
      model: MODEL,
      promptVersion: PROMPT_VERSION,
      createdAt: Date.now(),
      source: details.source || "deepseek",
      usage: details.usage || null,
      elapsedMs: details.elapsedMs || 0,
    };
  }
  async findRecord(context, allowShared = true, preferShared = false) {
    const cached = await this.db.get("records", cacheKey(context));
    let warning = "";
    const localResult = async () => {
      const validated = validateLabels(context, cached.labels);
      assert(
        cached.model === MODEL && cached.promptVersion === PROMPT_VERSION,
        "CACHE",
        "本地标记版本异常，请重新分析。",
      );
      await this.db.log({ type: "cache-hit", route: context.video_key });
      return {
        record: publicRecord(
          {
            ...cached,
            ...validated,
            video: context.video,
            video_key: context.video_key,
            transcript_sha256: context.transcript_sha256,
            cueCount: context.cues.length,
          },
          "local-cache",
        ),
        warning,
      };
    };
    if (cached && !preferShared) {
      return localResult();
    }
    const settings = await this.settings();
    if (allowShared && settings.sharedRead) {
      try {
        const labels = await this.shared.lookup(context, settings);
        if (labels) {
          const unchanged = cached && canonical(cached.labels) === canonical(labels);
          const record = unchanged
            ? { ...cached, ...validateLabels(context, labels), source: "shared" }
            : this.makeRecord(context, labels, { source: "shared" });
          await this.db.put("records", record);
          await this.db.log({ type: "shared-hit", route: context.video_key });
          return { record: publicRecord(record), warning: "" };
        }
        if (preferShared) {
          warning = cached
            ? "线上暂无此标记，继续使用本地缓存。"
            : "线上暂无此标记，可使用个人 Key 分析。";
        }
      } catch (error) {
        warning = safeError(error).message;
      }
    } else if (preferShared) {
      warning = "线上缓存查询已关闭，可在设置中开启。";
    }
    return cached ? localResult() : { record: null, warning };
  }
  async prepare(input, { preferShared = false, transcribeForCache = false } = {}) {
    // Explicit cache-only transcription can prepare an input fingerprint without model authorization.
    const context = await this.load(input, false, transcribeForCache, false, transcribeForCache);
    if (context.exempt || context.asrRequired) {
      return { ...this.contextInfo(context), record: null, notice: context.notice };
    }
    const found = await this.findRecord(context, true, preferShared);
    const settings = await this.settings();
    const cacheOnly = !settings.apiKey || !settings.consent;
    const notice =
      cacheOnly && !found.record && !found.warning
        ? settings.sharedRead
          ? "共享缓存暂未收录匹配标记。可稍后再查，或配置 DeepSeek Key 并授权后自行识别。"
          : "本地缓存暂无匹配标记。可在设置中开启共享缓存，或配置 DeepSeek Key 自行识别。"
        : "";
    return {
      ...this.contextInfo(context),
      ...found,
      warning: found.warning || context.asrUploadWarning || "",
      notice,
      job: await this.db.get("jobs", this.route(input)),
      metrics: await this.metrics(context),
    };
  }
  analyze(input, options = {}) {
    const route = this.route(input);
    if (this.inflight.has(route)) {
      return this.inflight.get(route);
    }
    const task = this.perform(input, options).finally(() => {
      this.inflight.delete(route);
    });
    this.inflight.set(route, task);
    return task;
  }
  async perform(input, { force = false, automatic = false } = {}) {
    const route = this.route(input);
    const job = {
      route,
      id: crypto.randomUUID(),
      status: "running",
      startedAt: Date.now(),
      stage: "subtitle",
      message: "正在准备字幕…",
    };
    const update = async (patch) => {
      Object.assign(job, patch, { updatedAt: Date.now() });
      await this.db.put("jobs", { ...job });
      this.notify(route, { job });
    };
    await update({});
    try {
      let context = await this.load(input, true, true, automatic);
      const afterLoad = await this.settings();
      if (context.exempt || exemptVideo(context.video, afterLoad)) {
        context = {
          ...context,
          exempt: true,
          notice: `短视频豁免：时长小于${afterLoad.shortVideoMinutes}分钟，已跳过广告分析。`,
        };
        await update({ status: "done", stage: "exempt", message: context.notice });
        return { ...this.contextInfo(context), record: null, notice: context.notice, job };
      }
      if (!force) {
        const existing = await this.findRecord(context);
        if (existing.record) {
          await update({
            status: "done",
            stage: "cached",
            message: "已命中缓存，本轮模型请求 0 次。",
          });
          return {
            ...this.contextInfo(context),
            ...existing,
            job,
            metrics: await this.metrics(context),
          };
        }
      }
      const settings = await this.settings();
      if (exemptVideo(context.video, settings)) {
        await update({ status: "done", stage: "exempt", message: "当前视频已按时长豁免。" });
        return {
          ...this.contextInfo(context),
          exempt: true,
          record: null,
          notice: job.message,
          job,
        };
      }
      assert(settings.consent, "CONSENT", "请在设置中确认将视频字幕发送给 DeepSeek。");
      assert(settings.apiKey, "KEY", "请先配置 DeepSeek API Key。");
      assert(!automatic || settings.autoAnalyze, "CONSENT", "自动分析当前处于关闭状态。");
      const analysis = await this.withResource("model", async () => {
        await update({ stage: "model", message: "DeepSeek Flash 正在识别广告…" });
        await this.db.log({ type: "api-call", route: context.video_key, model: MODEL });
        return this.model.analyze(context, settings.apiKey);
      });
      const finalSettings = await this.settings();
      if (exemptVideo(context.video, finalSettings)) {
        await update({
          status: "done",
          stage: "exempt",
          message: "短视频豁免已开启，当前视频保留完整播放。",
        });
        return {
          ...this.contextInfo(context),
          record: null,
          exempt: true,
          notice: job.message,
          job,
        };
      }
      await update({
        stage: "validate",
        message: "正在校验时间段并保存到本地…",
        usage: analysis.usage,
      });
      const record = this.makeRecord(context, analysis.labels, analysis);
      await this.db.put("records", record);
      await this.db.log({
        type: "analysis-done",
        route: context.video_key,
        elapsedMs: analysis.elapsedMs,
        usage: analysis.usage,
      });
      let warning = context.asrUploadWarning || "";
      let uploadNotice = "";
      try {
        // Read the latest switches after the model finishes so an in-flight
        // analysis respects changes made in the settings page.
        const latest = await this.settings();
        if (latest.sharedUpload && latest.autoUpload) {
          await update({ stage: "upload", message: "广告标记已保存，正在自动上传线上缓存…" });
          const receipt = await this.upload(record.key, { automatic: true });
          if (receipt) {
            uploadNotice =
              receipt.status === "accepted"
                ? "已自动上传线上缓存。"
                : "已自动提交，等待共享服务收录。";
          }
        }
      } catch (error) {
        // Sharing is best-effort: the validated local analysis remains usable.
        warning = `广告标记已保存在本地。自动上传暂未完成：${safeError(error).message} 可点击「上传到线上缓存」重试。`;
      }
      await update({
        status: "done",
        stage: "done",
        message: `已识别 ${record.segments.length} 个广告区间。${uploadNotice}`,
      });
      return {
        ...this.contextInfo(context),
        record: publicRecord(record),
        warning,
        notice: job.message,
        job,
        metrics: await this.metrics(context),
      };
    } catch (error) {
      await update({
        status: "error",
        stage: "error",
        message: safeError(error).message,
        error: safeError(error),
        usage: error.details?.usage || null,
      });
      await this.db.log({
        type: "analysis-error",
        route,
        code: safeError(error).code,
        usage: error.details?.usage || null,
      });
      throw error;
    }
  }
  async uploadTranscript(context) {
    const settings = await this.settings();
    if (!settings.asrUpload) {
      return null;
    }
    const origin = sharedOrigin(settings.sharedBaseUrl);
    assert(origin, "SHARED_CONFIG", "请配置转写字幕接收服务域名。");
    const candidate = await this.shared.transcript(context);
    const entry = { ...candidate, id: `${origin}:transcript:${candidate.id}`, origin };
    const previous = await this.db.get("outbox", entry.id);
    if (previous?.status === "sent") {
      return previous.receipt;
    }
    await this.db.put("outbox", entry);
    try {
      const receipt = await this.shared.uploadTranscript(candidate, settings, async () => {
        const latest = await this.settings();
        return latest.asrUpload && sharedOrigin(latest.sharedBaseUrl) === origin;
      });
      await this.db.put("outbox", {
        ...entry,
        status: receipt ? "sent" : "cancelled",
        receipt,
        sentAt: receipt ? Date.now() : null,
      });
      return receipt;
    } catch (error) {
      await this.db.put("outbox", { ...entry, status: "error", error: safeError(error) });
      throw error;
    }
  }
  async upload(key, { automatic = false } = {}) {
    const settings = await this.settings();
    if (automatic && (!settings.sharedUpload || !settings.autoUpload)) {
      return null;
    }
    assert(settings.sharedUpload, "SHARED_DISABLED", "请先在设置中启用候选上传。");
    const origin = sharedOrigin(settings.sharedBaseUrl);
    assert(origin, "SHARED_CONFIG", "请配置共享服务域名。");
    const record = await this.db.get("records", key);
    assert(record, "CACHE", "请先生成并保存广告标记。");
    if (automatic && exemptVideo(record.video, settings)) {
      return null;
    }
    const candidate = await this.shared.candidate(record);
    // Scope local receipts to their destination. The HTTP idempotency key remains
    // the payload hash, while changing servers creates an independent outbox row.
    const entry = {
      ...candidate,
      id: `${origin}:${candidate.id}`,
      origin,
      idempotencyKey: candidate.id,
    };
    const previous = await this.db.get("outbox", entry.id);
    if (previous?.status === "sent") {
      return previous.receipt;
    }
    await this.db.put("outbox", entry);
    try {
      const receipt = await this.shared.upload(candidate, settings);
      await this.db.put("outbox", { ...entry, status: "sent", receipt, sentAt: Date.now() });
      return receipt;
    } catch (error) {
      await this.db.put("outbox", { ...entry, status: "error", error: safeError(error) });
      throw error;
    }
  }
}
