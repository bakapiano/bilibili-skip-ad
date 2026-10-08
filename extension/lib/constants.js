import { DEFAULT_PET_SETTINGS } from "./pet-config.js";

export const MODEL = "deepseek-flash";
export const BUILD_VERSION = "0.2.0";
export const SETTINGS_VERSION = 2;
export const DEFAULT_SHARED_URL = "https://biliskipad.bakapiano.com";
export const PROMPT_VERSION = "ad-cues-v6-json";
export const SCHEMA_VERSION = 1;
export const MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SETTINGS = Object.freeze({
  ...DEFAULT_PET_SETTINGS,
  consent: false,
  autoAnalyze: false,
  autoSkip: false,
  asrEnabled: false,
  asrUpload: true,
  asrModelSource: "biliskip",
  asrConcurrency: 2,
  shortVideoExempt: false,
  shortVideoMinutes: 3,
  confidenceThreshold: 0.9,
  sharedBaseUrl: DEFAULT_SHARED_URL,
  sharedRead: true,
  sharedUpload: true,
  autoUpload: true,
});
export const LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["video_key", "transcript_sha256", "summary", "segments"],
  properties: {
    video_key: { type: "string" },
    transcript_sha256: { type: "string" },
    summary: { type: "string" },
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start_id", "end_id", "brand", "confidence", "reason", "evidence_ids"],
        properties: {
          start_id: { type: "integer", minimum: 1 },
          end_id: { type: "integer", minimum: 1 },
          brand: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
          evidence_ids: { type: "array", minItems: 0, items: { type: "integer", minimum: 1 } },
        },
      },
    },
  },
};
export { INSTRUCTIONS } from "./ad-instructions.js";

// Price snapshot. A single period is selected when usage arrives; the account bill remains authoritative.
export const PRICING = Object.freeze({
  asOf: "2026-10-08",
  currency: "CNY",
  offPeak: { hit: 0.02, miss: 1, output: 4 },
  peak: { hit: 0.04, miss: 2, output: 8 },
});
