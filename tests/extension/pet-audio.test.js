import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readPetAudio } from "../../extension/lib/pet-audio.js";
import {
  MAX_PET_AUDIO_BYTES,
  validatePetSettings,
  validatePetAudio,
} from "../../extension/lib/pet-config.js";

const bytes = await readFile(new URL("../../assets/pet/press.mp3", import.meta.url));
const data = `data:audio/mpeg;base64,${bytes.toString("base64")}`;
const file = (changes = {}) => ({
  name: "custom.mp3",
  type: "audio/mpeg",
  size: bytes.length,
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  ...changes,
});

function fixture({ duration = 0.24, error = false, automatic = true } = {}) {
  const instances = [];
  const released = [];
  // Test-only metadata decoder; actual audio decode/playback is covered by the Chromium check.
  class Audio extends EventTarget {
    duration = duration;
    constructor() {
      super();
      instances.push(this);
    }
    set src(value) {
      this.source = value;
      if (automatic) {
        queueMicrotask(() => this.dispatchEvent(new Event(error ? "error" : "loadedmetadata")));
      }
    }
    removeAttribute() {
      this.source = "";
    }
    load() {}
  }
  const view = {
    Audio,
    Blob,
    btoa,
    setTimeout,
    clearTimeout,
    URL: { createObjectURL: () => "blob:test-audio", revokeObjectURL: (url) => released.push(url) },
  };
  return { view, instances, released };
}

test("custom audio settings accept local typed media and reject malformed or oversized input", () => {
  assert.doesNotThrow(() => validatePetAudio(data));
  assert.equal(validatePetSettings({ petAudio: data, petAudioName: "custom.mp3" }).petAudio, data);
  for (const petAudio of [
    null,
    1,
    "https://example.test/audio.mp3",
    "data:text/html;base64,AAAA",
    "data:audio/mpeg;base64,AAAA",
    data + "A",
    `data:audio/mpeg;base64,${"A".repeat(MAX_PET_AUDIO_BYTES * 2)}`,
  ]) {
    assert.throws(() => validatePetSettings({ petAudio }), { code: "SETTINGS" });
  }
  assert.throws(() => validatePetSettings({ petAudioName: "x".repeat(101) }), { code: "SETTINGS" });
  for (const [mime, header] of [
    ["wav", "RIFF0000WAVE0000"],
    ["ogg", "OggS000000000000"],
    ["mp4", "0000ftyp00000000"],
  ]) {
    assert.doesNotThrow(() =>
      validatePetAudio(`data:audio/${mime};base64,${Buffer.from(header).toString("base64")}`),
    );
  }
  assert.throws(() => validatePetAudio(`data:audio/wav;base64,${bytes.toString("base64")}`));
});

test("audio upload validates local metadata, normalizes MIME and releases its object URL", async () => {
  const f = fixture();
  const result = await readPetAudio(file({ type: "audio/mp3" }), f.view);
  assert.deepEqual(result, { petAudio: data, petAudioName: "custom.mp3" });
  assert.equal(f.instances[0].preload, "metadata");
  assert.equal(f.instances[0].source, "");
  assert.deepEqual(f.released, ["blob:test-audio"]);
  const named = await readPetAudio(file({ type: "", name: "CUSTOM.MP3" }), fixture().view);
  assert.equal(named.petAudio, data);
});

test("oversized, wrong-type, long and undecodable audio leaves the saved preference untouched", async () => {
  for (const sample of [
    null,
    file({ size: 0 }),
    file({ size: MAX_PET_AUDIO_BYTES + 1 }),
    file({ type: "text/html" }),
  ]) {
    const f = fixture();
    await assert.rejects(readPetAudio(sample, f.view));
    assert.equal(f.instances.length, 0);
  }
  for (const options of [
    { duration: 11 },
    { duration: Infinity },
    { duration: 0 },
    { error: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(readPetAudio(file(), f.view));
    assert.deepEqual(f.released, ["blob:test-audio"]);
  }
});

test("cancelled metadata loading releases the audio and preserves the caller's cancellation", async () => {
  const f = fixture({ automatic: false });
  const controller = new AbortController();
  const cancelled = new Error("test-only-cancelled");
  const pending = readPetAudio(file(), f.view, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(cancelled);
  await assert.rejects(pending, (error) => error === cancelled);
  assert.equal(f.instances[0].source, "");
  assert.deepEqual(f.released, ["blob:test-audio"]);
});
