export class LocalDB {
  constructor(factory = globalThis.indexedDB, name = "biliskip-v1") { this.factory = factory; this.name = name; this.pending = null; }
  open() {
    if (this.pending) return this.pending;
    this.pending = new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const records = db.createObjectStore("records", { keyPath: "key" });
        records.createIndex("createdAt", "createdAt");
        db.createObjectStore("contexts", { keyPath: "route" });
        db.createObjectStore("jobs", { keyPath: "route" });
        db.createObjectStore("outbox", { keyPath: "id" });
        db.createObjectStore("events", { keyPath: "id", autoIncrement: true });
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => { this.pending = null; reject(request.error); };
      request.onblocked = () => reject(new Error("本地数据库正在升级，请刷新扩展页面。"));
    });
    return this.pending;
  }
  async execute(store, mode, operation) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      let result;
      try {
        const request = operation(transaction.objectStore(store));
        if (request) request.onsuccess = () => { result = request.result; };
      } catch (error) { transaction.abort(); reject(error); return; }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("数据库事务已中止。"));
    });
  }
  get(store, key) { return this.execute(store, "readonly", object => object.get(key)); }
  put(store, value) { return this.execute(store, "readwrite", object => object.put(value)); }
  all(store) { return this.execute(store, "readonly", object => object.getAll()); }
  remove(store, key) { return this.execute(store, "readwrite", object => object.delete(key)); }
  async log(event) {
    await this.put("events", { ...event, time: Date.now() });
    const rows = await this.all("events");
    if (rows.length > 200) await Promise.all(rows.slice(0, rows.length - 200).map(row => this.remove("events", row.id)));
  }
  async recoverJobs() {
    for (const job of await this.all("jobs")) {
      if (job.status === "running") await this.put("jobs", { ...job, status: "error", stage: "interrupted",
        message: "上次分析已中断，请手动重试；此前请求可能产生 API 用量。", updatedAt: Date.now() });
    }
  }
  async stats() {
    const [records, events, outbox] = await Promise.all([this.all("records"), this.all("events"), this.all("outbox")]);
    return { records: records.length, cacheHits: events.filter(event => event.type === "cache-hit").length,
      apiCalls: events.filter(event => event.type === "api-call").length,
      pendingUploads: outbox.filter(row => row.status !== "sent").length };
  }
  async clearRecords() {
    // Secrets/settings are in chrome.storage, outside this database operation.
    await Promise.all(["records", "contexts", "outbox"].map(store => this.execute(store, "readwrite", object => object.clear())));
  }
}
