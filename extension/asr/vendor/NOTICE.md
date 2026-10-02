# Local ASR third-party components

BiliSkip uses SenseVoiceSmall INT8 by FunAudioLLM / Alibaba, converted to ONNX
by the sherpa-onnx community (csukuangfj). Model and author names are retained here
and in the settings UI. The main model weights are downloaded on demand as data.

- sherpa-onnx 1.12.20: Apache-2.0, see `LICENSE`.
  Source: https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.12.20
- ONNX Runtime 1.17.1 WASM SIMD, selected by sherpa-onnx's pinned
  `cmake/onnxruntime-wasm-simd.cmake`: MIT, see `ONNXRUNTIME-LICENSE` and
  `ONNXRUNTIME-NOTICES` for bundled dependency notices.
- Silero VAD: Copyright (c) 2020-present Silero Team, MIT, see `SILERO-LICENSE`.
  Source: https://github.com/snakers4/silero-vad
- SenseVoice weights and vocabulary: the converted model repository's `LICENSE`
  points to FunASR's model licensing section. See the preserved model terms in
  `FUNASR-MODEL-LICENSE` (retrieved 2026-10-01) and the upstream model card.
  Model terms are independent of BiliSkip's own MIT source license.
  Source: https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/2365baeacb507f821a0c8120fcee3d484dba7a07

Local modifications: ESM wrappers/exports, initialization Promise wrapper,
explicit VAD variable declarations. The vendored runtime and model-support bytes
are recorded in `provenance.json`; the downloaded weight hash is pinned in
`extension/lib/asr-config.js`.

The userscript embeds these licenses together with its bundled JS/WASM assets.
