import { MODEL, PROMPT_VERSION } from "./constants.js";
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
} from "./core.js";

export class AnalysisService {
  constructor({ db, bili, model, shared, settings, notify = () => {} }) {
    Object.assign(this, { db, bili, model, shared, settings, notify });
    this.contexts = new Map();
    this.loading = new Map();
    this.inflight = new Map();
    this.busy = null;
  }
  route(input) {
    const id = identity(input);
    return `${id.bvid}:p${id.page}`;
  }
  async load(input, reuse = false) {
    const route = this.route(input);
    const cached = this.contexts.get(route);
    if (reuse && cached && Date.now() - cached.fetchedAt < 60000) {
      return cached.context;
    }
    if (this.loading.has(route)) {
      return this.loading.get(route);
    }
    const promise = this.bili
      .load(identity(input), (stage, message) => this.notify(route, { stage, message }))
      .then(async (context) => {
        this.contexts.set(route, { context, fetchedAt: Date.now() });
        await this.db.put("contexts", { route, context, fetchedAt: Date.now() });
        return context;
      })
      .finally(() => this.loading.delete(route));
    this.loading.set(route, promise);
    return promise;
  }
  contextInfo(context) {
    return {
      video: context.video,
      video_key: context.video_key,
      transcript_sha256: context.transcript_sha256,
      cueCount: context.cues.length,
      subtitleSource: context.source,
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
  async prepare(input, { preferShared = false } = {}) {
    const context = await this.load(input);
    return {
      ...this.contextInfo(context),
      ...(await this.findRecord(context, true, preferShared)),
      job: await this.db.get("jobs", this.route(input)),
      metrics: await this.metrics(context),
    };
  }
  analyze(input, options = {}) {
    const route = this.route(input);
    if (this.inflight.has(route)) {
      return this.inflight.get(route);
    }
    if (this.busy) {
      return Promise.reject(new AppError("BUSY", "另一个视频正在分析，请等待该任务完成。"));
    }
    this.busy = route;
    const task = this.perform(input, options).finally(() => {
      this.busy = null;
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
      const context = await this.load(input, true);
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
      assert(settings.consent, "CONSENT", "请在设置中确认将视频字幕发送给 DeepSeek。");
      assert(settings.apiKey, "KEY", "请先配置 DeepSeek API Key。");
      assert(!automatic || settings.autoAnalyze, "CONSENT", "自动分析当前处于关闭状态。");
      await update({ stage: "model", message: "DeepSeek Flash 正在识别广告…" });
      await this.db.log({ type: "api-call", route: context.video_key, model: MODEL });
      const analysis = await this.model.analyze(context, settings.apiKey);
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
      let warning = "";
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
