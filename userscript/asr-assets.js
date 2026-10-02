// Pinned binary resources: identical to the Chrome-bundled assets, managed by Tampermonkey SRI.
export const ASR_ASSET_BASE = "https://biliskipad.bakapiano.com/asr/sherpa-onnx-1.12.20";
export const ASR_ASSETS = Object.freeze([
  {
    key: "binary",
    name: "biliskipAsrWasm",
    file: "runtime.wasm",
    bytes: 11539169,
    sha256: "2fc8dc389b23ad07f0d526b2e7c7c828543956d053db858d73cff192be7589e3",
    extension: "wasm",
  },
  {
    key: "support",
    name: "biliskipAsrSupport",
    file: "support.bin",
    bytes: 959748,
    sha256: "aee057370c3af9b75689b0f1194428185d0bb0a63314711a73c7bb5f80aef2de",
    extension: "bin",
  },
]);
export function asrAssetUrl(asset) {
  return `${ASR_ASSET_BASE}/${asset.sha256}.${asset.extension}`;
}
