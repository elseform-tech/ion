import { defineConfig } from "vitest/config";

// Task 11, 2026-11-22: the run's temp folders, cache folder and stand-in agents' home in one folder, removed after.
export default defineConfig({
  test: {
    globalSetup: ["../../../tools/test-temp/setup.ts"],
    setupFiles: ["../../../tools/test-temp/guard.ts"],
  },
});
