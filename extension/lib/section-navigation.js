// Native anchors own navigation/focus/history. This binding only tracks the visible section.
export function bindSectionNavigation(nav) {
  const doc = nav.ownerDocument;
  const view = doc.defaultView;
  const items = Array.from(nav.querySelectorAll('a[href^="#"]'))
    .map((link) => ({ link, section: doc.getElementById(link.getAttribute("href").slice(1)) }))
    .filter((item) => item.section);
  const lifetime = new view.AbortController();
  let frame;
  let selected;
  function update() {
    frame = undefined;
    if (!items.length) {
      return;
    }
    const anchorOffset =
      Number.parseFloat(view.getComputedStyle(items[0].section).scrollMarginTop) || 0;
    const offset = Math.max(
      80,
      anchorOffset + 2,
      (doc.querySelector(".save-bar")?.getBoundingClientRect().bottom || 0) + 16,
    );
    let active = items[0];
    for (const item of items) {
      if (item.section.getBoundingClientRect().top <= offset) {
        active = item;
      }
    }
    if (
      view.scrollY > 0 &&
      view.scrollY + view.innerHeight >= doc.documentElement.scrollHeight - 2
    ) {
      active = items.at(-1);
    }
    if (selected === active) {
      return;
    }
    selected = active;
    for (const { link } of items) {
      if (link === active.link) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    }
    // Keep the active item visible inside the narrow-screen horizontal navigation.
    if (nav.scrollWidth > nav.clientWidth) {
      const bounds = active.link.getBoundingClientRect();
      const viewport = nav.getBoundingClientRect();
      const delta =
        bounds.left < viewport.left
          ? bounds.left - viewport.left
          : bounds.right > viewport.right
            ? bounds.right - viewport.right
            : 0;
      nav.scrollLeft += delta;
    }
  }
  function schedule() {
    if (frame === undefined) {
      frame = view.requestAnimationFrame(update);
    }
  }
  for (const type of ["scroll", "resize", "hashchange"]) {
    view.addEventListener(type, schedule, { passive: true, signal: lifetime.signal });
  }
  const observer = view.ResizeObserver ? new view.ResizeObserver(schedule) : null;
  observer?.observe(doc.body);
  update();
  return () => {
    lifetime.abort();
    observer?.disconnect();
    if (frame !== undefined) {
      view.cancelAnimationFrame(frame);
    }
  };
}
