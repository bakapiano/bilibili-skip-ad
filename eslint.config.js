import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    ".tmp/**",
    ".models/**",
    ".runtime/**",
    ".venv/**",
    "**/__pycache__/**",
    "data/**",
    "runs/**",
    "dist/**",
    "coverage/**",
    "extension/asr/vendor/**",
    "prompt/data/**",
    "prompt/runs/**",
  ]),
  prettier,
  {
    name: "biliskip/javascript",
    files: ["**/*.{js,cjs,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      curly: ["error", "all"],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "one-var": ["error", "never"],
      "prefer-const": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    name: "biliskip/node",
    files: [
      "eslint.config.js",
      "scripts/**/*.{js,cjs,mjs}",
      "tests/**/*.{js,cjs,mjs}",
      "server/*.{js,cjs,mjs}",
      "prompt/**/*.{js,cjs,mjs}",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    name: "biliskip/prompt-lab-browser",
    files: ["prompt/ui/*.js"],
    languageOptions: {
      globals: { ...globals.browser, process: "off", Buffer: "off", global: "off" },
    },
  },
  {
    name: "biliskip/prompt-browser-e2e",
    files: ["prompt/tests/browser-e2e.mjs"],
    languageOptions: {
      globals: { document: "readonly", innerWidth: "readonly" },
    },
  },
  {
    name: "biliskip/extension-worker",
    files: ["extension/background.js", "extension/lib/**/*.js"],
    languageOptions: {
      globals: { ...globals.worker, chrome: "readonly" },
    },
  },
  {
    name: "biliskip/browser",
    files: [
      "extension/content.js",
      "extension/content-controller.js",
      "extension/player-core.js",
      "extension/timeline.js",
      "extension/options.js",
      "extension/popup.js",
      "extension/popup-view.js",
      "extension/player-panel.js",
      "extension/player-assets.js",
      "extension/pet.js",
      "extension/pet-state.js",
      "extension/pet-assets.js",
      "extension/lib/pet-crop.js",
      "extension/lib/pet-settings-view.js",
      "extension/offscreen.js",
      "extension/asr/engine.js",
      "extension/asr/pool.js",
      "extension/asr/cues.js",
      "server/site/stats.js",
      "server/site/assets/navigation.js",
      "store/pet-preview/preview.js",
    ],
    languageOptions: {
      globals: { ...globals.browser, chrome: "readonly" },
    },
  },
  {
    files: ["extension/asr/worker.js"],
    languageOptions: { globals: globals.worker },
  },
  {
    name: "biliskip/userscript",
    files: ["userscript/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser, GM: "readonly" },
    },
  },
  {
    name: "biliskip/classic-scripts",
    files: [
      "extension/content.js",
      "extension/content-controller.js",
      "extension/player-core.js",
      "extension/timeline.js",
      "extension/popup-view.js",
      "extension/player-panel.js",
      "extension/player-assets.js",
      "extension/pet.js",
      "extension/pet-state.js",
      "extension/pet-assets.js",
      "server/site/stats.js",
      "server/site/assets/navigation.js",
      "store/pet-preview/preview.js",
    ],
    languageOptions: { sourceType: "script" },
  },
]);
