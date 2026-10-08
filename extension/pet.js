// Shared, optional UI. It subscribes to public state and never initiates model requests.
globalThis.BiliSkipPet = function createPet({ observe, openPanel, id = "biliskip-pet" }) {
  let pet;
  let render;
  const unsubscribe = observe((state) => {
    // The controller's startup snapshot contains placeholder settings until storage responds.
    const enabled =
      state.settingsReady !== false &&
      (state.settings?.petEnabled ?? globalThis.BiliSkipPetAssets?.enabled);
    if (enabled) {
      if (!pet) {
        pet = createPetView({
          openPanel,
          id,
          observe(listener) {
            render = listener;
            return () => {
              render = undefined;
            };
          },
        });
      }
      render(state);
    } else {
      pet?.destroy();
      pet = undefined;
    }
  });
  return {
    destroy() {
      unsubscribe();
      pet?.destroy();
      pet = undefined;
    },
  };
};

function createPetView({ observe, openPanel, id }) {
  const assets = globalThis.BiliSkipPetAssets;
  const lifetime = new AbortController();
  const project = globalThis.BiliSkipPetState();
  const host = document.createElement("div");
  host.id = id;
  host.className = "biliskip-pet";
  host.hidden = true;
  host.dataset.pressed = "false";
  const style = document.createElement("style");
  style.textContent = assets.css;
  const element = (tag, className, parent, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text) {
      node.textContent = text;
    }
    parent.append(node);
    return node;
  };
  const body = element("button", "biliskip-pet-body", host);
  body.type = "button";
  body.setAttribute("aria-label", "BiliSkip 小宠物：点击摸头、拖动或查看状态");
  const portrait = element("span", "biliskip-pet-portrait", body);
  const image = element("img", "biliskip-pet-image", portrait);
  image.src = assets.image;
  image.alt = "";
  image.draggable = false;
  const bubble = element("div", "biliskip-pet-bubble", host);
  bubble.hidden = true;
  bubble.setAttribute("role", "status");
  bubble.setAttribute("aria-live", "polite");
  // The bubble is a repository-owned SVG; dynamic status strings use textContent below.
  bubble.innerHTML = assets.bubble;
  const content = element("div", "biliskip-pet-bubble-content", bubble);
  const title = element("strong", "biliskip-pet-title", content);
  const open = element("button", "biliskip-pet-open", content);
  open.type = "button";
  const panelIcon = element("span", "biliskip-pet-panel-icon", open);
  panelIcon.setAttribute("aria-hidden", "true");
  panelIcon.innerHTML = assets.panelIcon;
  const panelLabel = element("span", "biliskip-pet-panel-label", open, "打开面板");
  const hide = element("button", "biliskip-pet-hide", host, "×");
  hide.type = "button";
  hide.setAttribute("aria-label", "本页隐藏小宠物，刷新恢复");
  host.prepend(style);
  document.body.append(host);
  let last;
  let displayed;
  let manualIdle = false;
  let dismissed = false;
  let timer;
  let drag;
  let dragged = false;
  let placement;
  let preferences = {};
  let currentImage;
  let mirrored;
  let patTimer;
  let audioContext;
  let audioBuffers;
  let audioGain;
  let audioSources = [];
  let soundRevision = 0;
  let viewportSignature = "";
  function availableWidth() {
    const root = document.documentElement;
    const width = Math.min(innerWidth, root.clientWidth || innerWidth);
    const scroller = document.scrollingElement || root;
    const scrollable = scroller.scrollHeight > (root.clientHeight || innerHeight);
    // clientWidth excludes classic scrollbars. Overlay scrollbars need an explicit reserved strip.
    // The extra 12px also contains the pet's horizontal press animation and shadow.
    const inset = width < innerWidth ? 12 : scrollable ? 24 : 0;
    return Math.max(0, width - inset);
  }
  function stopSound() {
    soundRevision++;
    for (const source of audioSources) {
      try {
        source.stop();
      } catch {
        /* A completed audio node is already stopped. */
      }
      source.disconnect();
    }
    audioSources = [];
    audioGain?.disconnect();
    audioGain = undefined;
  }
  function playSound() {
    stopSound();
    if (preferences.petSound === false || preferences.petVolume === 0 || !globalThis.AudioContext) {
      return;
    }
    const attempt = soundRevision;
    try {
      audioContext ||= new AudioContext();
      const resumed = audioContext.resume();
      audioBuffers ||= Promise.all(
        (preferences.petAudio ? [preferences.petAudio] : assets.sounds).map((url) => {
          const bytes = Uint8Array.from(atob(url.split(",")[1]), (letter) => letter.charCodeAt(0));
          return audioContext.decodeAudioData(bytes.buffer).then((buffer) => {
            if (
              !Number.isFinite(buffer.duration) ||
              buffer.duration <= 0 ||
              buffer.duration > (assets.audioMaxSeconds || 10)
            ) {
              throw new Error("Pet sound duration exceeds the playback limit");
            }
            return buffer;
          });
        }),
      );
      Promise.all([resumed, audioBuffers])
        .then(([, buffers]) => {
          if (attempt !== soundRevision || lifetime.signal.aborted || host.hidden) {
            return;
          }
          const gain = audioContext.createGain();
          audioGain = gain;
          gain.gain.value = (preferences.petVolume ?? 10) / 100;
          gain.connect(audioContext.destination);
          let when = audioContext.currentTime;
          for (const [index, buffer] of buffers.entries()) {
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(gain);
            source.onended = () => {
              source.disconnect();
              audioSources = audioSources.filter((active) => active !== source);
              if (index === buffers.length - 1) {
                gain.disconnect();
                if (audioGain === gain) {
                  audioGain = undefined;
                }
              }
            };
            source.start(when);
            audioSources.push(source);
            when += Math.max(0, buffer.duration - 0.04);
          }
        })
        .catch(() => {
          audioBuffers = undefined;
        });
    } catch {
      /* Optional click audio must not interrupt the player. */
    }
  }
  function pat() {
    clearTimeout(patTimer);
    host.dataset.pressed = "true";
    patTimer = setTimeout(() => {
      host.dataset.pressed = "false";
    }, 110);
  }
  function alignBubble() {
    if (host.hidden) {
      return;
    }
    const rect = host.getBoundingClientRect();
    const viewportWidth = availableWidth();
    const width = Math.min(260, Math.max(0, viewportWidth - 24));
    bubble.style.width = `${width}px`;
    // Measure natural text height before constraining very long multiline captions to the viewport.
    content.style.height = "auto";
    const naturalHeight = content.scrollHeight + 4;
    const height = Math.min(
      420,
      Math.max(0, innerHeight - 24),
      Math.max((width * 220) / 300, naturalHeight / 0.43),
    );
    content.style.height = "";
    const scrollable = naturalHeight > height * 0.43;
    content.style.overflowY = scrollable ? "auto" : "";
    content.style.justifyContent = scrollable ? "flex-start" : "";
    bubble.style.height = `${height}px`;
    // Caption direction follows available space, independently of the portrait's mirror setting.
    const rightFits = rect.left + 24 + width <= viewportWidth - 12;
    host.dataset.bubbleSide = rightFits ? "right" : "left";
    const preferred = rightFits ? 24 : rect.width - width - 24;
    const left = Math.max(
      12 - rect.left,
      Math.min(preferred, viewportWidth - 12 - rect.left - width),
    );
    const top = Math.max(
      12 - rect.top,
      Math.min(rect.height - 120 - height, innerHeight - 12 - rect.top - height),
    );
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  }
  function visibility() {
    const wasHidden = host.hidden;
    host.hidden = dismissed || !last?.visible || Boolean(document.fullscreenElement);
    host.dataset.paused = String(document.visibilityState !== "visible");
    if (host.hidden || document.visibilityState !== "visible") {
      stopSound();
    }
    if (wasHidden && !host.hidden) {
      updateViewport();
    }
  }
  function show() {
    clearTimeout(timer);
    if (!displayed?.title?.trim()) {
      bubble.hidden = true;
      manualIdle = false;
      return;
    }
    bubble.hidden = false;
    alignBubble();
    // A completed job can arrive mid-drag; give it a full display window after release.
    if (!displayed?.persistent && !drag) {
      timer = setTimeout(() => {
        bubble.hidden = true;
        manualIdle = false;
      }, 6000);
    }
  }
  function idleTitle() {
    return preferences.petDialogues?.idle?.title ?? assets.dialogues.idle.title;
  }
  function showIdle() {
    manualIdle = true;
    displayed = { title: idleTitle(), persistent: false };
    title.textContent = displayed.title;
    show();
  }
  function render(state) {
    const next = state.settings || {};
    const layoutChanged =
      mirrored !== Boolean(next.petMirror) || preferences.petPanelLabel !== next.petPanelLabel;
    if (preferences.petAudio !== next.petAudio) {
      stopSound();
      audioBuffers = undefined;
    }
    if (preferences.petVolume !== next.petVolume || preferences.petSound !== next.petSound) {
      stopSound();
    }
    preferences = next;
    const nextImage = preferences.petImage || assets.image;
    if (nextImage !== currentImage) {
      currentImage = nextImage;
      image.src = nextImage;
    }
    if (mirrored !== Boolean(preferences.petMirror)) {
      mirrored = Boolean(preferences.petMirror);
      host.dataset.mirrored = String(mirrored);
      host.dataset.left = String(mirrored);
      placement = undefined;
      Object.assign(host.style, {
        left: mirrored ? "0px" : "auto",
        right: mirrored ? "auto" : "24px",
        top: "auto",
        bottom: "0px",
      });
    }
    panelLabel.textContent = preferences.petPanelLabel ?? "打开面板";
    open.setAttribute("aria-label", preferences.petPanelLabel ?? "打开面板");
    const card = project(state);
    if (card.key !== last?.key || card.title !== last?.title) {
      title.textContent = card.title;
      host.dataset.mood = card.mood;
      last = card;
      displayed = card;
      manualIdle = false;
      show();
    } else if (manualIdle && displayed.title !== idleTitle()) {
      showIdle();
    }
    if (!dismissed && !host.isConnected) {
      document.body.append(host);
    }
    visibility();
    if (layoutChanged) {
      alignBubble();
    }
  }
  function position(x, y) {
    const size = host.getBoundingClientRect();
    const maxTop = Math.max(0, innerHeight - size.height);
    const maxLeft = Math.max(0, availableWidth() - size.width);
    const left = Math.max(0, Math.min(x, maxLeft));
    const top = Math.max(Math.min(150, maxTop), Math.min(y, maxTop));
    const bottom = top === maxTop;
    Object.assign(host.style, {
      left: `${left}px`,
      top: bottom ? "auto" : `${top}px`,
      right: "auto",
      bottom: bottom ? "0px" : "auto",
    });
    host.dataset.left = String(left < 280);
    // Keep an edge-docked pet attached when the viewport grows as well as when it shrinks.
    placement = { left, top, bottom, right: left === maxLeft };
    alignBubble();
  }
  const on = (target, type, callback) =>
    target.addEventListener(type, callback, { signal: lifetime.signal });
  on(image, "error", () => {
    if (image.src !== assets.image) {
      image.src = assets.image;
    }
  });
  on(body, "pointerdown", (event) => {
    if (!event.isTrusted || event.button !== 0) {
      return;
    }
    event.stopPropagation();
    const rect = host.getBoundingClientRect();
    drag = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    dragged = false;
    clearTimeout(timer);
    clearTimeout(patTimer);
    host.dataset.pressed = "false";
    stopSound();
    body.setPointerCapture?.(event.pointerId);
  });
  on(body, "pointermove", (event) => {
    if (!event.isTrusted || !drag || event.pointerId !== drag.pointer) {
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 6) {
      dragged = true;
    }
    if (dragged) {
      position(drag.left + dx, drag.top + dy);
    }
  });
  const release = () => {
    const wasDragging = Boolean(drag);
    host.dataset.pressed = "false";
    drag = null;
    if (wasDragging) {
      show();
    }
  };
  on(body, "pointerup", release);
  const cancel = () => {
    if (drag) {
      dragged = true;
    }
    clearTimeout(patTimer);
    release();
    stopSound();
  };
  for (const type of ["pointercancel", "lostpointercapture"]) {
    on(body, type, () => {
      if (drag) {
        cancel();
      }
    });
  }
  on(body, "click", (event) => {
    event.stopPropagation();
    if (event.isTrusted && !dragged) {
      showIdle();
      pat();
      playSound();
    }
  });
  on(body, "keydown", (event) => {
    event.stopPropagation();
    if (event.isTrusted && [" ", "Enter"].includes(event.key)) {
      dragged = false;
    }
  });
  on(body, "keyup", (event) => {
    event.stopPropagation();
    release();
  });
  on(body, "blur", cancel);
  on(window, "blur", cancel);
  on(open, "click", (event) => {
    if (event.isTrusted) {
      event.stopPropagation();
      Promise.resolve(openPanel()).catch(() => {});
    }
  });
  on(hide, "click", (event) => {
    if (event.isTrusted) {
      event.stopPropagation();
      dismissed = true;
      clearTimeout(timer);
      cancel();
      visibility();
    }
  });
  on(host, "keydown", (event) => event.stopPropagation());
  on(host, "keyup", (event) => event.stopPropagation());
  on(document, "fullscreenchange", () => {
    cancel();
    visibility();
  });
  on(document, "visibilitychange", () => {
    cancel();
    visibility();
  });
  function updateViewport() {
    viewportSignature = `${availableWidth()}:${innerHeight}`;
    if (host.hidden) {
      return;
    }
    if (placement) {
      position(
        placement.right ? availableWidth() : placement.left,
        placement.bottom ? innerHeight : placement.top,
      );
    }
    alignBubble();
  }
  on(window, "resize", updateViewport);
  const viewportObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          if (
            !lifetime.signal.aborted &&
            `${availableWidth()}:${innerHeight}` !== viewportSignature
          ) {
            updateViewport();
          }
        })
      : null;
  viewportObserver?.observe(document.documentElement);
  const unsubscribe = observe(render);
  return {
    destroy() {
      unsubscribe();
      viewportObserver?.disconnect();
      clearTimeout(timer);
      clearTimeout(patTimer);
      stopSound();
      if (audioContext) {
        void audioContext.close().catch(() => {});
      }
      lifetime.abort();
      host.remove();
    },
  };
}
