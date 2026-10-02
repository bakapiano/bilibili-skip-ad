export function bindAsrAvailability(root, availability) {
  const get = (id) => root.getElementById(id);
  const retry = get("check-asr-resources");
  const render = () => {
    const { status, message } = availability.state;
    const paused = status === "checking" || status === "unavailable";
    get("asr-resource-status").textContent = message;
    get("asr-resource-status").dataset.state = status;
    get("setting-asrEnabled").disabled = paused;
    get("asr-resource-controls").disabled = paused;
    retry.disabled = status === "checking";
    retry.textContent = status === "unavailable" ? "重新检查资源" : "检查转写资源";
  };
  const check = (event) => {
    if (event.isTrusted) {
      // The gate publishes a safe explanation; UI retries never escape as unhandled rejections.
      availability.load({ retry: true }).catch(() => {});
    }
  };
  const unsubscribe = availability.subscribe(render);
  retry.addEventListener("click", check);
  render();
  return () => {
    unsubscribe();
    retry.removeEventListener("click", check);
  };
}
