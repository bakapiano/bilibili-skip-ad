import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "./validation.js";

const DAY_MS = 86400000;
export const SUBMIT_INTERVAL_MS = 1000;

export class CacheStore {
  constructor(filename) {
    if (filename !== ":memory:") {
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS records (
        cache_key TEXT PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS ip_counts (
        ip TEXT NOT NULL,
        day INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        limited INTEGER NOT NULL DEFAULT 0,
        stored INTEGER NOT NULL DEFAULT 0,
        last_admitted_at INTEGER,
        PRIMARY KEY (ip, day)
      );
      CREATE INDEX IF NOT EXISTS ip_counts_day ON ip_counts(day);
    `);
    this.nextCleanup = 0;
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  prune(now) {
    if (now >= this.nextCleanup) {
      this.db.prepare("DELETE FROM ip_counts WHERE day < ?").run(Math.floor(now / DAY_MS) - 6);
      this.nextCleanup = now + 600000;
    }
  }

  consume(ip, now = Date.now()) {
    this.prune(now);
    return this.transaction(() => {
      const { last } = this.db
        .prepare("SELECT MAX(last_admitted_at) AS last FROM ip_counts WHERE ip = ?")
        .get(ip);
      const allowed = last === null || now - last >= SUBMIT_INTERVAL_MS;
      const day = Math.floor(now / DAY_MS);
      this.db
        .prepare(
          `
        INSERT INTO ip_counts(ip, day, attempts, limited, last_admitted_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(ip, day) DO UPDATE SET
          attempts = attempts + 1,
          limited = limited + excluded.limited,
          last_admitted_at = COALESCE(excluded.last_admitted_at, ip_counts.last_admitted_at)
      `,
        )
        .run(ip, day, allowed ? 0 : 1, allowed ? now : null);
      return {
        allowed,
        day,
        retryAfter: allowed ? 0 : Math.max(1, Math.ceil((last + SUBMIT_INTERVAL_MS - now) / 1000)),
      };
    });
  }

  save(cacheKey, requestHash, payload, ip, now) {
    return this.transaction(() => {
      const previous = this.db
        .prepare("SELECT id, request_hash, active FROM records WHERE cache_key = ?")
        .get(cacheKey);
      if (previous) {
        if (!previous.active) {
          throw new HttpError(410, "REVOKED", "该缓存记录已由维护者撤销。");
        }
        if (previous.request_hash !== requestHash) {
          throw new HttpError(409, "CACHE_EXISTS", "该视频与字幕版本已有共享标记。");
        }
        return {
          created: false,
          receipt: { schema_version: 1, status: "accepted", submission_id: previous.id },
        };
      }
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO records(cache_key, id, request_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(cacheKey, id, requestHash, JSON.stringify(payload), now);
      this.db
        .prepare("UPDATE ip_counts SET stored = stored + 1 WHERE ip = ? AND day = ?")
        .run(ip, Math.floor(now / DAY_MS));
      return {
        created: true,
        receipt: { schema_version: 1, status: "accepted", submission_id: id },
      };
    });
  }

  lookup(cacheKey) {
    const row = this.db
      .prepare("SELECT payload FROM records WHERE cache_key = ? AND active = 1")
      .get(cacheKey);
    if (!row) {
      return null;
    }
    const payload = JSON.parse(row.payload);
    return {
      schema_version: 1,
      status: "published",
      model: payload.model,
      prompt_version: payload.prompt_version,
      labels: payload.labels,
    };
  }

  stats() {
    this.prune(Date.now());
    return this.db
      .prepare(
        "SELECT ip, day, attempts, limited, stored FROM ip_counts ORDER BY day DESC, attempts DESC LIMIT 100",
      )
      .all()
      .map((row) => ({ ...row, day: new Date(row.day * DAY_MS).toISOString().slice(0, 10) }));
  }

  recent() {
    return this.db
      .prepare(
        "SELECT id, active, created_at, payload FROM records ORDER BY created_at DESC LIMIT 20",
      )
      .all()
      .map(({ payload, ...row }) => ({ ...row, video: JSON.parse(payload).video }));
  }

  revoke(id) {
    return this.db.prepare("UPDATE records SET active = 0 WHERE id = ?").run(id).changes;
  }

  close() {
    this.db.close();
  }
}
