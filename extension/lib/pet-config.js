// Keep the former defaults to migrate existing per-scene overrides without losing user text.
const LEGACY_PET_DIALOGUES = Object.freeze({
  idle: { label: "待机", title: "我在这里陪你看", detail: "点我查看状态，拖动可以换位置" },
  loading: { label: "字幕与缓存", title: "正在查看字幕和缓存…", detail: "完成后告诉你本次消耗" },
  analyzing: { label: "识别中", title: "正在找恰饭片段…", detail: "完成后告诉你本次消耗" },
  asr: { label: "本地转写", title: "正在本地转写…", detail: "音频在你的电脑上处理" },
  done: {
    label: "识别完成 · 用量已知",
    title: "识别完成啦",
    detail: "本次约 ¥{offPeak}～{peak}\n空闲／高峰参考价",
    tokens: ["offPeak", "peak"],
  },
  doneUnknown: {
    label: "识别完成 · 用量待确认",
    title: "识别完成啦",
    detail: "本次费用待确认\n空闲／高峰参考价",
  },
  shared: {
    label: "共享缓存",
    title: "找到共享结果啦",
    detail: "本次模型费用 ¥0 · 已复用广告标记",
  },
  local: { label: "本地缓存", title: "本地已经记住啦", detail: "本次模型费用 ¥0 · 已复用广告标记" },
  record: { label: "标记就绪", title: "广告标记已就绪", detail: "点开面板查看识别结果" },
  exempt: {
    label: "短视频豁免",
    title: "这个视频直接看",
    detail: "已按短视频设置豁免，本次模型费用 ¥0",
  },
  skip: {
    label: "自动跳过",
    title: "帮你跳过恰饭啦",
    detail: "已跳过 {seconds} 秒，继续看吧～",
    tokens: ["seconds"],
  },
  error: { label: "页面异常", title: "这次需要看一下", detail: "点开面板查看详情；本次费用待确认" },
  errorWithUsage: {
    label: "任务异常 · 用量已知",
    title: "这次需要看一下",
    detail: "本次约 ¥{offPeak}～{peak}",
    tokens: ["offPeak", "peak"],
  },
  errorUnknown: {
    label: "任务异常 · 用量待确认",
    title: "这次需要看一下",
    detail: "本次费用待确认",
  },
});

const V2_TITLE_DEFAULTS = {
  asr: "正在本地转写…\n音频在你的电脑上处理",
  done: "识别完成啦\n本次约 ¥{offPeak}～{peak}\n空闲／高峰参考价",
  doneUnknown: "识别完成啦\n本次费用待确认",
  shared: "找到共享结果啦\n本次模型费用 ¥0",
  local: "本地已经记住啦\n本次模型费用 ¥0",
  exempt: "这个视频直接看\n本次模型费用 ¥0",
  skip: "帮你跳过恰饭啦\n已跳过 {seconds} 秒",
  error: "这次需要看一下\n本次费用待确认",
  errorWithUsage: "这次需要看一下\n本次约 ¥{offPeak}～{peak}",
  errorUnknown: "这次需要看一下\n本次费用待确认",
};
export const PET_DIALOGUE_VERSION = 4;
export const PET_DIALOGUE_GROUPS = Object.freeze([
  { label: "待机", scenes: ["idle"], title: "好模型..." },
  {
    label: "寻找恰饭片段 · 字幕 / 识别 / 本地转写",
    scenes: ["loading", "analyzing", "asr"],
    title: "恰饭片段寻找中...",
  },
  {
    label: "识别完成 · 本次费用",
    scenes: ["done"],
    title: "大肥鱼吃了你 ¥{cost}",
    tokens: ["cost"],
  },
  { label: "标记就绪", scenes: ["record"], title: "恰饭片段已定位！" },
  {
    label: "自动跳过",
    scenes: ["skip"],
    title: "跳过 {seconds} 秒恰饭片段~ 吃点白饭不过分吧！",
    tokens: ["seconds"],
  },
  {
    label: "报错",
    scenes: ["error", "errorWithUsage", "errorUnknown"],
    title: "搞不定啦！打开面板自己看一下~",
  },
  { label: "留空 · 用量待确认 / 短视频豁免", scenes: ["doneUnknown", "exempt"], title: "" },
]);
export const PET_DIALOGUES = Object.freeze(
  Object.fromEntries(
    PET_DIALOGUE_GROUPS.flatMap(({ scenes, title, tokens }) =>
      scenes.map((scene) => [
        scene,
        { label: LEGACY_PET_DIALOGUES[scene].label, title, ...(tokens ? { tokens } : {}) },
      ]),
    ),
  ),
);

