import { test } from "node:test";
import assert from "node:assert/strict";
import { renameWithRetry } from "../atomic-file.js";

test("atomic replacement retries transient sharing failures with same source and target", async () => {
  const calls = [];
  const waits = [];
  // Injected filesystem operations simulate transient Windows sharing locks.
  await renameWithRetry("synthetic-source", "synthetic-target", {
    renameFile: async (...args) => {
      calls.push(args);
      if (calls.length < 3) {
        throw Object.assign(new Error("sharing lock"), { code: "EPERM" });
      }
    },
    wait: async (delay) => {
      waits.push(delay);
    },
  });
  assert.deepEqual(
    calls,
    Array.from({ length: 3 }, () => ["synthetic-source", "synthetic-target"]),
  );
  assert.deepEqual(waits, [25, 50]);
});

test("atomic replacement bounds retries and propagates permanent failures", async () => {
  for (const [code, expected] of [
    ["EBUSY", 7],
    ["ENOENT", 1],
  ]) {
    let calls = 0;
    await assert.rejects(
      renameWithRetry("source", "target", {
        renameFile: async () => {
          calls++;
          throw Object.assign(new Error("simulated"), { code });
        },
        wait: async () => {},
      }),
      { code },
    );
    assert.equal(calls, expected);
  }
});
