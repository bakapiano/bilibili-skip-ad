import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  DEFAULT_PET_SETTINGS,
  PET_DIALOGUES,
  PET_DIALOGUE_VERSION,
  PET_DIALOGUE_GROUPS,
  petDialogueGroups,
  validatePetSettings,
} from "../../extension/lib/pet-config.js";
import { cropLayout, readCropImage, MAX_UPLOAD_BYTES } from "../../extension/lib/pet-crop.js";
import { bindPetSettings } from "../../extension/lib/pet-settings-view.js";
import { validateSettings } from "../../extension/lib/core.js";

const png = await readFile(new URL("../../extension/icons/icon-128.png", import.meta.url));
const imageData = `data:image/png;base64,${png.toString("base64")}`;
const audioBytes = await readFile(new URL("../../assets/pet/press.mp3", import.meta.url));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("pet preferences validate defaults, local images, captions and per-scene placeholders", () => {
  assert.deepEqual(validatePetSettings(), DEFAULT_PET_SETTINGS);
  const input = {
    petDialogueVersion: PET_DIALOGUE_VERSION,
    petEnabled: true,
    petMirror: true,
    petVolume: 35,
    petImage: imageData,
    petPanelLabel: "查看结果",
    petDialogues: {
      skip: { title: "跳过 {seconds} 秒\n<img src=x>\n继续看吧" },
      done: { title: "¥{cost}" },
    },
  };
  const checked = validateSettings(input);
  assert.equal(checked.petImage, imageData);
  assert.deepEqual(checked.petDialogues, input.petDialogues);
  assert.notEqual(checked.petDialogues.skip, input.petDialogues.skip);
  const invalid = [
    { petEnabled: "true" },
    { petMirror: 1 },
    { petSound: null },
    { petVolume: 1.5 },
    { petVolume: -1 },
    { petVolume: 101 },
    { petPanelLabel: " " },
    { petPanelLabel: "x".repeat(13) },
    { petImage: "https://example.test/image.png" },
    { petImage: "data:image/svg+xml,<svg/>" },
    { petImage: "data:image/png;base64,AAAA" },
    { petImage: "data:image/png;base64,%%%" },
    { petImage: `${imageData}A` },
    { petDialogues: null },
    { petDialogues: [] },
    { petDialogues: { unknown: {} } },
    { petDialogues: { idle: { title: "x".repeat(25) } } },
    { petDialogueVersion: 2, petDialogues: { idle: { title: "x".repeat(161) } } },
    { petDialogueVersion: 5 },
    { petDialogueVersion: 3, petDialogues: { done: { title: "{offPeak}" } } },
    { petDialogues: { skip: { detail: "x".repeat(121) } } },
    { petDialogues: { idle: { title: "{seconds}" } } },
    { petDialogues: { skip: { detail: "{peak}" } } },
    { petDialogues: { idle: { html: "anything" } } },
    { petDialogues: JSON.parse('{"__proto__":{"title":"bad"}}') },
  ];
  const large = Buffer.from(png);
  large.writeUInt32BE(1025, 16);
  invalid.push({ petImage: `data:image/png;base64,${large.toString("base64")}` });
  for (const settings of invalid) {
    assert.throws(() => validateSettings(settings), { code: "SETTINGS" });
  }
});

test("crop layout fits the whole image, preserves aspect ratio and bounds zoom/pan", () => {
  assert.deepEqual(cropLayout(1024, 512), {
    x: 0,
    y: 64,
    width: 256,
    height: 128,
    offsetX: 0,
    offsetY: 0,
  });
  const zoomed = cropLayout(1024, 512, 2, 999, -999);
  assert.deepEqual(zoomed, {
    x: 0,
    y: 0,
    width: 512,
    height: 256,
    offsetX: 128,
    offsetY: 0,
  });
  assert.equal(cropLayout(100, 100, 99).width, 1024);
  assert.equal(cropLayout(100, 100, -1).width, 256);
  for (const params of [
    [0, 1],
    [1, NaN],
    [1, 1, Infinity],
  ]) {
    assert.throws(() => cropLayout(...params));
  }
});

