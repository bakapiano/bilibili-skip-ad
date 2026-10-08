// Native anchors work independently of statistics/network. This script only follows scroll state.
(() => {
  let dispose;
  function mount() {
    dispose?.();
    const nav = document.getElementById("home-navigation");
    if (!nav) {
      return;
    }
    const items = Array.from(nav.querySelectorAll('a[href^="#"]'))
      .map((link) => ({ link, section: document.getElementById(link.hash.slice(1)) }))
      .filter((item) => item.section);
    if (!items.length) {
      return;
    }
    const controller = new AbortController();
    let frame;
    let activeLink;
    let anchorTarget = items.find(({ link }) => link.hash === window.location.hash);
    const revealActive = () => {
      if (nav.scrollWidth > nav.clientWidth) {
        const bounds = activeLink.getBoundingClientRect();
        const viewport = nav.getBoundingClientRect();
        const shift =
          bounds.left < viewport.left
            ? bounds.left - viewport.left
            : bounds.right > viewport.right
              ? bounds.right - viewport.right
              : 0;
        nav.scrollLeft += shift;
      }
    };
    function update() {
      frame = undefined;
      const margin = Number.parseFloat(getComputedStyle(items[0].section).scrollMarginTop) || 0;
      const padding =
        Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
      const threshold = Math.max(24, margin + padding + 2);
      let current = items[0];
      for (const item of items) {
        if (item.section.getBoundingClientRect().top <= threshold) {
          current = item;
        }
      }
      if (
        window.scrollY > 0 &&
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2
      ) {
        // A short final section can clamp multiple anchors to the same bottom position.
        // Preserve the explicitly chosen visible anchor until the user scrolls again.
        const anchorTop = anchorTarget?.section.getBoundingClientRect().top;
        current = anchorTop >= 0 && anchorTop < window.innerHeight ? anchorTarget : items.at(-1);
      }
      if (activeLink !== current.link) {
        activeLink = current.link;
        for (const { link } of items) {
          if (link === activeLink) {
            link.setAttribute("aria-current", "location");
          } else {
            link.removeAttribute("aria-current");
          }
        }
      }
      revealActive();
    }
    function schedule() {
      if (frame === undefined) {
        frame = window.requestAnimationFrame(update);
      }
    }
    for (const type of ["scroll", "resize"]) {
      window.addEventListener(type, schedule, { passive: true, signal: controller.signal });
    }
    window.addEventListener(
      "hashchange",
      () => {
        anchorTarget = items.find(({ link }) => link.hash === window.location.hash);
        schedule();
      },
      { signal: controller.signal },
    );
    for (const item of items) {
      item.link.addEventListener(
        "click",
        (event) => {
          if (
            event.button === 0 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            anchorTarget = item;
            schedule();
          }
        },
        { signal: controller.signal },
      );
    }
    const manualScroll = () => {
      anchorTarget = undefined;
      schedule();
    };
    for (const type of ["wheel", "touchstart"]) {
      window.addEventListener(type, manualScroll, { passive: true, signal: controller.signal });
    }
    window.addEventListener(
      "keydown",
      (event) => {
        if (
          ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)
        ) {
          manualScroll();
        }
      },
      { signal: controller.signal },
    );
    window.addEventListener(
      "pointerdown",
      (event) => {
        if (!nav.contains(event.target)) {
          manualScroll();
        }
      },
      { signal: controller.signal },
    );
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(document.querySelector(".home-content"));
    dispose = () => {
      controller.abort();
      observer?.disconnect();
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
      }
    };
    update();
  }
  window.addEventListener("pagehide", () => dispose?.());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      mount();
    }
  });
  mount();
})();
