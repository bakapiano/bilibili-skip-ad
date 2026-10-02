import workerSource from "biliskip:asr-worker";
import { AsrEngine } from "../extension/asr/engine.js";
import { createModelFetch } from "./model-fetch.js";
import { AsrResourceGate, loadAsrResources } from "./asr-resources.js";

export function userscriptAsr(gm, fetcher) {
  const availability = new AsrResourceGate((signal) => loadAsrResources(gm, fetch, signal));
  const engine = new AsrEngine({
    fetcher,
    createWorker: () => {
      const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
      const worker = new Worker(url, { type: "module" });
      URL.revokeObjectURL(url);
      return worker;
    },
    resources: () => availability.load(),
    modelFetcher: createModelFetch(gm),
  });
  engine.availability = availability;
  engine.ensureAvailable = async () => {
    await availability.load();
  };
  return engine;
}