export function petDialogueGroups(settings) {
  return PET_DIALOGUE_GROUPS.flatMap((group) => {
    const variants = new Map();
    for (const scene of group.scenes) {
      const title = settings.petDialogues?.[scene]?.title ?? group.title;
      if (!variants.has(title)) {
        variants.set(title, []);
      }
      variants.get(title).push(scene);
    }
    // Keep differing legacy overrides separately editable until the user gives them the same text.
    return [...variants.values()].map((scenes) => ({
      id: scenes[0],
      scenes,
      label:
        variants.size === 1
          ? group.label
          : scenes.map((scene) => PET_DIALOGUES[scene].label).join(" / "),
    }));
  });
}

function migrateCostTitle(title) {
  return title
    .replace(/\{offPeak\}\s*[～~–—/－-]\s*¥?\{peak\}/g, "{cost}")
    .replace(/\{(?:offPeak|peak)\}/g, "{cost}")
    .replace(/\n空闲／高峰参考价/g, "");
}

export const DEFAULT_PET_SETTINGS = Object.freeze({
  // null follows the build preset: regular packages start off, explicit preview builds start on.
  petEnabled: null,
  petMirror: false,
  petSound: true,
  petVolume: 10,
  petAudio: "",
  petAudioName: "",
  petImage: "",
  petPanelLabel: "打开面板",
  petDialogueVersion: PET_DIALOGUE_VERSION,
  petDialogues: Object.freeze({}),
});
export const MAX_PET_IMAGE_BYTES = 1024 * 1024;
export const MAX_PET_AUDIO_BYTES = 1024 * 1024;
export const MAX_PET_AUDIO_SECONDS = 10;
export const PET_TEXT_LIMITS = Object.freeze({ title: 160 });
const PNG_PREFIX = "data:image/png;base64,";
const fail = (condition, message) => {
  if (!condition) {
    throw Object.assign(new Error(message), { code: "SETTINGS" });
  }
};

