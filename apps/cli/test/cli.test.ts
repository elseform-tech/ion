import { execFile, execFileSync, spawn } from "node:child_process";
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
    execFile(
      "node",
      [BIN, ...args],
      { env: { ...process.env, ION_HOME: home, ION_ALLOW_FAKE: "1" } },
      (e, out, err) =>
        resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: out.trim(), err: err.trim() }),
    );
  });
}

const repo = (name: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "ion-repo-")), name);
  mkdirSync(p, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: p });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
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

  describe("ion ask", () => {
    const setup = async () => {
      await ion("daemon", "start");
      const p = repo("app");
      await ion("projects", "add", p);
      return p;
    };
    const stable = (s: string) => s.replace(/Done · \S+/, "Done · Ns");

    it("streams a run and ends with Done", async () => {
      await setup();
      const r = await ion("ask", "hello", "-p", "app", "--harness", "fake");
      expect(r.code).toBe(0);
      await expect(`${stable(r.out)}\n`).toMatchFileSnapshot("../golden/ask-hello.txt");
    });

    it("edits inside the chat's worktree without asking", async () => {
      const p = await setup();
      const r = await ion("ask", "approve", "-p", "app", "--harness", "fake");
      expect(r.out).toContain("· Edited notes.md");
      expect(r.code).toBe(0);
      expect(existsSync(join(p, "notes.md"))).toBe(false);
    });

    it("prints one JSON event per line with --json", async () => {
      await setup();
      const r = await ion("ask", "hello", "-p", "app", "--harness", "fake", "--json");
      const events = r.out.split("\n").map((l) => JSON.parse(l));
      expect(events[0].type).toBe("run.started");
      expect(events.at(-1)).toMatchObject({ type: "run.finished", data: { status: "done" } });
    });

    it("explains an unknown project with exit 1", async () => {
      await setup();
      const r = await ion("ask", "hello", "-p", "nope", "--harness", "fake");
      expect(r).toMatchObject({ code: 1, err: "Unknown project: nope" });
    });

    // Regression (final review I7): the CLI hung when the daemon went away mid-run.
    const askSlowThen = async (onRunning: () => void) => {
      const child = spawn("node", [BIN, "ask", "slow", "-p", "app", "--harness", "fake"], {
        env: { ...process.env, ION_HOME: home, ION_ALLOW_FAKE: "1" },
      });
      let out = "";
      let err = "";
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.stdout.on("data", (d) => {
        out += d;
        if (out.includes("sleep 30")) onRunning();
      });
      const code = await new Promise<number | null>((r) => child.on("exit", r));
      return { code, out, err };
    };

    it("reports the run as failed when ion is stopped mid-run", async () => {
      await setup();
      const r = await askSlowThen(() => void ion("daemon", "stop"));
      expect(r.code).toBe(1);
      expect(r.out).toContain("Failed: ion stopped");
    });

    it("says it lost the connection when ion crashes mid-run", async () => {
      await setup();
      const { pid } = JSON.parse(readFileSync(join(home, "data", "daemon.json"), "utf8"));
      const r = await askSlowThen(() => process.kill(pid, "SIGKILL"));
      expect(r.code).toBe(1);
      expect(r.err).toContain("Lost the connection to ion");
    });

    // Regression (final review I9): signed-out harness → the sign-in hint and exit 1.
    it("shows the sign-in hint when the harness is signed out", async () => {
      process.env.ION_FAKE_SIGNED_OUT = "1";
      try {
        await setup();
        const r = await ion("ask", "hello", "-p", "app", "--harness", "fake");
        expect(r).toMatchObject({ code: 1, err: "Fake isn't signed in. Run: ion fake login" });
      } finally {
        delete process.env.ION_FAKE_SIGNED_OUT;
      }
    });

    it("stops on Ctrl+C with exit 130", async () => {
      await setup();
      const child = spawn("node", [BIN, "ask", "slow", "-p", "app", "--harness", "fake"], {
        env: { ...process.env, ION_HOME: home, ION_ALLOW_FAKE: "1" },
      });
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
        if (out.includes("sleep 30")) child.kill("SIGINT");
      });
      const code = await new Promise<number | null>((r) => child.on("exit", r));
      expect(out).toContain("Stopped");
      expect(code).toBe(130);
    });
  });
});