test("legacy dialogue migration preserves custom text, tokens and blanks exactly once", () => {
  const legacy = {
    petMirror: true,
    petVolume: 35,
    petImage: imageData,
    petDialogues: {
      idle: { title: "自定义陪伴", detail: "旧说明" },
      done: { title: "花费报告" },
      skip: { detail: "快进 {seconds} 秒" },
      error: { title: "", detail: "" },
      local: { title: "本地已经记住啦", detail: "本次模型费用 ¥0 · 已复用广告标记" },
      shared: {},
    },
  };
  const first = validateSettings(legacy);
  assert.equal(first.petDialogueVersion, 4);
  assert.equal(first.petMirror, true);
  assert.equal(first.petVolume, 35);
  assert.equal(first.petImage, imageData);
  assert.equal(first.petDialogues.idle.title, "自定义陪伴\n旧说明");
  assert.equal(first.petDialogues.done.title, "花费报告\n本次约 ¥{cost}");
  assert.equal(first.petDialogues.skip.title, "帮你跳过恰饭啦\n快进 {seconds} 秒");
  assert.equal(first.petDialogues.error, undefined);
  assert.equal(PET_DIALOGUES.error.title, "搞不定啦！打开面板自己看一下~");
  assert.equal(first.petDialogues.local, undefined);
  assert.equal(first.petDialogues.shared, undefined);
  assert.deepEqual(validateSettings(first), first);
  assert.equal(legacy.petDialogues.idle.detail, "旧说明");
  for (const dialogue of Object.values(first.petDialogues)) {
    assert.deepEqual(Object.keys(dialogue), ["title"]);
  }
  const maximum = validatePetSettings({
    petDialogues: { idle: { title: "甲".repeat(24), detail: "乙".repeat(120) } },
  });
  assert.equal(maximum.petDialogues.idle.title.length, 145);
  assert.deepEqual(validatePetSettings(maximum), maximum);
  const fromOldTab = validateSettings({
    ...first,
    petDialogues: { skip: { detail: "{seconds} 秒！" } },
  });
  assert.equal(fromOldTab.petDialogues.skip.title, "帮你跳过恰饭啦\n{seconds} 秒！");
});

test("user-authored defaults merge equivalent scenes and keep a single cost placeholder", () => {
  for (const dialogue of Object.values(PET_DIALOGUES)) {
    assert.equal(Object.hasOwn(dialogue, "detail"), false);
    assert.ok(dialogue.title.length <= 160);
  }
  assert.equal(PET_DIALOGUES.idle.title, "好模型...");
  assert.equal(PET_DIALOGUES.done.title, "大肥鱼吃了你 ¥{cost}");
  assert.match(PET_DIALOGUES.skip.title, /\{seconds\}/);
  assert.equal(PET_DIALOGUES.shared, undefined);
  assert.equal(PET_DIALOGUES.local, undefined);
  assert.equal(PET_DIALOGUES.loading.title, "恰饭片段寻找中...");
  assert.equal(PET_DIALOGUES.asr.title, PET_DIALOGUES.loading.title);
  assert.equal(PET_DIALOGUES.analyzing.title, PET_DIALOGUES.loading.title);
  assert.equal(PET_DIALOGUES.record.title, "恰饭片段已定位！");
  assert.equal(PET_DIALOGUES.doneUnknown.title, "");
  assert.equal(PET_DIALOGUES.exempt.title, "");
  assert.equal(petDialogueGroups(DEFAULT_PET_SETTINGS).length, 7);
});

test("image decoding uses local object URLs and releases resources on success or rejection", async () => {
  const revoked = [];
  let dimension = 610;
  let fail = false;
  // Test-only image decoder; canvas pixels are verified separately in Chromium.
  const view = {
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: (url) => revoked.push(url) },
    Image: class {
      naturalWidth = dimension;
      naturalHeight = dimension;
      async decode() {
        if (fail) {
          throw new Error("decode failed");
        }
      }
    },
  };
  const file = { type: "image/png", size: 1024 };
  const decoded = await readCropImage(file, view);
  assert.equal(decoded.image.src, "blob:test");
  decoded.release();
  dimension = 8193;
  await assert.rejects(readCropImage(file, view));
  dimension = 610;
  fail = true;
  await assert.rejects(readCropImage(file, view));
  assert.equal(revoked.length, 3);
  for (const bad of [
    null,
    { ...file, type: "image/svg+xml" },
    { ...file, size: 0 },
    { ...file, size: MAX_UPLOAD_BYTES + 1 },
  ]) {
    await assert.rejects(readCropImage(bad, view));
  }
  assert.equal(revoked.length, 3);
});

