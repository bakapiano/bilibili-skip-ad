(() => {
  "use strict";
  class Timeline {
    constructor(doc = document) {
      this.document = doc;
      this.layers = new Map();
    }
    remove(wrap, entry) {
      entry.layer.remove();
      if (entry.positionChanged && wrap.style.position === "relative") {
        wrap.style.position = entry.previousPosition;
      }
      this.layers.delete(wrap);
    }
    clear() {
      for (const [wrap, entry] of this.layers) {
        this.remove(wrap, entry);
      }
    }
    sync(record, video, segments = record?.segments || []) {
      const player = video?.closest(".bpx-player-container");
      const targets =
        record && segments.length && player
          ? Array.from(
              player.querySelectorAll(
                ".bpx-player-progress-schedule-wrap,.bpx-player-shadow-progress-schedule-wrap",
              ),
            )
          : [];
      const active = new Set(targets);
      for (const [wrap, entry] of this.layers) {
        if (!active.has(wrap) || !entry.layer.isConnected) {
          this.remove(wrap, entry);
        }
      }
      for (const wrap of targets) {
        let entry = this.layers.get(wrap);
        if (!entry) {
          const previousPosition = wrap.style.position;
          const positionChanged = globalThis.getComputedStyle(wrap).position === "static";
          if (positionChanged) {
            wrap.style.position = "relative";
          }
          const layer = this.document.createElement("div");
          layer.className = "biliskip-native-markers";
          layer.setAttribute("aria-hidden", "true");
          layer.style.cssText =
            "position:absolute;inset:0;display:block;pointer-events:none;z-index:2;overflow:hidden;border-radius:inherit";
          wrap.append(layer);
          entry = { layer, previousPosition, positionChanged, token: "" };
          this.layers.set(wrap, entry);
        }
        // A settings/preview change can alter the visible subset of the same record.
        const token = JSON.stringify([record.key, record.createdAt, segments]);
        if (entry.token === token) {
          continue;
        }
        entry.token = token;
        entry.layer.replaceChildren();
        for (const segment of segments) {
          const marker = this.document.createElement("span");
          marker.className = "biliskip-native-marker";
          marker.dataset.start = String(segment.start);
          marker.dataset.end = String(segment.end);
          marker.dataset.brand = segment.brand;
          marker.style.cssText =
            "position:absolute;top:0;height:100%;display:block;pointer-events:none;background:#ffb547;box-shadow:inset 0 0 0 1px #8b580044";
          marker.style.left = `${(segment.start / record.video.duration) * 100}%`;
          marker.style.width = `${((segment.end - segment.start) / record.video.duration) * 100}%`;
          entry.layer.append(marker);
        }
      }
    }
  }
  globalThis.BiliSkipTimeline = Timeline;
})();
