import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/** A folder of this test run's own, in the system's temp folder. */
const ours = (name: string) => join(tmpdir(), `${name}-${process.pid}`);

// Task review, 2026-11-21: tests never write your real cache folder (ion's config folder for opencode lives there).
// Task 13, 2026-11-21: nor read your agents' own configs (an empty stand-in home; a test that needs one names its own).
export default defineConfig({
  test: { env: { XDG_CACHE_HOME: ours("ion-test-cache"), ION_AGENTS_HOME: ours("ion-test-agents") } },
});