test("the user's approved v2 captions migrate into shared defaults with one cost and one error", () => {
  // Fixed copy of the explicitly approved local captions; no browser profile or credentials are read.
  const titles = {
    idle: "好模型...",
    loading: "恰饭片段寻找中...！",
    analyzing: "恰饭片段寻找中...！",
    asr: "恰饭片段寻找中...！",
    done: "大肥鱼吃了你 ¥{offPeak}～{peak} ！",
    doneUnknown: "",
    exempt: "",
    error: "",
    errorUnknown: "",
    errorWithUsage: "",
    local: "缓存命中！吃白饭啦",
    shared: "缓存命中！吃白饭啦",
    record: "恰饭片段已定位！",
    skip: "跳过 {seconds} 秒恰饭片段~ 吃点白饭不过分吧！",
  };
  const migrated = validatePetSettings({
    petDialogueVersion: 2,
    petDialogues: Object.fromEntries(
      Object.entries(titles).map(([scene, title]) => [scene, { title }]),
    ),
  });
  assert.deepEqual(migrated.petDialogues, {});
  assert.equal(migrated.petDialogueVersion, 4);
  assert.deepEqual(validatePetSettings(migrated), migrated);
  assert.deepEqual(
    petDialogueGroups(migrated).map((group) => group.scenes),
    PET_DIALOGUE_GROUPS.map((group) => group.scenes),
  );
});

test("different legacy captions remain individually editable while matching variants merge", () => {
  const different = validatePetSettings({
    petDialogueVersion: 2,
    petDialogues: {
      loading: { title: "读取自定义" },
      analyzing: { title: "分析自定义" },
      asr: { title: "分析自定义" },
    },
  });
  const groups = petDialogueGroups(different);
  assert.equal(groups.length, 8);
  assert.deepEqual(groups.find((group) => group.id === "analyzing").scenes, ["analyzing", "asr"]);
  assert.deepEqual(groups.find((group) => group.id === "loading").scenes, ["loading"]);
  assert.equal(different.petDialogues.loading.title, "读取自定义");
});

function fixture(t, save = async () => {}) {
  const dom = new JSDOM('<body><div id="settings"></div></body>', { pretendToBeVisual: true });
  const { window } = dom;
  const container = window.document.getElementById("settings");
  const listeners = new Map();
  const original = window.EventTarget.prototype.addEventListener;
  // Test-only trusted input and canvas stand-ins; production uses native browser events/canvas.
  window.EventTarget.prototype.addEventListener = function (type, callback, options) {
    if (!listeners.has(this)) {
      listeners.set(this, new Map());
    }
    listeners.get(this).set(type, callback);
    return original.call(this, type, callback, options);
  };
  const draws = [];
  window.HTMLCanvasElement.prototype.getContext = () => ({
    clearRect() {},
    drawImage: (...args) => draws.push(args),
  });
  window.HTMLCanvasElement.prototype.toDataURL = () => imageData;
  window.HTMLCanvasElement.prototype.setPointerCapture = () => {};
  window.HTMLCanvasElement.prototype.releasePointerCapture = () => {};
  const revoked = [];
  let imageId = 0;
  window.URL.createObjectURL = () => `blob:test-${++imageId}`;
  window.URL.revokeObjectURL = (url) => revoked.push(url);
  window.Image = class {
    naturalWidth = 1024;
    naturalHeight = 512;
    async decode() {}
  };
  // Test-only metadata stand-in; browser tests verify actual MP3 decoding.
  window.Audio = class extends window.EventTarget {
    duration = 0.24;
    set src(_value) {
      queueMicrotask(() => this.dispatchEvent(new window.Event("loadedmetadata")));
    }
    removeAttribute() {}
    load() {}
  };
  window.confirm = () => true;
  const patches = [];
  const binding = bindPetSettings(container, {
    save: async (patch) => {
      patches.push(patch);
      return save(patch);
    },
    assets: { enabled: true, image: imageData, soundName: "测试音效" },
  });
  binding.load({});
  const get = (id) => container.querySelector(`#pet-${id}`);
  const emit = (id, type, fields = {}) =>
    listeners.get(get(id))?.get(type)?.({
      isTrusted: true,
      preventDefault() {},
      stopPropagation() {},
      ...fields,
    });
  const upload = async () => {
    Object.defineProperty(get("image-file"), "files", {
      configurable: true,
      value: [{ type: "image/png", size: 1000 }],
    });
    await emit("image-file", "change");
  };
  t.after(() => {
    binding.destroy();
    window.close();
  });
  return { window, binding, get, emit, upload, patches, revoked, draws };
}

