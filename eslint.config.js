import ion from "@ion/lint-rules";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "docs/**",
      ".superpowers/**",
      ".remember/**",
      "**/.turbo/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    plugins: { ion },
    rules: {
      "ion/walls": "error",
      "ion/event-types-from-schema": "error",
      "ion/no-direct-db": "error",
      "ion/no-child-process": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
