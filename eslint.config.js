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
      "server/**/*.{js,cjs,mjs}",
    ],
    languageOptions: {
      globals: globals.node,
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
      "extension/player-core.js",
      "extension/timeline.js",
      "extension/options.js",
      "extension/popup.js",
    ],
    languageOptions: {
      globals: { ...globals.browser, chrome: "readonly" },
    },
  },
  {
    name: "biliskip/classic-scripts",
    files: ["extension/content.js", "extension/player-core.js", "extension/timeline.js"],
    languageOptions: { sourceType: "script" },
  },
]);
