import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

export default function setup(): () => void {
  const real = tmpdir();
  const before = leftovers(real);
  const root = mkdtempSync("/tmp/ion-test-run-");
  const saved = { TMPDIR: process.env.TMPDIR, XDG: process.env.XDG_CACHE_HOME, AGENTS: process.env.ION_AGENTS_HOME };
  process.env.TMPDIR = root;
  // Tests never write your real cache folder (ion's config folder for opencode lives there), nor read your agents'
  // own configs (an empty stand-in home; a test that needs one names its own). Task review / Task 13, 2026-11-21.
  process.env.XDG_CACHE_HOME = join(root, "cache");
  process.env.ION_AGENTS_HOME = join(root, "agents");
  return () => {
    restore("TMPDIR", saved.TMPDIR);
    restore("XDG_CACHE_HOME", saved.XDG);
    restore("ION_AGENTS_HOME", saved.AGENTS);
    rmSync(root, { recursive: true, force: true });
    const left = [...leftovers(real)].filter((n) => !before.has(n));
    if (left.length) throw new Error(`Tests left ${left.length} folders in ${real}: ${left.slice(0, 5).join(", ")}`);
  };
}