test("pet settings render every scene, preview safe text and save trusted field-scoped edits", async (t) => {
  const f = fixture(t);
  assert.equal(f.get("enabled").checked, true);
  assert.equal(f.get("scene").options.length, PET_DIALOGUE_GROUPS.length);
  f.get("mirror").checked = true;
  await f.emit("mirror", "change", { isTrusted: false });
  assert.equal(f.patches.length, 0);
  await f.emit("mirror", "change");
  assert.deepEqual(f.patches[0], { petMirror: true });
  assert.equal(f.get("image-preview").style.transform, "scaleX(-1)");
  f.get("scene").value = "skip";
  await f.emit("scene", "change");
  assert.equal(f.get("detail"), null);
  f.get("title").value = "<img src=x> 已跳 {seconds} 秒";
  await f.emit("title", "input");
  assert.equal(f.get("preview-title").querySelector("img"), null);
  assert.match(f.get("preview-title").textContent, /35\.7 秒/);
  await f.emit("title", "change");
  assert.equal(f.patches[1].petDialogues.skip.title, f.get("title").value);
  f.get("title").value = "{peak}";
  await f.emit("title", "change");
  assert.equal(f.patches.length, 2);
  assert.match(f.get("save-status").textContent, /占位符/);
  await f.emit("reset-scene", "click");
  assert.deepEqual(f.patches.at(-1), { petDialogues: {} });
  assert.equal(f.get("title").value, PET_DIALOGUES.skip.title);
});

test("failed pet saves survive unrelated success and retry only outstanding fields", async (t) => {
  let fail = true;
  const f = fixture(t, async (patch) => {
    if (fail && Object.hasOwn(patch, "petMirror")) {
      throw new Error("storage failed");
    }
  });
  f.get("mirror").checked = true;
  await f.emit("mirror", "change");
  f.get("volume").value = 35;
  await f.emit("volume", "change");
  assert.equal(f.get("retry-save").hidden, false);
  assert.match(f.get("save-status").textContent, /待保存/);
  f.binding.load({ petMirror: false, petVolume: 90 });
  assert.equal(f.get("mirror").checked, true);
  fail = false;
  await f.emit("retry-save", "click");
  assert.deepEqual(f.patches.at(-1), { petMirror: true });
  assert.equal(f.get("retry-save").hidden, true);
});

test("editing and restoring a merged dialogue affects every linked scene", async (t) => {
  const f = fixture(t);
  for (const group of PET_DIALOGUE_GROUPS.filter((group) => group.scenes.length > 1)) {
    f.get("scene").value = group.scenes[0];
    await f.emit("scene", "change");
    f.get("title").value = "合并编辑测试";
    await f.emit("title", "change");
    const patch = f.patches.at(-1).petDialogues;
    for (const scene of group.scenes) {
      assert.equal(patch[scene].title, "合并编辑测试");
    }
    await f.emit("reset-scene", "click");
    for (const scene of group.scenes) {
      assert.equal(f.patches.at(-1).petDialogues[scene], undefined);
    }
    assert.equal(f.get("title").value, group.title);
  }
});

test("a completing grouped save preserves a newer unsaved textarea draft", async (t) => {
  const gate = deferred();
  const f = fixture(t, () => gate.promise);
  f.get("scene").value = "loading";
  await f.emit("scene", "change");
  f.get("title").value = "正在保存的台词";
  const pending = f.emit("title", "change");
  await flush();
  f.get("title").value = "继续编辑的草稿";
  await f.emit("title", "input");
  gate.resolve();
  await pending;
  assert.equal(f.get("title").value, "继续编辑的草稿");
});

test("settings editor loads old captions into one textarea and saves the migrated scene", async (t) => {
  const f = fixture(t);
  f.binding.load({ petDialogues: { idle: { title: "你好", detail: "陪你一起看" } } });
  assert.equal(f.get("title").tagName, "TEXTAREA");
  assert.equal(f.get("title").maxLength, 160);
  assert.equal(f.get("title").value, "你好\n陪你一起看");
  assert.equal(f.get("detail"), null);
  assert.equal(f.get("preview-detail"), null);
  f.get("title").value += "～";
  await f.emit("title", "change");
  assert.deepEqual(f.patches.at(-1), { petDialogues: { idle: { title: "你好\n陪你一起看～" } } });
});

test("audio uploader saves a field-scoped local clip and restores the default pair", async (t) => {
  const f = fixture(t);
  Object.defineProperty(f.get("audio-file"), "files", {
    configurable: true,
    value: [
      {
        name: "我的点击.mp3",
        type: "audio/mpeg",
        size: audioBytes.length,
        arrayBuffer: async () => Uint8Array.from(audioBytes).buffer,
      },
    ],
  });
  await f.emit("audio-file", "change", { isTrusted: false });
  assert.equal(f.patches.length, 0);
  await f.emit("audio-file", "change");
  const patch = f.patches[0];
  assert.deepEqual(Object.keys(patch).sort(), ["petAudio", "petAudioName"]);
  assert.equal(patch.petAudio, `data:audio/mpeg;base64,${audioBytes.toString("base64")}`);
  assert.equal(patch.petAudioName, "我的点击.mp3");
  assert.match(f.get("sound-name").textContent, /我的点击.mp3/);
  assert.equal(f.revoked.length, 1);
  await f.emit("audio-reset", "click");
  assert.deepEqual(f.patches.at(-1), { petAudio: "", petAudioName: "" });
  assert.match(f.get("sound-name").textContent, /测试音效/);
});

