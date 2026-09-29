import assert from "node:assert/strict";
import { test } from "node:test";
import { uiFixture } from "./ui-fixture.js";
import { flush } from "./fixtures.js";
import { validateSettings } from "../../extension/lib/core.js";
import { publicSettings } from "../../extension/lib/messaging.js";

test("options load, save and retain the automatic-upload opt-out", async () => {
  let settings = validateSettings();
  const messages = [];
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === "GET_CACHE") {
          return { ok: true, data: { records: [], stats: {} } };
        }
        if (message.type === "SAVE_SETTINGS") {
          settings = validateSettings(message.settings);
        }
        return { ok: true, data: publicSettings(settings) };
      },
    },
    permissions: { contains: async () => true },
  };
  const f = uiFixture("options", chrome);
  await flush();
  assert.equal(f.get("auto-upload").checked, true);
  f.get("auto-upload").checked = false;
  await f.get("settings-form").emit("submit");
  assert.equal(messages.at(-1).settings.autoUpload, false);
  assert.equal(settings.sharedUpload, true);
  const reopened = uiFixture("options", chrome);
  await flush();
  assert.equal(reopened.get("auto-upload").checked, false);
  reopened.get("shared-upload").checked = false;
  await reopened.get("shared-upload").emit("change");
  assert.equal(reopened.get("auto-upload").disabled, true);
});
