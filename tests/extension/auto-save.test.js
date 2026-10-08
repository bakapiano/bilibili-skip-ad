import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutoSave } from "../../extension/lib/auto-save.js";
import { deferred, flush } from "./fixtures.js";

test("automatic settings writes serialize snapshots and only the newest completion reports saved", async () => {
  const gate = deferred();
  const writes = [];
  const statuses = [];
  const save = createAutoSave({
    save: async (patch) => {
      writes.push(patch);
      if (writes.length === 1) {
        await gate.promise;
      }
      return patch;
    },
    status: (value) => statuses.push(value),
  });
  const first = save({ autoSkip: true });
  const second = save({ autoSkip: false });
  await flush();
  assert.deepEqual(writes, [{ autoSkip: true }]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(writes, [{ autoSkip: true }, { autoSkip: false }]);
  assert.deepEqual(statuses, ["正在保存…", "正在保存…", "已自动保存"]);
});

test("failed writes remain visible and a subsequent retry can succeed", async () => {
  let failing = true;
  const statuses = [];
  const save = createAutoSave({
    save: async () => {
      if (failing) {
        throw new Error("synthetic storage error");
      }
      return { saved: true };
    },
    status: (message, error) => statuses.push({ message, error }),
  });
  await assert.rejects(save({ autoSkip: true }), /synthetic storage error/);
  assert.equal(statuses.at(-1).error, true);
  failing = false;
  assert.deepEqual(await save({ autoSkip: true }), { saved: true });
  assert.equal(statuses.at(-1).message, "已自动保存");
});