test("reset during audio decoding cancels the old upload and preserves defaults", async (t) => {
  const f = fixture(t);
  f.window.Audio = class extends f.window.EventTarget {
    set src(_value) {}
    removeAttribute() {}
    load() {}
  };
  Object.defineProperty(f.get("audio-file"), "files", {
    value: [
      {
        name: "delayed.mp3",
        type: "audio/mpeg",
        size: audioBytes.length,
        arrayBuffer: async () => Uint8Array.from(audioBytes).buffer,
      },
    ],
  });
  const pending = f.emit("audio-file", "change");
  await flush();
  await f.emit("audio-reset", "click");
  await pending;
  assert.deepEqual(f.patches, [{ petAudio: "", petAudioName: "" }]);
  assert.equal(f.revoked.length, 1);
});

test("cache captions are retired from every version and absent from the settings editor", (t) => {
  const f = fixture(t);
  for (const petDialogueVersion of [1, 2, 3, 4]) {
    const original = {
      petDialogueVersion,
      petVolume: 25,
      petDialogues: {
        shared: { title: "旧共享提示" },
        local: { title: "旧本地提示" },
        idle: { title: "保留待机" },
      },
    };
    const settings = validatePetSettings(original);
    assert.equal(settings.petDialogueVersion, 4);
    assert.equal(settings.petVolume, 25);
    assert.equal(settings.petDialogues.shared, undefined);
    assert.equal(settings.petDialogues.local, undefined);
    assert.match(settings.petDialogues.idle.title, /保留待机/);
    assert.equal(original.petDialogues.shared.title, "旧共享提示");
    f.binding.load(settings);
    assert.equal(f.get("scene").options.length, 7);
    assert.ok(
      [...f.get("scene").options].every(
        (option) => !["local", "shared", "cache"].includes(option.value),
      ),
    );
    assert.doesNotMatch(f.get("scene").textContent, /缓存命中|本地缓存|共享缓存/);
  }
});

test("a newer successful field value supersedes an older queued failure", async (t) => {
  const gate = deferred();
  let calls = 0;
  const f = fixture(t, () => (++calls === 1 ? gate.promise : undefined));
  f.get("volume").value = 10;
  const first = f.emit("volume", "change");
  await flush();
  f.get("volume").value = 50;
  const second = f.emit("volume", "change");
  gate.reject(new Error("older write failed"));
  await Promise.all([first, second]);
  assert.equal(f.get("retry-save").hidden, true);
  assert.equal(f.get("save-status").textContent, "已自动保存");
  assert.deepEqual(f.patches, [{ petVolume: 10 }, { petVolume: 50 }]);
});

test("local upload crops to 512 PNG, releases previews and handles cancel/reset", async (t) => {
  const f = fixture(t);
  await f.upload();
  assert.equal(f.get("crop-dialog").hidden, false);
  assert.deepEqual(f.draws.at(-1).slice(1), [0, 64, 256, 128]);
  f.get("crop-zoom").value = 2;
  await f.emit("crop-zoom", "input");
  await f.emit("crop-save", "click");
  assert.deepEqual(f.draws.at(-1).slice(1), [-256, 0, 1024, 512]);
  assert.equal(f.patches.at(-1).petImage, imageData);
  assert.equal(f.get("crop-dialog").hidden, true);
  assert.equal(f.revoked.length, 1);
  await f.upload();
  await f.emit("crop-cancel", "click");
  assert.equal(f.revoked.length, 2);
  await f.emit("image-reset", "click");
  assert.deepEqual(f.patches.at(-1), { petImage: "" });
});

test("saving an older crop preserves a newer upload and teardown stops queued writes", async (t) => {
  const gate = deferred();
  const f = fixture(t, () => gate.promise);
  await f.upload();
  const saving = f.emit("crop-save", "click");
  await flush();
  await f.upload();
  gate.resolve();
  await saving;
  assert.equal(f.get("crop-dialog").hidden, false);
  f.binding.destroy();
  assert.equal(f.revoked.length, 2);
  f.get("volume").value = 20;
  await f.emit("volume", "change");
  assert.equal(f.patches.length, 1);
});
