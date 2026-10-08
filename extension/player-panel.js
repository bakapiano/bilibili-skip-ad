// Shared Chrome/userscript drawer and native player entry. Only trusted UI events initiate actions.
globalThis.BiliSkipPlayerPanel = function createPlayerPanel({
  id,
  mount,
  extraHtml = "",
  extraCss = "",
  enabled = () => true,
}) {
  const assets = globalThis.BiliSkipPlayerAssets;
  let host;
  let root;
  let button;
  let cleanup;
  let settingsView;
  let destroyed = false;
  let opener;
  const lifetime = new AbortController();
  const parent = () => document.fullscreenElement || document.body;
  function close() {
    if (!host) {
      return;
    }
    cleanup?.();
    cleanup = null;
    host.remove();
    host = null;
    root = null;
    button?.setAttribute("aria-expanded", "false");
    if (opener?.isConnected) {
      opener.focus({ preventScroll: true });
    }
  }
  async function open(showSettings = false) {
    if (destroyed) {
      return;
    }
    if (host) {
      if (showSettings) {
        settingsView?.();
      }
      return;
    }
    opener = document.activeElement;
    host = document.createElement("div");
    host.id = id;
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483000";
    root = host.attachShadow({ mode: "closed" });
    // Static repository templates only. Model, subtitle and video data use textContent in views.
    root.innerHTML = `<style>${assets.css.replace(":root", ":host")}\n${extraCss}</style>
      <section class="biliskip-drawer" role="dialog" aria-label="BiliSkip 视频面板" style="pointer-events:auto">
        <div class="drawer-toolbar"><span>视频助手</span><button id="close-panel" type="button" aria-label="关闭面板">×</button></div>
        <div class="drawer-scroll">${assets.html}${extraHtml}</div>
        <nav class="project-links" aria-label="项目链接"><a href="https://biliskipad.bakapiano.com/" target="_blank" rel="noopener noreferrer"><span class="project-link-icon" aria-hidden="true">${assets.homeIcon}</span>项目主页</a><a href="https://github.com/bakapiano/bilibili-skip-ad" target="_blank" rel="noopener noreferrer"><span class="project-link-icon" aria-hidden="true">${assets.githubIcon}</span>GitHub</a></nav>
      </section>`;
    parent().append(host);
    button?.setAttribute("aria-expanded", "true");
    const closeButton = root.getElementById("close-panel");
    closeButton.addEventListener("click", (event) => {
      if (event.isTrusted) {
        close();
      }
    });
    root.addEventListener("keydown", (event) => {
      // Keep typing/Space from reaching the site's player keyboard shortcuts.
      event.stopPropagation();
      if (event.isTrusted && event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });
    root.addEventListener("keyup", (event) => event.stopPropagation());
    for (const type of ["pointerdown", "mousedown", "click"]) {
      root.addEventListener(type, (event) => event.stopPropagation());
    }
    closeButton.focus({ preventScroll: true });
    try {
      const mounted = mount(root);
      cleanup = mounted?.destroy;
      settingsView = mounted?.showSettings;
      if (showSettings) {
        settingsView?.();
      }
      await mounted?.ready;
    } catch (error) {
      close();
      throw error;
    }
  }
  function toggle() {
    if (host) {
      close();
    } else {
      open().catch(() => close());
    }
  }
  function sync() {
    if (destroyed) {
      return;
    }
    if (host && host.parentElement !== parent()) {
      parent().append(host);
    }
    const video = Array.from(document.querySelectorAll(".bpx-player-container video"))
      .filter((element) => element.getBoundingClientRect().width > 100)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    const player = video?.closest(".bpx-player-container");
    const controls = player?.querySelector(
      ".bpx-player-control-bottom-right, .bilibili-player-video-btn-right",
    );
    if (!globalThis.BiliSkipPlayer.parse(location.href) || !controls || !enabled()) {
      button?.remove();
      button = null;
      if (!globalThis.BiliSkipPlayer.parse(location.href)) {
        close();
      }
      return;
    }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "biliskip-player-button";
      button.title = "BiliSkip · 广告跳过";
      button.setAttribute("aria-label", "BiliSkip · 广告跳过");
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-expanded", String(Boolean(host)));
      // Native controls use a 22px row inside a taller bottom bar. Match that row,
      // not the bar height, so the icon shares the quality/volume controls' center.
      Object.assign(button.style, {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 34px",
        width: "34px",
        height: "22px",
        boxSizing: "border-box",
        lineHeight: "0",
        padding: "0",
        margin: "0 6px 0 0",
        border: "0",
        borderRadius: "4px",
        background: "transparent",
        color: "#fff",
        cursor: "pointer",
        verticalAlign: "middle",
      });
      button.innerHTML = assets.playerIcon;
      button.firstElementChild.style.cssText =
        "display:block;flex:none;width:22px;height:22px;pointer-events:none";
      button.addEventListener("click", (event) => {
        if (event.isTrusted) {
          event.stopPropagation();
          toggle();
        }
      });
    }
    if (button.parentElement !== controls) {
      controls.prepend(button);
    }
    // Fullscreen adds bottom hit-area padding to native buttons. Their text/icon
    // line box remains the alignment target (22px normally, 32px in fullscreen).
    const reference = controls.querySelector(
      ".bpx-player-ctrl-quality, .bpx-player-ctrl-setting, .bilibili-player-video-btn-quality",
    );
    const nativeLineHeight = reference
      ? Number.parseFloat(getComputedStyle(reference).lineHeight)
      : NaN;
    const rowHeight =
      Number.isFinite(nativeLineHeight) && nativeLineHeight >= 16 && nativeLineHeight <= 48
        ? nativeLineHeight
        : 22;
    const height = `${rowHeight}px`;
    if (button.style.height !== height) {
      button.style.height = height;
    }
  }
  document.addEventListener("fullscreenchange", sync, { signal: lifetime.signal });
  document.addEventListener(
    "keydown",
    (event) => {
      if (host && event.isTrusted && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    },
    { capture: true, signal: lifetime.signal },
  );
  const timer = setInterval(sync, 600);
  sync();
  return {
    sync,
    open,
    close,
    destroy() {
      destroyed = true;
      close();
      button?.remove();
      clearInterval(timer);
      lifetime.abort();
    },
  };
};
