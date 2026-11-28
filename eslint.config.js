import ion from "@ion/lint-rules";
import sonarjs from "eslint-plugin-sonarjs";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/** Code health limits. Raise one only with a reason in the PR; never per file to dodge it. */
const HEALTH = {
  maxFileLines: 1000,
  maxFunctionLines: 80,
  maxDepth: 3,
  maxNestedCallbacks: 3,
  maxParams: 4,
  cognitiveComplexity: 15,
  cyclomaticComplexity: 15,
};

export default tseslint.config(
  {
    ignores: [
      ".claude/**",
      "**/dist/**",
      "**/node_modules/**",
      "docs/**",
      ".superpowers/**",
      ".remember/**",
      "**/.turbo/**",
      "**/src-tauri/**",
    ],
  },
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    plugins: { ion },
    rules: {
      // Architecture walls (tools/lint-rules)
      "ion/walls": "error",
      "ion/event-types-from-schema": "error",
      "ion/no-direct-db": "error",
      "ion/no-child-process": "error",
      "ion/no-model-names": "error",
      "ion/plain-words": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],

      // Dead code (knip covers unused files, exports and dependencies across packages)
      "no-unreachable": "error",
      "no-useless-return": "error",
      "no-useless-catch": "error",
      "@typescript-eslint/no-unused-expressions": "error",
      "sonarjs/no-dead-store": "error",
      "sonarjs/no-unused-collection": "error",
      "sonarjs/no-redundant-jump": "error",

      // Size and shape
      "max-lines": ["error", { max: HEALTH.maxFileLines, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": [
        "error",
        { max: HEALTH.maxFunctionLines, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      "max-depth": ["error", HEALTH.maxDepth],
      "max-nested-callbacks": ["error", HEALTH.maxNestedCallbacks],
      "max-params": ["error", HEALTH.maxParams],
      complexity: ["error", HEALTH.cyclomaticComplexity],
      "sonarjs/cognitive-complexity": ["error", HEALTH.cognitiveComplexity],
    },
  },
  {
    // The desktop UI: React's rules of hooks.
    files: ["apps/desktop/src/**/*.tsx", "apps/desktop/src/**/*.ts", "packages/design-system/src/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // The UI only displays state: it talks to ion through @ion/client, and keeps nothing of its own.
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "The desktop UI reaches ion only through @ion/client." },
        { name: "localStorage", message: "The desktop UI keeps no state of its own." },
        { name: "sessionStorage", message: "The desktop UI keeps no state of its own." },
      ],
    },
  },
  {
    // Tests read top to bottom; long describe blocks are fine, the other limits still apply.
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.test.js", "**/test/**"],
    rules: {
      "max-lines-per-function": "off",
      "max-nested-callbacks": ["error", 5],
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/no-nested-functions": "off",
      // Tests spawn `node` and `sleep` on purpose.
      "sonarjs/no-os-command-from-path": "off",
    },
  },
  {
    // Manual developer scripts (e.g. transcript recording) call git and node from PATH on purpose.
    files: ["**/scripts/**"],
    rules: { "sonarjs/no-os-command-from-path": "off" },
  },
  {
    // The test runs' temp folder: a fresh mkdtemp folder under /tmp, set as the runs' TMPDIR on purpose (Task 11).
    files: ["tools/test-temp/**"],
    rules: { "sonarjs/publicly-writable-directories": "off" },
  },
  {
    // The address ranges sign-in requests may never reach (private, link-local, …) are written out on purpose.
    files: ["apps/daemon/src/secrets/oauth-net.ts"],
    rules: { "sonarjs/no-hardcoded-ip": "off" },
  },
  {
    // RuleTester registers its cases itself; SonarJS can't see them.
    files: ["tools/lint-rules/**/*.test.js"],
    rules: { "sonarjs/no-empty-test-file": "off" },
  },
);
