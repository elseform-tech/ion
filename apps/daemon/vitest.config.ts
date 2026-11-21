import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Task review, 2026-11-21: tests never write your real cache folder (ion's config folder for opencode lives there).
// Task 13, 2026-11-21: nor read your agents' own configs, skills and plugins (an empty stand-in home): Settings → Tools
// now lists each agent's own, and reading a real home on every list slowed the whole suite.
export default defineConfig({
  test: {
    env: {
      XDG_CACHE_HOME: join(tmpdir(), `ion-test-cache-${process.pid}`),
      ION_AGENTS_HOME: join(tmpdir(), `ion-test-agents-${process.pid}`),
    },
  },
});
