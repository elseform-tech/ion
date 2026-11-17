import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
let home: string;

function ion(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("node", [BIN, ...args], { env: { ...process.env, ION_HOME: home } }, (e, out, err) =>
      resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: out.trim(), err: err.trim() }),
    );
  });
}

const repo = (name: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "ion-repo-")), name);
  mkdirSync(join(p, ".git"), { recursive: true });
  return p;
};

describe("ion cli", { timeout: 20_000 }, () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ion-cli-"));
  });
  afterEach(async () => {
    await ion("daemon", "stop");
  });

  it("says ion isn't running before start, with exit 2", async () => {
    const r = await ion("status");
    expect(r.code).toBe(2);
    expect(r.err).toBe("ion isn't running. Start it with: ion daemon start");
  });

  it("starts once, and a second start says Already running", async () => {
    expect((await ion("daemon", "start")).out).toBe("Started");
    const again = await ion("daemon", "start");
    expect(again).toMatchObject({ code: 0, out: "Already running" });
    expect((await ion("status")).out).toBe("ion is running · 0 projects");
  });

  it("adds and lists projects", async () => {
    await ion("daemon", "start");
    const p = repo("storefront");
    expect((await ion("projects", "add", p)).out).toBe("Added storefront");
    const ls = JSON.parse((await ion("projects", "ls", "--json")).out);
    expect(ls).toEqual([{ id: "storefront", path: p, starred: false }]);
    expect((await ion("projects", "ls")).out).toBe(`storefront  ${p}`);
  });

  it("rejects a folder that isn't a git repo, with exit 1", async () => {
    await ion("daemon", "start");
    const r = await ion("projects", "add", "/nope");
    expect(r).toMatchObject({ code: 1, err: "Not a git repository: /nope" });
  });

  it("treats a leftover daemon.json from a dead process as not running", async () => {
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(join(home, "data", "daemon.json"), JSON.stringify({ pid: 999999, port: 1, token: "x" }));
    expect((await ion("status")).code).toBe(2);
    expect((await ion("daemon", "start")).out).toBe("Started");
    expect((await ion("status")).code).toBe(0);
  });

  it("writes daemon.json readable only by you", async () => {
    await ion("daemon", "start");
    expect(statSync(join(home, "data", "daemon.json")).mode & 0o777).toBe(0o600);
  });

  it("never writes through a planted daemon.json symlink", async () => {
    const target = join(home, "elsewhere.txt");
    writeFileSync(target, "keep me");
    mkdirSync(join(home, "data"), { recursive: true });
    symlinkSync(target, join(home, "data", "daemon.json"));
    // Start the daemon itself (not through the CLI, which clears the file first).
    spawn("node", [fileURLToPath(new URL("../../daemon/dist/main.js", import.meta.url))], {
      env: { ...process.env, ION_HOME: home },
      stdio: "ignore",
    });
    for (let i = 0; i < 50 && (await ion("status")).code !== 0; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(target, "utf8")).toBe("keep me");
    expect(lstatSync(join(home, "data", "daemon.json")).isSymbolicLink()).toBe(false);
  });

  const DAEMON_MAIN = fileURLToPath(new URL("../../daemon/dist/main.js", import.meta.url));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // Regression (final review C2): two daemons could run on one data folder.
  it("runs only one daemon when two start at the same moment", async () => {
    const env = { ...process.env, ION_HOME: home };
    const a = spawn("node", [DAEMON_MAIN], { env, stdio: "ignore" });
    const b = spawn("node", [DAEMON_MAIN], { env, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1500));
    const live = [a.pid!, b.pid!].filter(alive);
    expect(live).toHaveLength(1);
    expect((await ion("status")).code).toBe(0);
  });

  // Regression (final review C3): stop used to kill whatever process reused the daemon's old pid.
  it("never stops a process that isn't ion", async () => {
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(join(home, "data", "daemon.json"), JSON.stringify({ pid: other.pid, port: 1, token: "x" }));
    expect((await ion("daemon", "stop")).out).toBe("Not running");
    expect(alive(other.pid!)).toBe(true);
    other.kill();
  });

  // Regression (final review I1): a reused pid used to block start forever.
  it("starts even when daemon.json names a live process that isn't ion", async () => {
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(join(home, "data", "daemon.json"), JSON.stringify({ pid: other.pid, port: 1, token: "x" }));
    writeFileSync(join(home, "data", "daemon.lock"), String(other.pid));
    expect((await ion("daemon", "start")).out).toBe("Started");
    expect((await ion("status")).code).toBe(0);
    expect(alive(other.pid!)).toBe(true);
    other.kill();
  });

  it("stops and removes daemon.json", async () => {
    await ion("daemon", "start");
    expect((await ion("daemon", "stop")).out).toBe("Stopped");
    expect(existsSync(join(home, "data", "daemon.json"))).toBe(false);
  });

  it("prints JSON status with --json", async () => {
    await ion("daemon", "start");
    expect(JSON.parse((await ion("status", "--json")).out)).toMatchObject({ projects: 0, configError: null });
  });

  // Golden: the CLI is a public interface; help text and messages change only on purpose.
  it("help output", async () => {
    const help = await Promise.all([[], ["daemon"], ["projects"]].map((a) => ion(...a, "--help")));
    await expect(help.map((h) => h.out).join("\n\n---\n\n") + "\n").toMatchFileSnapshot("../golden/help.txt");
  });
});
