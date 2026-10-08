// Serialize writes while allowing controls to remain responsive. Save only changed fields.
export function createAutoSave({ save, status = () => {} }) {
  let tail = Promise.resolve();
  let revision = 0;
  return (patch, committed = () => {}) => {
    const current = ++revision;
    status("正在保存…");
    const task = tail.then(() => save(patch));
    tail = task.catch(() => {});
    return task.then(
      (result) => {
        committed(result);
        if (current === revision) {
          status("已自动保存");
        }
        return result;
      },
      (error) => {
        if (current === revision) {
          status(error.message || "保存未完成，请重试。", true);
        }
        throw error;
      },
    );
  };
}
