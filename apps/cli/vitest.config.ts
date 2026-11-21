import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Task review, 2026-11-21: tests never write your real cache folder (ion's config folder for opencode lives there).
export default defineConfig({
  test: { env: { XDG_CACHE_HOME: join(tmpdir(), `ion-test-cache-${process.pid}`) } },
});
