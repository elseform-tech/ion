import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every test run's temp folders in one place, removed when the run ends (Task 11, 2026-11-22: test runs had left about
 * 200,000 ion-* folders in $TMPDIR). TMPDIR points at a fresh folder under /tmp for the run (workers and the daemons and
 * CLIs tests start inherit it; /tmp so ion's own rules still see a system temp folder), removed in teardown. Teardown
 * fails when the run left new ion-* folders in the real temp folder all the same.
 */
const leftovers = (dir: string) => new Set(readdirSync(dir).filter((n) => n.startsWith("ion-")));

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A run's own folder's prefix: other runs' folders (turbo runs packages' tests at once) aren't this run's leftovers. */
const RUN_PREFIX = "ion-test-run-";

/**
 * Starts a run's temp folder under `base`; the teardown removes it and fails only on what this run left: its own
 * folder still there, or a new ion-* folder in the real temp folder that isn't another run's folder (CI, PR #25,
 * 2026-11-22: one package's teardown failed on other packages' live run folders).
 */
export function tempRun(o: { real?: string; base?: string } = {}): () => void {
  const real = o.real ?? tmpdir();
  const before = leftovers(real);
  const root = mkdtempSync(join(o.base ?? "/tmp", RUN_PREFIX));
  const saved = {
    TMPDIR: process.env.TMPDIR,
    XDG: process.env.XDG_CACHE_HOME,
    AGENTS: process.env.ION_AGENTS_HOME,
  };
  process.env.TMPDIR = root;
  // Tests never write your real cache folder (ion's config folder for opencode lives there), nor read your agents'
  // own configs (an empty stand-in home; a test that needs one names its own). Task review / Task 13, 2026-11-21.
  process.env.XDG_CACHE_HOME = join(root, "cache");
  process.env.ION_AGENTS_HOME = join(root, "agents");
  return () => {
    restore("TMPDIR", saved.TMPDIR);
    restore("XDG_CACHE_HOME", saved.XDG);
    restore("ION_AGENTS_HOME", saved.AGENTS);
    // A daemon a test started may still be writing its last file there: tried again for a moment.
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (existsSync(root)) throw new Error(`The test run's folder is still there: ${root}`);
    const left = [...leftovers(real)].filter((n) => !before.has(n) && !n.startsWith(RUN_PREFIX));
    if (left.length)
      throw new Error(`Tests left ${left.length} folders in ${real}: ${left.slice(0, 5).join(", ")}`);
  };
}

export default function setup(): () => void {
  return tempRun();
}
