function escapeChatMarkers(text) {
  return text
    .replaceAll("<|", "＜|")
    .replaceAll("|>", "|＞")
    .replaceAll("<｜", "＜｜")
    .replaceAll("｜>", "｜＞");
}

export function compactCueText(text) {
  // One physical line per cue keeps embedded line breaks from forging subtitle IDs.
  return escapeChatMarkers(
    text
      .replaceAll("\\", "\\\\")
      .replaceAll("\r", "\\r")
      .replaceAll("\n", "\\n")
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029"),
  );
}

export function compactPromptData(context, options = {}) {
  const cues = options.cues || context.cues;
  return (
    `标题：${compactCueText(context.video.title)}\n\n` +
    cues.map((cue) => `${cue.id}|${compactCueText(cue.content)}`).join("\n")
  );
}