export function validatePetSettings(input, check = fail) {
  const value = { ...DEFAULT_PET_SETTINGS, ...input };
  const dialogueVersion = input?.petDialogueVersion ?? 1;
  check([1, 2, 3, PET_DIALOGUE_VERSION].includes(dialogueVersion), "气泡文案版本异常。");
  check(value.petEnabled === null || typeof value.petEnabled === "boolean", "宠物开关格式异常。");
  for (const name of ["petMirror", "petSound"]) {
    check(typeof value[name] === "boolean", "宠物设置项格式异常。");
  }
  check(
    Number.isInteger(value.petVolume) && value.petVolume >= 0 && value.petVolume <= 100,
    "宠物音量应介于 0 和 100 之间。",
  );
  check(
    typeof value.petPanelLabel === "string" &&
      value.petPanelLabel.trim().length > 0 &&
      value.petPanelLabel.length <= 12,
    "面板按钮文字请填写 1 至 12 个字符。",
  );
  check(typeof value.petImage === "string", "请选择本机图片并完成裁剪。");
  check(
    typeof value.petAudioName === "string" && value.petAudioName.length <= 100,
    "音频名称最多 100 字。",
  );
  validatePetAudio(value.petAudio, check);
  if (value.petImage) {
    check(
      value.petImage.length <= Math.ceil(MAX_PET_IMAGE_BYTES / 3) * 4 + PNG_PREFIX.length,
      "裁剪后的图片应小于 1 MiB。",
    );
    check(
      /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.petImage),
      "图片应为裁剪后的 PNG 数据。",
    );
    const encoded = value.petImage.slice(PNG_PREFIX.length);
    const byteLength =
      Math.floor((encoded.length * 3) / 4) - (encoded.match(/=+$/)?.[0].length || 0);
    check(encoded.length % 4 === 0 && byteLength <= MAX_PET_IMAGE_BYTES, "PNG 图片数据长度异常。");
    const header = atob(encoded.slice(0, 44));
    check(
      header.length >= 33 &&
        header.slice(0, 8) === "\x89PNG\r\n\x1a\n" &&
        header.slice(8, 12) === "\x00\x00\x00\x0d" &&
        header.slice(12, 16) === "IHDR",
      "PNG 图片头异常。",
    );
    const size = (offset) =>
      [0, 1, 2, 3].reduce((n, i) => n * 256 + header.charCodeAt(offset + i), 0);
    check(
      [size(16), size(20)].every((n) => n > 0 && n <= 1024),
      "裁剪图片的宽高应在 1 至 1024 像素之间。",
    );
  }
  check(
    value.petDialogues &&
      typeof value.petDialogues === "object" &&
      !Array.isArray(value.petDialogues),
    "气泡文案格式异常。",
  );
  const dialogues = {};
  for (const [scene, fields] of Object.entries(value.petDialogues)) {
    // Cache hits are always silent; drop retired overrides from saved settings and older open tabs.
    if (scene === "shared" || scene === "local") {
      continue;
    }
    check(Object.hasOwn(PET_DIALOGUES, scene), "气泡场景异常。");
    check(fields && typeof fields === "object" && !Array.isArray(fields), "气泡文案格式异常。");
    // A legacy settings tab may still submit a detail field after the extension updates.
    const legacy = dialogueVersion === 1 || Object.hasOwn(fields, "detail");
    const limits = legacy ? { title: 24, detail: 120 } : PET_TEXT_LIMITS;
    for (const [field, text] of Object.entries(fields)) {
      check(
        Object.hasOwn(limits, field) && typeof text === "string" && text.length <= limits[field],
        legacy ? "旧版标题最多 24 字，说明最多 120 字。" : "气泡标题最多 160 字，可换行。",
      );
      for (const token of text.matchAll(/\{([^{}]+)\}/g)) {
        const tokens =
          dialogueVersion < 3 || legacy
            ? [
                ...(LEGACY_PET_DIALOGUES[scene].tokens || []),
                ...(PET_DIALOGUES[scene].tokens || []),
              ]
            : PET_DIALOGUES[scene].tokens;
        check(tokens?.includes(token[1]), "请使用当前场景列出的占位符。");
      }
    }
    if (legacy) {
      const defaults = LEGACY_PET_DIALOGUES[scene];
      const title = fields.title ?? defaults.title;
      const detail = fields.detail ?? defaults.detail;
      if (title !== defaults.title || detail !== defaults.detail) {
        dialogues[scene] = { title: [title, detail].filter(Boolean).join("\n") };
      }
    } else {
      dialogues[scene] = Object.hasOwn(fields, "title") ? { title: fields.title } : {};
    }
    if (dialogueVersion < 3 || legacy) {
      const previousDefault = V2_TITLE_DEFAULTS[scene] ?? LEGACY_PET_DIALOGUES[scene].title;
      const oldTitle = dialogues[scene]?.title;
      if (scene.startsWith("error") || oldTitle === previousDefault) {
        delete dialogues[scene];
      } else if (typeof oldTitle === "string") {
        dialogues[scene] = { title: migrateCostTitle(oldTitle) };
        if (["恰饭片段寻找中...！", "大肥鱼吃了你 ¥{cost} ！"].includes(dialogues[scene].title)) {
          dialogues[scene].title = dialogues[scene].title.replace(/\s*！$/, "");
        }
        if (dialogues[scene].title === PET_DIALOGUES[scene].title) {
          delete dialogues[scene];
        }
      }
    }
  }
  return {
    ...Object.fromEntries(Object.keys(DEFAULT_PET_SETTINGS).map((key) => [key, value[key]])),
    petDialogueVersion: PET_DIALOGUE_VERSION,
    petDialogues: dialogues,
  };
}

export function validatePetAudio(data, check = fail) {
  check(typeof data === "string", "请选择本机音频文件。");
  if (!data) {
    return;
  }
  check(data.length <= Math.ceil(MAX_PET_AUDIO_BYTES / 3) * 4 + 40, "音频文件最大 1 MiB。");
  const match = /^data:audio\/(mpeg|wav|ogg|mp4);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  check(Boolean(match), "请选择 MP3、WAV、OGG 或 M4A 音频。");
  const [, type, encoded] = match;
  const bytes = Math.floor((encoded.length * 3) / 4) - (encoded.match(/=+$/)?.[0].length || 0);
  check(
    encoded.length % 4 === 0 && bytes >= 12 && bytes <= MAX_PET_AUDIO_BYTES,
    "音频数据长度异常。",
  );
  const header = atob(encoded.slice(0, 44));
  const valid =
    type === "mpeg"
      ? header.startsWith("ID3") ||
        (header.charCodeAt(0) === 255 && (header.charCodeAt(1) & 224) === 224)
      : type === "wav"
        ? header.startsWith("RIFF") && header.slice(8, 12) === "WAVE"
        : type === "ogg"
          ? header.startsWith("OggS")
          : header.slice(4, 8) === "ftyp";
  check(valid, "音频内容与格式不匹配，请重新选择。");
}
