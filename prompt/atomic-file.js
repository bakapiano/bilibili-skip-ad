import { rename } from "node:fs/promises";

export async function renameWithRetry(
  source,
  destination,
  {
    renameFile = rename,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  // Windows readers/virus scanners can hold a transient sharing lock during atomic replacement.
  // Keep the previous destination intact and retry the same prepared file for at most 1.6 seconds.
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      if (attempt >= 6 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) {
        throw error;
      }
      await wait(Math.min(25 * 2 ** attempt, 400));
    }
  }
}
