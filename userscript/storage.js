import { assert } from "../extension/lib/core.js";

const PREFIX = "biliskip:v1:";
const KEYS = {
  records: "key",
  outbox: "id",
  events: "id",
  jobs: "route",
  contexts: "route",
  transcripts: "key",
};

// Each persistent row gets a GM key, avoiding lost updates from whole-db writes
// in separate tabs. Full subtitles and running jobs are scoped to this page.
export class GMStore {
  constructor(gm) {
    this.gm = gm;
    this.memory = { contexts: new Map(), jobs: new Map() };
  }
  key(store, id) {
    assert(Object.hasOwn(KEYS, store) && typeof id === "string", "CACHE", "缓存标识异常。");
    return `${PREFIX}${store}:${id}`;
  }
  async get(store, id) {
    const key = this.key(store, id);
    return this.memory[store] ? structuredClone(this.memory[store].get(id)) : this.gm.getValue(key);
  }
  async put(store, value) {
    const key = this.key(store, value[KEYS[store]]);
    if (this.memory[store]) {
      this.memory[store].set(value[KEYS[store]], structuredClone(value));
    } else {
      await this.gm.setValue(key, value);
    }
  }
  async remove(store, id) {
    const key = this.key(store, id);
    if (this.memory[store]) {
      this.memory[store].delete(id);
    } else {
      await this.gm.deleteValue(key);
    }
  }
  async all(store) {
    this.key(store, "");
    if (this.memory[store]) {
      return structuredClone([...this.memory[store].values()]);
    }
    const keys = (await this.gm.listValues()).filter((key) => key.startsWith(`${PREFIX}${store}:`));
    return (await Promise.all(keys.map((key) => this.gm.getValue(key)))).filter(Boolean);
  }
  async log(event) {
    await this.put("events", { ...event, id: crypto.randomUUID(), time: Date.now() });
    const rows = (await this.all("events")).sort((a, b) => b.time - a.time);
    await Promise.all(rows.slice(200).map((row) => this.remove("events", row.id)));
  }
  async stats() {
    const [records, events, outbox] = await Promise.all([
      this.all("records"),
      this.all("events"),
      this.all("outbox"),
    ]);
    return {
      records: records.length,
      apiCalls: events.filter((row) => row.type === "api-call").length,
      cacheHits: events.filter((row) => row.type === "cache-hit").length,
      pendingUploads: outbox.filter((row) => row.status !== "sent").length,
    };
  }
  async clearRecords() {
    this.memory.contexts.clear();
    for (const store of ["records", "outbox", "transcripts"]) {
      for (const row of await this.all(store)) {
        await this.remove(store, row[KEYS[store]]);
      }
    }
  }
}
