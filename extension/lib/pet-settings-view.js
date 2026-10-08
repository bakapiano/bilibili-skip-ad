import {
  DEFAULT_PET_SETTINGS,
  PET_DIALOGUES,
  PET_TEXT_LIMITS,
  validatePetSettings,
  petDialogueGroups,
} from "./pet-config.js";
import { CROP_SIZE, CROP_OUTPUT_SIZE, cropLayout, readCropImage } from "./pet-crop.js";
import { readPetAudio } from "./pet-audio.js";

export function bindPetSettings(container, { save, assets = globalThis.BiliSkipPetAssets } = {}) {
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  const lifetime = new view.AbortController();
  // Repository-owned structure. All editable captions and image data are assigned as properties.
  container.innerHTML = `
    <div class="pet-preferences">
      <p class="pet-hint">设置保存在本机，修改后自动同步到已打开的视频页。</p>
      <label class="pet-switch"><input id="pet-enabled" type="checkbox" role="switch" /><span>显示宠物</span></label>
      <label class="pet-switch"><input id="pet-mirror" type="checkbox" role="switch" /><span>左右翻转，默认放到左下角</span></label>
      <label class="pet-switch"><input id="pet-sound" type="checkbox" role="switch" /><span>点击音效</span></label>
      <p id="pet-sound-name" class="pet-hint"></p>
      <label class="pet-volume" for="pet-volume">音量 <input id="pet-volume" type="range" min="0" max="100" step="1" /><output id="pet-volume-label"></output></label>
      <div class="pet-audio-upload">
        <label class="pet-upload" for="pet-audio-file">上传点击音频</label><input id="pet-audio-file" type="file" accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,.mp3,.wav,.ogg,.m4a" />
        <button id="pet-audio-reset" type="button">恢复默认音效</button>
        <p class="pet-hint">MP3、WAV、OGG、M4A，最大 1 MiB、10 秒。音频仅保存在本机，上传后点击宠物试听。</p>
      </div>
      <div class="pet-appearance">
        <div class="pet-image-frame"><img id="pet-image-preview" alt="当前宠物图片" /></div>
        <div><h3>角色图片</h3><p class="pet-hint">PNG、JPEG、WebP，原图最大 10 MiB。拖动与缩放后保存为透明 PNG，图片仅在本机处理。</p>
          <label class="pet-upload" for="pet-image-file">上传并裁剪图片</label><input id="pet-image-file" type="file" accept="image/png,image/jpeg,image/webp" />
          <button id="pet-image-reset" type="button">恢复默认图片</button>
        </div>
      </div>
      <div id="pet-crop-dialog" class="pet-crop" role="dialog" aria-label="裁剪宠物图片" hidden>
        <h3>拖动图片调整位置</h3><canvas id="pet-crop-canvas" width="256" height="256" aria-label="裁剪预览，使用下方滑块也可调整位置"></canvas>
        <label for="pet-crop-zoom">缩放 <input id="pet-crop-zoom" type="range" min="1" max="4" step="0.01" value="1" /></label>
        <label for="pet-crop-x">水平位置 <input id="pet-crop-x" type="range" min="-384" max="384" step="1" value="0" /></label>
        <label for="pet-crop-y">垂直位置 <input id="pet-crop-y" type="range" min="-384" max="384" step="1" value="0" /></label>
        <div class="pet-actions"><button id="pet-crop-save" type="button">使用这张图片</button><button id="pet-crop-fit" type="button">完整显示</button><button id="pet-crop-cancel" type="button">取消</button></div>
      </div>
      <div class="pet-dialogue-editor">
        <h3>气泡台词</h3><label for="pet-scene">触发场景</label><select id="pet-scene"></select>
        <p id="pet-tokens" class="pet-hint"></p>
        <label for="pet-title">标题台词（最多 160 字，可换行）</label><textarea id="pet-title" rows="3" maxlength="160"></textarea>
        <div class="pet-dialogue-preview" aria-label="文案示例预览"><strong id="pet-preview-title"></strong></div>
        <div class="pet-actions"><button id="pet-reset-scene" type="button">恢复本场景</button><button id="pet-reset-dialogues" type="button">恢复全部台词</button></div>
        <label for="pet-panel-label">面板按钮文字</label><input id="pet-panel-label" type="text" maxlength="12" />
      </div>
      <div class="pet-save-state"><span id="pet-save-status" role="status">正在读取宠物设置…</span><button id="pet-retry-save" type="button" hidden>重试保存</button></div>
    </div>`;
  const get = (id) => container.querySelector(`#${id}`);
  let current = { ...DEFAULT_PET_SETTINGS };
  let ready = false;
  let sceneGroups = [];
  let pending = 0;
  let revision = 0;
  let tail = Promise.resolve();
  const failedFields = new Map();
  const fieldRevisions = new Map();
  let crop;
  let cropRevision = 0;
  let dragging;
  let audioUpload;
  const on = (id, type, fn) =>
    get(id).addEventListener(
      type,
      (event) => {
        if (!event.isTrusted || lifetime.signal.aborted) {
          return;
        }
        if (type === "click") {
          event.preventDefault();
        }
        try {
          return Promise.resolve(fn(event)).catch((error) => status(error.message, true));
        } catch (error) {
          status(error.message, true);
        }
      },
      { signal: lifetime.signal },
    );
  function status(text, error = false) {
    if (!lifetime.signal.aborted) {
      get("pet-save-status").textContent = text;
      get("pet-save-status").classList.toggle("error", error);
      get("pet-retry-save").hidden = !failedFields.size;
    }
  }
  function preview() {
    const sample = (text) =>
      text.replace(
        /\{(seconds|cost)\}/g,
        (_, token) => ({ seconds: "35.7", cost: "0.00075476" })[token],
      );
    get("pet-preview-title").textContent = sample(get("pet-title").value);
  }
  function showScene() {
    const scene = get("pet-scene").value;
    const defaults = PET_DIALOGUES[scene];
    const custom = current.petDialogues[scene] || {};
    get("pet-title").value = custom.title ?? defaults.title;
    get("pet-tokens").textContent = defaults.tokens?.length
      ? `可用占位符：${defaults.tokens.map((token) => `{${token}}`).join("、")}，会自动替换为本次实际数值。`
      : "这个场景可直接填写你喜欢的文字。";
    preview();
  }
  function refreshSceneGroups() {
    const previous = get("pet-scene").value;
    sceneGroups = petDialogueGroups(current);
    get("pet-scene").replaceChildren();
    for (const group of sceneGroups) {
      const option = doc.createElement("option");
      option.value = group.id;
      option.textContent = group.label;
      get("pet-scene").append(option);
    }
    get("pet-scene").value =
      sceneGroups.find((group) => group.scenes.includes(previous))?.id || sceneGroups[0].id;
  }
  function showAppearance() {
    get("pet-image-preview").src = current.petImage || assets.image;
    get("pet-image-preview").style.transform = current.petMirror ? "scaleX(-1)" : "none";
    get("pet-volume-label").textContent = `${current.petVolume}%`;
    const soundName = current.petAudio ? current.petAudioName || "自定义音频" : assets.soundName;
    get("pet-sound-name").textContent =
      `当前音效：${soundName}。完成单击后播放，拖动用于调整位置。`;
  }
  async function persist(patch) {
    if (!ready) {
      return;
    }
    const checked = validatePetSettings({ ...current, ...patch });
    current = { ...current, ...checked };
    const attempt = ++revision;
    pending++;
    for (const field of Object.keys(patch)) {
      fieldRevisions.set(field, attempt);
      failedFields.delete(field);
    }
    showAppearance();
    status("正在保存…");
    const task = tail.then(() => {
      if (!lifetime.signal.aborted) {
        return save(patch);
      }
    });
    tail = task.catch(() => {});
    try {
      await task;
      if (attempt === revision) {
        status("已自动保存");
      }
    } catch (error) {
      // Only the latest value of each field is retryable; unrelated failures remain queued.
      for (const [field, value] of Object.entries(patch)) {
        if (fieldRevisions.get(field) === attempt) {
          failedFields.set(field, value);
        }
      }
      status(error.message || "保存未完成，请重试。", true);
      throw error;
    } finally {
      pending--;
      if (failedFields.size) {
        status("部分宠物设置待保存，请重试。", true);
      }
    }
  }
  function closeCrop() {
    cropRevision++;
    crop?.release();
    crop = undefined;
    if (dragging) {
      get("pet-crop-canvas").releasePointerCapture?.(dragging.pointer);
    }
    dragging = undefined;
    get("pet-crop-dialog").hidden = true;
    get("pet-image-file").value = "";
  }
  function drawCrop() {
    if (!crop) {
      return;
    }
    const layout = cropLayout(
      crop.image.naturalWidth,
      crop.image.naturalHeight,
      Number(get("pet-crop-zoom").value),
      Number(get("pet-crop-x").value),
      Number(get("pet-crop-y").value),
    );
    get("pet-crop-x").value = layout.offsetX;
    get("pet-crop-y").value = layout.offsetY;
    const ctx = get("pet-crop-canvas").getContext("2d");
    ctx.clearRect(0, 0, CROP_SIZE, CROP_SIZE);
    ctx.drawImage(crop.image, layout.x, layout.y, layout.width, layout.height);
    return layout;
  }
  for (const [id, field] of [
    ["pet-enabled", "petEnabled"],
    ["pet-mirror", "petMirror"],
    ["pet-sound", "petSound"],
  ]) {
    on(id, "change", () => persist({ [field]: get(id).checked }));
  }
  on("pet-volume", "input", () => {
    get("pet-volume-label").textContent = `${get("pet-volume").value}%`;
  });
  on("pet-volume", "change", () => persist({ petVolume: Number(get("pet-volume").value) }));
  on("pet-audio-file", "change", async () => {
    const file = get("pet-audio-file").files?.[0];
    if (!file) {
      return;
    }
    audioUpload?.abort();
    const upload = new view.AbortController();
    audioUpload = upload;
    status("正在读取本机音频…");
    try {
      const patch = await readPetAudio(file, view, upload.signal);
      if (audioUpload === upload && !lifetime.signal.aborted) {
        await persist(patch);
      }
    } catch (error) {
      if (!upload.signal.aborted) {
        throw error;
      }
    } finally {
      if (audioUpload === upload) {
        audioUpload = undefined;
        get("pet-audio-file").value = "";
      }
    }
  });
  on("pet-audio-reset", "click", () => {
    audioUpload?.abort();
    audioUpload = undefined;
    get("pet-audio-file").value = "";
    return persist({ petAudio: "", petAudioName: "" });
  });
  on("pet-panel-label", "change", () => persist({ petPanelLabel: get("pet-panel-label").value }));
  on("pet-scene", "change", showScene);
  for (const field of Object.keys(PET_TEXT_LIMITS)) {
    on(`pet-${field}`, "input", preview);
    on(`pet-${field}`, "change", () => {
      const scene = get("pet-scene").value;
      const group = sceneGroups.find((group) => group.id === scene);
      const text = get(`pet-${field}`).value;
      return persist({
        petDialogues: {
          ...current.petDialogues,
          ...Object.fromEntries(group.scenes.map((member) => [member, { [field]: text }])),
        },
      }).then(() => {
        if (lifetime.signal.aborted) {
          return;
        }
        const unchanged = get("pet-title").value === text;
        refreshSceneGroups();
        if (unchanged) {
          showScene();
        }
      });
    });
  }
  on("pet-reset-scene", "click", async () => {
    const dialogues = { ...current.petDialogues };
    for (const scene of sceneGroups.find((group) => group.id === get("pet-scene").value).scenes) {
      delete dialogues[scene];
    }
    await persist({ petDialogues: dialogues });
    refreshSceneGroups();
    showScene();
  });
  on("pet-reset-dialogues", "click", async () => {
    if (view.confirm("恢复全部气泡台词为默认内容？")) {
      await persist({ petDialogues: {} });
      refreshSceneGroups();
      showScene();
    }
  });
  on("pet-image-reset", "click", () => persist({ petImage: "" }));
  on(
    "pet-retry-save",
    "click",
    () => failedFields.size && persist(Object.fromEntries(failedFields)),
  );
  on("pet-image-file", "change", async () => {
    const file = get("pet-image-file").files?.[0];
    if (!file) {
      return;
    }
    closeCrop();
    const attempt = cropRevision;
    const decoded = await readCropImage(file, view);
    if (attempt !== cropRevision || lifetime.signal.aborted) {
      decoded.release();
      return;
    }
    crop = decoded;
    get("pet-crop-zoom").value = 1;
    get("pet-crop-x").value = 0;
    get("pet-crop-y").value = 0;
    get("pet-crop-dialog").hidden = false;
    drawCrop();
    get("pet-crop-zoom").focus();
  });
  for (const id of ["pet-crop-zoom", "pet-crop-x", "pet-crop-y"]) {
    on(id, "input", drawCrop);
  }
  on("pet-crop-fit", "click", () => {
    get("pet-crop-zoom").value = 1;
    get("pet-crop-x").value = 0;
    get("pet-crop-y").value = 0;
    drawCrop();
  });
  on("pet-crop-cancel", "click", () => {
    closeCrop();
    get("pet-image-file").focus();
  });
  on("pet-crop-dialog", "keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeCrop();
    }
  });
  on("pet-crop-save", "click", async () => {
    if (!crop) {
      return;
    }
    const canvas = doc.createElement("canvas");
    const attempt = cropRevision;
    canvas.width = CROP_OUTPUT_SIZE;
    canvas.height = CROP_OUTPUT_SIZE;
    const layout = drawCrop();
    const ratio = CROP_OUTPUT_SIZE / CROP_SIZE;
    canvas
      .getContext("2d")
      .drawImage(
        crop.image,
        layout.x * ratio,
        layout.y * ratio,
        layout.width * ratio,
        layout.height * ratio,
      );
    await persist({ petImage: canvas.toDataURL("image/png") });
    if (attempt === cropRevision && !lifetime.signal.aborted) {
      closeCrop();
      get("pet-image-file").focus();
    }
  });
  on("pet-crop-canvas", "pointerdown", (event) => {
    if (!crop || event.button !== 0) {
      return;
    }
    const canvas = get("pet-crop-canvas");
    event.preventDefault();
    dragging = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offsetX: Number(get("pet-crop-x").value),
      offsetY: Number(get("pet-crop-y").value),
    };
    canvas.setPointerCapture(event.pointerId);
  });
  on("pet-crop-canvas", "pointermove", (event) => {
    if (!dragging || event.pointerId !== dragging.pointer) {
      return;
    }
    const ratio = CROP_SIZE / get("pet-crop-canvas").getBoundingClientRect().width;
    get("pet-crop-x").value = dragging.offsetX + (event.clientX - dragging.x) * ratio;
    get("pet-crop-y").value = dragging.offsetY + (event.clientY - dragging.y) * ratio;
    drawCrop();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    on("pet-crop-canvas", type, () => {
      dragging = undefined;
    });
  }
  return {
    load(settings) {
      if (pending || failedFields.size || lifetime.signal.aborted) {
        return;
      }
      current = validatePetSettings(settings);
      get("pet-enabled").checked = current.petEnabled ?? assets.enabled;
      get("pet-mirror").checked = current.petMirror;
      get("pet-sound").checked = current.petSound;
      get("pet-volume").value = current.petVolume;
      get("pet-panel-label").value = current.petPanelLabel;
      refreshSceneGroups();
      showScene();
      showAppearance();
      ready = true;
      status("修改后自动保存");
    },
    destroy() {
      audioUpload?.abort();
      closeCrop();
      lifetime.abort();
    },
  };
}
