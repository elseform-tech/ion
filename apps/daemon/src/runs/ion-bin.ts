import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The `ion` CLI beside this daemon (an installed ion's own; `ION_CLI_BIN` overrides it). */
const defaultCli = () =>
  process.env.ION_CLI_BIN ?? fileURLToPath(new URL("../../../cli/dist/index.js", import.meta.url));

/** A word for /bin/sh, quoted whole. */
const quoted = (s: string) => {
  const inner = s.replaceAll("'", "'\\''");
  return `'${inner}'`;
};

/**
 * ion's own `ion` launcher, in `<data>/bin`, for every run's PATH: this daemon's CLI on this node, so a chat's agent
 * finds `ion` whether or not you installed it on your PATH (Task review, 2026-11-21). None when the CLI isn't there.
 */
export function ionLauncher(dataDir: string, cli = defaultCli()): string | undefined {
  if (!existsSync(cli)) return undefined;
  const dir = join(dataDir, "bin");
  const file = join(dir, "ion");
  // Made fresh (Task review, 2026-11-21): whatever is there, a link too, goes first; never written through.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  rmSync(file, { force: true });
  writeFileSync(file, `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(cli)} "$@"\n`, {
    mode: 0o700,
    flag: "wx",
  });
  return dir;
}
