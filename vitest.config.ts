import { configDefaults, defineConfig } from "vitest/config";

// Runs from the repo root (`pnpm vitest run <path>`) skip agents' worktrees under .claude/ (copies of this repo).
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ".claude/**"], globalSetup: ["tools/test-temp/setup.ts"] },
});
