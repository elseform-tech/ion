import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ionLauncher } from "./ion-bin.js";
import { runEnv } from "./run-env.js";

// Task review, 2026-11-21: a run's agent was told to use `ion mcp …`, but `ion` wasn't on its PATH unless you had
// installed it; each run now gets ion's own launcher first on its PATH, beside its run key.
describe("ion inside a run", () => {
  it("a run's env resolves ion", () => {
    const home = mkdtempSync(join(tmpdir(), "ion-bin-"));
    const cli = join(home, "cli.js");
    writeFileSync(cli, 'console.log("ion " + process.argv.slice(2).join(" "))');
    const bin = ionLauncher(join(home, "data"), cli);
    expect(bin).toBe(join(home, "data", "bin"));
    const env = runEnv({ chatId: "c1", cliKey: "k" }, bin);
    expect(env).toMatchObject({ ION_CHAT: "c1", ION_RUN_KEY: "k" });
    const out = execFileSync("/bin/sh", ["-c", "ion mcp ls"], { env: { ...process.env, ...env } }).toString();
    expect(out.trim()).toBe("ion mcp ls");
  });

  // Task review, 2026-11-21: the launcher is made fresh, never written through a link left in its place.
  it("never writes through a link at the launcher's place", () => {
    const home = mkdtempSync(join(tmpdir(), "ion-bin-"));
    const cli = join(home, "cli.js");
    writeFileSync(cli, "");
    const elsewhere = join(home, "elsewhere");
    writeFileSync(elsewhere, "mine");
    mkdirSync(join(home, "data", "bin"), { recursive: true });
    symlinkSync(elsewhere, join(home, "data", "bin", "ion"));
    ionLauncher(join(home, "data"), cli);
    expect(readFileSync(elsewhere, "utf8")).toBe("mine");
    expect(lstatSync(join(home, "data", "bin", "ion")).isSymbolicLink()).toBe(false);
  });

  it("gives no launcher when the CLI isn't there", () => {
    const home = mkdtempSync(join(tmpdir(), "ion-bin-"));
    expect(ionLauncher(join(home, "data"), join(home, "missing.js"))).toBeUndefined();
    expect(runEnv({ chatId: "c1" }, undefined)).toEqual({ ION_CHAT: "c1" });
  });
});
