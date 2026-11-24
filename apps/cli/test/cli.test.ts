import { execFile, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killUnder, processesUnder } from "@ion/test-temp/procs";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
let home: string;

function ion(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      "node",
      [BIN, ...args],
      // Debug mode: `ion harnesses` lists the fake agent too (it's hidden otherwise).
      { env: { ...process.env, ION_HOME: home, ION_ALLOW_FAKE: "1", ION_DEBUG: "1" } },
      (e, out, err) =>
        resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: out.trim(), err: err.trim() }),
    );
  });
}

/** `ion` with more environment (a made-up home for your agents' configs). */
function ionWith(
  env: Record<string, string>,
  ...args: string[]
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("node", [BIN, ...args], { env: { ...process.env, ION_HOME: home, ...env } }, (e, out, err) =>
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

const DAEMON_MAIN = fileURLToPath(new URL("../../daemon/dist/main.js", import.meta.url));
const started: number[] = [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const isIonDaemon = (pid: number) => {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)])
      .toString()
      .includes("daemon/dist/main.js");
  } catch {
    return false;
  }
};
/** Until `pid` is no longer a live ion daemon (a killed child left unreaped isn't one: ps shows it as defunct). */
const gone = async (pid: number) => {
  for (let i = 0; i < 200 && alive(pid) && isIonDaemon(pid); i++) await new Promise((r) => setTimeout(r, 25));
};
const daemonPid = (): number[] => {
  try {
    return [JSON.parse(readFileSync(join(home, "data", "daemon.json"), "utf8")).pid as number];
  } catch {
    return [];
  }
};

describe("ion cli", { timeout: 20_000 }, () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ion-cli-"));
  });
  // Found 2026-11-19: CLI tests left 11 daemons running in temp homes.
  // Every daemon a test starts (through the CLI or directly) is gone, and its home removed, afterwards.
  // 2026-11-23: daemons still starting under load (no daemon.json yet: `ion daemon start` gave up after 5 s) were
  // missed, and their agents (opencode, grok) outlived them. Whatever still runs under the test's home goes too, with
  // its process group; the hook has its own time (the default 10 s ran out under load, skipping the rest).
  afterEach(async () => {
    const pids = [...started.splice(0), ...daemonPid()];
    await ion("daemon", "stop");
    for (const pid of pids) if (alive(pid) && isIonDaemon(pid)) process.kill(pid, "SIGKILL");
    // A SIGKILL takes effect only when the process next runs: checked at once, a daemon on a busy machine still
    // looked alive ("cleans up a daemon that is still starting", flaky under the full suite, 2026-11-22). Wait for
    // each to be gone, then check.
    await Promise.all(pids.map(gone));
    const leaked = pids.filter((pid) => isIonDaemon(pid) && alive(pid));
    killUnder(home);
    rmSync(home, { recursive: true, force: true });
    expect(leaked).toEqual([]);
  }, 60_000);

  it("says ion isn't running before start, with exit 2", async () => {
    const r = await ion("status");
    expect(r.code).toBe(2);
    expect(r.err).toBe("ion isn't running. Start it with: ion daemon start");
  });

  it("starts once, and a second start says Already running", async () => {
    expect((await ion("daemon", "start")).out).toBe("Started");
    const again = await ion("daemon", "start");
    expect(again).toMatchObject({ code: 0, out: "Already running" });
    // Its first line; each ready agent's usage line follows (which agents are ready depends on the computer).
    expect((await ion("status")).out.split("\n")[0]).toBe("ion is running · 0 projects");
  });

  // The user, 2026-11-19: rename and remove projects.
  it("renames a project and removes it, keeping its folder", async () => {
    await ion("daemon", "start");
    const p = repo("shop");
    await ion("projects", "add", p);
    expect((await ion("projects", "rename", "shop", "My", "Shop")).out).toBe("Renamed shop");
    expect((await ion("projects", "ls")).out).toBe(`shop  My Shop  ${p}`);
    expect((await ion("projects", "remove", "shop")).out).toBe("Removed shop");
    expect((await ion("projects", "ls")).out).toBe("No projects");
    expect(existsSync(p)).toBe(true);
    expect((await ion("projects", "remove", "default")).err).toContain("default can't be removed");
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

  // The leak: a daemon still starting (no daemon.json yet) when a test ends was missed by `ion daemon stop`.
  // afterEach asserts it is gone.
  it("cleans up a daemon that is still starting when the test ends", () => {
    const d = spawn("node", [DAEMON_MAIN], { env: { ...process.env, ION_HOME: home }, stdio: "ignore" });
    started.push(d.pid!);
    expect(alive(d.pid!)).toBe(true);
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
    const d = spawn("node", [fileURLToPath(new URL("../../daemon/dist/main.js", import.meta.url))], {
      env: { ...process.env, ION_HOME: home },
      stdio: "ignore",
    });
    started.push(d.pid!);
    for (let i = 0; i < 50 && (await ion("status")).code !== 0; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(target, "utf8")).toBe("keep me");
    expect(lstatSync(join(home, "data", "daemon.json")).isSymbolicLink()).toBe(false);
  });

  // Regression (final review C2): two daemons could run on one data folder.
  it("runs only one daemon when two start at the same moment", async () => {
    const env = { ...process.env, ION_HOME: home };
    const a = spawn("node", [DAEMON_MAIN], { env, stdio: "ignore" });
    const b = spawn("node", [DAEMON_MAIN], { env, stdio: "ignore" });
    started.push(a.pid!, b.pid!);
    // The second daemon exits once it reaches the lock (its first step); loading the code first can take
    // seconds on a busy machine, so wait for it rather than a fixed 1.5 s (flaky under load, 2026-11-21).
    const live = () => [a.pid!, b.pid!].filter(alive);
    for (let i = 0; i < 150 && live().length > 1; i++) await new Promise((r) => setTimeout(r, 100));
    expect(live()).toHaveLength(1);
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

  // 2026-11-23, the Mac slowed down: ~13 test daemons, some 1½ days old, outlived the test runs that started them
  // (detached: a runner killed mid-way, or timed out, never stopped them). A test's daemon holds its run's lease.
  it("a daemon whose test run is gone stops by itself", async () => {
    const runner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    const lease = join(home, "lease");
    writeFileSync(lease, String(runner.pid));
    const started = await ionWith({ ION_TESTRUN_LEASE: lease }, "daemon", "start");
    runner.kill("SIGKILL");
    expect(started.out).toBe("Started");
    const [pid] = daemonPid();
    for (let i = 0; i < 100 && alive(pid!) && isIonDaemon(pid!); i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(isIonDaemon(pid!) && alive(pid!)).toBe(false);
  });

  // 2026-11-23: `opencode acp` and grok children (and what they start: servers, tools) outlived their daemons. Here a
  // stand-in opencode that starts a helper of its own, which nothing else ever stops.
  it("the agents ion started, and what they started, stop with it", async () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    const helper = `${process.execPath} -e 'setTimeout(() => {}, 300_000)' agent-helper`;
    writeFileSync(
      join(bin, "opencode"),
      `#!/bin/sh\n[ "$1" = --version ] && { echo 1.2.3; exit 0; }\n${helper} &\nexec ${process.execPath} -e 'setTimeout(() => {}, 300_000)'\n`,
      { mode: 0o755 },
    );
    expect((await ionWith({ PATH: `${bin}:${process.env.PATH}` }, "daemon", "start")).out).toBe("Started");
    const helpers = () => processesUnder(home).filter((p) => p.command.includes("agent-helper"));
    for (let i = 0; i < 100 && helpers().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(helpers().length).toBeGreaterThan(0);
    expect((await ion("daemon", "stop")).out).toBe("Stopped");
    for (let i = 0; i < 50 && helpers().length > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(helpers()).toEqual([]);
  });

  it("prints JSON status with --json", async () => {
    await ion("daemon", "start");
    expect(JSON.parse((await ion("status", "--json")).out)).toMatchObject({ projects: 0, configError: null });
  });

  // Golden: the CLI is a public interface; help text and messages change only on purpose.
  it("help output", async () => {
    const help = await Promise.all(
      [
        [],
        ["daemon"],
        ["projects"],
        ["ask"],
        ["needs"],
        ["chats"],
        ["memory"],
        ["todo"],
        ["harnesses"],
        ["harnesses", "order"],
        ["routines"],
        ["routines", "add"],
        ["suggestions"],
        ["mcp"],
        ["mcp", "add"],
        ["mcp", "import"],
        ["skills"],
        ["skills", "add"],
        ["hooks"],
        ["hooks", "add"],
      ].map((a) => ion(...a, "--help")),
    );
    await expect(help.map((h) => h.out).join("\n\n---\n\n") + "\n").toMatchFileSnapshot("../golden/help.txt");
  });

  // The user, 2026-11-21: "use the ion commands to add, verify, doctor mcp, skills, hooks" — everything added starts
  // off, and a key typed into a command is refused.
  it("adds, verifies, doctors, lists and removes an MCP server, a skill and a hook, all off", async () => {
    await ion("daemon", "start");
    const add = await ion(
      "mcp",
      "add",
      "tiny",
      "--command",
      process.execPath,
      "--arg",
      "-v",
      "--from",
      "x.example/tiny",
    );
    expect(add, add.err).toMatchObject({ code: 0, out: "tiny added, off" });
    expect((await ion("mcp", "ls")).out).toMatch(/^tiny\s+off\s+x\.example\/tiny$/);
    expect((await ion("mcp", "verify", "tiny")).out).toMatch(/^tiny\s+off\s+x\.example\/tiny$/);
    expect((await ion("mcp", "doctor", "tiny")).out).toMatch(/^tiny\s+off/);
    const secret = await ion(
      "mcp",
      "add",
      "gh",
      "--command",
      "gh-mcp",
      "--env",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
    expect(secret).toMatchObject({ code: 1, err: "Put keys in Settings" });
    const hook = await ion("hooks", "add", "--on", "run.finished", "--run", "say done", "--name", "Say done");
    expect(hook.out).toBe("Say done added, off");
    expect((await ion("hooks", "ls")).out).toMatch(/^Say done\s+off\s+Unknown source$/);
    const folder = mkdtempSync(join(tmpdir(), "ion-skill-"));
    writeFileSync(join(folder, "SKILL.md"), "---\nname: notes\ndescription: Takes notes\n---\nTake notes.");
    expect((await ion("skills", "add", "notes", "--from", folder)).out).toBe("notes added, off");
    expect((await ion("skills", "ls")).out).toMatch(/notes\s+off/);
    expect((await ion("mcp", "remove", "tiny")).out).toBe("Removed tiny");
    expect((await ion("mcp", "ls")).out).toBe("No connections");
  });

  // The user, 2026-11-21: "Only ion's, plus Import": `ion mcp import --list` reads your agents' own configs (here a
  // made-up home's), and import brings them in off, keys left out.
  it("lists your agents' servers and imports them, off", async () => {
    const agentHome = mkdtempSync(join(tmpdir(), "ion-cli-agents-"));
    const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const servers = {
      github: { command: "gh-mcp", env: { GITHUB_TOKEN: key } },
      old: { type: "sse", url: "https://o.example/sse" },
    };
    writeFileSync(join(agentHome, ".claude.json"), JSON.stringify({ mcpServers: servers }));
    const env = {
      HOME: agentHome,
      ION_AGENTS_HOME: agentHome,
      CODEX_HOME: "",
      GROK_HOME: "",
      XDG_CONFIG_HOME: "",
    };
    await ionWith(env, "daemon", "start");
    const list = await ionWith(env, "mcp", "import", "--list");
    expect(list.out).toMatch(/^github\s+Claude Code\s+gh-mcp\s+GITHUB_TOKEN$/m);
    expect(list.out).toContain("old (Claude Code): ion connects over HTTP, not SSE");
    expect(list.out).not.toContain(key);
    // Security review, 2026-11-21: nothing comes in unseen. With no names it shows what would, and how to bring it in.
    const bare = await ionWith(env, "mcp", "import");
    expect(bare.out).toMatch(/^github\s+Claude Code\s+gh-mcp\s+GITHUB_TOKEN$/m);
    expect(bare.out).toContain("Name them, or use --all");
    expect((await ion("mcp", "ls")).out).toBe("No connections");
    // Task review, 2026-11-21: --from is honoured when listing too.
    expect((await ionWith(env, "mcp", "import", "--list", "--from", "codex")).out).toMatch(
      /^Nothing to import/,
    );
    expect((await ionWith(env, "mcp", "import", "--from", "claude-code")).out).toMatch(
      /^github\s+Claude Code/m,
    );
    expect((await ionWith(env, "mcp", "import", "github")).out).toBe("Imported, off: github");
    expect((await ion("mcp", "ls")).out).toMatch(/^github\s+off\s+Imported from Claude Code$/);
    expect((await ionWith(env, "mcp", "import", "--list")).out).toMatch(/^Nothing to import/);
  });

  // Task review, 2026-11-21: inside a chat with its key dropped (python popping 'ION_'+'RUN_KEY', say), the CLI fell
  // back to ion's own token. With the chat's marker there and no key, it refuses.
  it("refuses ion's own token inside a chat whose key was dropped", async () => {
    await ion("daemon", "start");
    const r = await new Promise<{ code: number; err: string }>((resolve) =>
      execFile(
        "node",
        [BIN, "mcp", "ls"],
        { env: { ...process.env, ION_HOME: home, ION_CHAT: "chat_1", ION_RUN_KEY: "" } },
        (e, _out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, err: err.trim() }),
      ),
    );
    expect(r).toEqual({ code: 1, err: "Run this from ion's own app" });
  });

  // Plan 10: routines, from the command line.
  it("adds, lists, runs and removes a routine", async () => {
    await ion("daemon", "start");
    await ion("projects", "add", repo("app"));
    expect((await ion("routines")).out).toBe("No routines");
    const add = ["routines", "add", "Morning check", "-p", "app", "-w", "daily 9:00", "-d", "edit"];
    expect((await ion(...add)).out).toBe("Added morning-check to app: Every day 9:00");
    expect((await ion("routines", "add", "x", "-p", "app", "-w", "soon", "-d", "y")).err).toBe(
      "Pick when it runs",
    );
    const list = (await ion("routines")).out;
    expect(list).toMatch(/^morning-check {2}app {2}Every day 9:00 {2}\S/);
    // Its ion's threads run on the fake agent.
    const cfg = join(home, "config.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^path = .*$/m, '$&\nharness = "fake"'));
    expect((await ion("routines", "run", "morning-check")).out).toBe("Started Morning check");
    expect((await ion("routines", "run", "nope")).err).toBe("Unknown routine: nope");
    expect((await ion("routines", "remove", "morning-check")).out).toBe("Removed morning-check");
    expect((await ion("routines")).out).toBe("No routines");
  });

  // Task review, 2026-11-22: every connected command waited out reach()'s 1 s timeout timer before exiting.
  it("a connected command exits at once", async () => {
    await ion("daemon", "start");
    expect((await ion("status")).code).toBe(0);
    // Measured against a command that never connects, taking turns, and each the median of three: one slow start
    // on a loaded machine said 8.9 s (2026-11-23). The 1 s wait it guards against still shows on a quiet machine;
    // on a busy one the bound grows with how long a bare start takes.
    const took = async (...args: string[]) => {
      const t = Date.now();
      await ion(...args);
      return Date.now() - t;
    };
    const connected: number[] = [];
    const bare: number[] = [];
    for (let i = 0; i < 3; i++) {
      connected.push(await took("status"));
      bare.push(await took("--version"));
    }
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[1]!;
    expect(median(connected) - median(bare)).toBeLessThan(Math.max(600, median(bare) / 2));
  });

  // Plan 11: ion chief's suggestions, from the command line.
  it("lists suggestions, and says so for one it doesn't know", async () => {
    await ion("daemon", "start");
    expect((await ion("suggestions")).out).toBe("No suggestions");
    expect(JSON.parse((await ion("suggestions", "--json")).out)).toEqual([]);
    expect((await ion("suggestions", "take", "s0")).err).toBe("That suggestion is gone");
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

    // Plan 07: an allow is quiet (it's recorded); only a denial shows, with its reason.
    it("Auto: ion decides, the run never pauses, and only a denial is shown", async () => {
      writeFileSync(join(home, "config.toml"), '[access]\njudge = "fake"\n');
      await setup();
      const r = await ion("ask", "shell", "-p", "app", "--harness", "fake");
      expect(r.out).not.toContain("Allowed by ion");
      expect(r.out).toContain("Tests pass.");
      expect((await ion("needs")).out).toBe("Nothing needs you");
      const full = await ion("ask", "shell", "-p", "app", "--harness", "fake", "--access", "full");
      expect(full.out).not.toContain("by ion");
      expect(full.out).toContain("Tests pass.");
    });

    // Task review, 2026-11-21: `ion projects access` switched Auto-approval per project; only the composer's access
    // icon (and `ion ask --access`, per message) does now.
    it("has no projects access; access is per message", async () => {
      await setup();
      expect((await ion("projects", "access", "app", "full")).code).not.toBe(0);
      expect(await ion("ask", "hello", "-p", "app", "--harness", "fake", "--access", "maybe")).toMatchObject({
        code: 1,
        err: "Pick auto or full",
      });
    });

    it("lists harnesses with their models, and refuses an unknown model", async () => {
      await setup();
      expect((await ion("harnesses")).out).toContain("fake  Signed in  fake (default), fake-big");
      expect(await ion("ask", "hello", "-p", "app", "--harness", "fake", "--model", "nope")).toMatchObject({
        code: 1,
        err: "Unknown model for Fake: nope",
      });
    }, 60_000); // it asks each real agent CLI; slow under load

    // The user, 2026-11-22: the agent order is yours to set from the CLI too; the rest follow in ion's own order.
    it("puts agents in order", async () => {
      await setup();
      expect((await ion("harnesses", "order", "codex", "opencode")).out).toBe(
        "codex, opencode, grok-build, claude-code",
      );
      expect(await ion("harnesses", "order", "nope")).toMatchObject({ code: 1, err: "Unknown agent: nope" });
    });

    // Final review minor 8: one harness that fails to answer doesn't break the list.
    it("lists the other harnesses when one fails to answer", async () => {
      process.env.ION_FAKE_DETECT_FAIL = "1";
      try {
        await setup();
        const r = await ion("harnesses");
        expect(r.code).toBe(0);
        expect(r.out).toContain("fake  Not installed");
      } finally {
        delete process.env.ION_FAKE_DETECT_FAIL;
      }
    });

    // Re-review of #35, 2026-11-23: a sign-in that finished still exited 1 with "ion stopped" (the CLI's own close
    // of its connection read as ion stopping).
    it("a finished sign-in exits cleanly with how it ended", async () => {
      process.env.ION_FAKE_LOGIN_MS = "50";
      try {
        await setup();
        expect((await ion("harnesses", "logout", "fake", "--yes")).out).toBe("Not signed in");
        const r = await ion("harnesses", "login", "fake");
        expect(r).toMatchObject({ code: 0, err: "" });
        expect(r.out.split("\n").at(-1)).toBe("Signed in");
      } finally {
        delete process.env.ION_FAKE_LOGIN_MS;
      }
    }, 60_000);

    it("lists memory and says so for one it doesn't know", async () => {
      await setup();
      expect((await ion("memory", "ls", "-p", "app")).out).toBe("No memory");
      expect(await ion("memory", "forget", "nope")).toMatchObject({ code: 1, err: "Unknown memory: nope" });
    });

    // The user, 2026-11-23: "a way to disable memory": everywhere or in a project (`ion memory on|off [-p]`), and a
    // chat ion doesn't remember (`ion ask --no-memory`).
    it("turns memory off and on, and asks without memory", async () => {
      await setup();
      expect((await ion("memory", "off")).out).toBe("Memory off");
      expect((await ion("memory", "on", "-p", "app")).out).toBe("Memory on in app");
      expect((await ion("memory", "on")).out).toBe("Memory on");
      expect((await ion("memory", "off", "-p", "app")).out).toBe("Memory off in app");
      expect(await ion("memory", "off", "-p", "nope")).toMatchObject({
        code: 1,
        err: "Unknown project: nope",
      });
      const r = await ion("ask", "hello", "-p", "app", "--harness", "fake", "--no-memory");
      expect(r.code).toBe(0);
      const chats = JSON.parse((await ion("chats", "--json")).out) as { notRemembered?: boolean }[];
      expect(chats.map((c) => c.notRemembered)).toEqual([true]);
    });

    // The user, 2026-11-21: memory is a folder of small files you can read and fix yourself; the CLI lists, shows,
    // searches and forgets them, and opens the folder.
    it("the CLI lists, shows, searches and forgets", async () => {
      const mem = join(home, "data", "memory");
      const file = (path: string, head: string, text: string) => {
        mkdirSync(join(mem, path, ".."), { recursive: true });
        writeFileSync(join(mem, path), `---\n${head}\n---\n\n${text}\n`);
      };
      file(
        "you/short-replies.md",
        "name: Short replies\ndescription: Keep replies short\ntype: preference",
        "Short.",
      );
      file(
        "projects/app/test-runner.md",
        "name: Test runner\ndescription: Which tests\ntype: fact",
        "Tests use vitest.",
      );
      const todo =
        "name: Rotate keys\ndescription: Rotate the API keys\ntype: todo\nstatus: open\ndue: 2026-12-01";
      file("projects/app/rotate-keys.md", todo, "Rotate them.");
      file("you/call-sam.md", "name: Call Sam\ndescription: Call Sam\ntype: fact", "Call Sam.");
      await setup();
      const todoLine = "projects/app/rotate-keys.md  todo open 2026-12-01  Rotate keys: Rotate the API keys";
      const ls = (await ion("memory", "ls", "-p", "app")).out.split("\n");
      expect(ls[0]).toBe(todoLine);
      expect(ls).toContain("you/short-replies.md  preference  Short replies: Keep replies short");
      expect(ls).toHaveLength(4);
      expect((await ion("memory", "ls", "--open")).out).toBe(todoLine);
      expect((await ion("memory", "ls", "--type", "preference")).out).toBe(
        "you/short-replies.md  preference  Short replies: Keep replies short",
      );
      expect((await ion("memory", "show", "test-runner")).out).toBe(
        "Test runner\nWhich tests\nfact  projects/app/test-runner.md\n\nTests use vitest.",
      );
      expect((await ion("memory", "search", "vitest")).out).toBe(
        "projects/app/test-runner.md  fact  Test runner: Which tests",
      );
      expect((await ion("memory", "forget", "test-runner")).out).toBe("Forgotten");
      expect(existsSync(join(mem, "projects/app/test-runner.md"))).toBe(false);
      expect((await ion("memory", "search", "vitest")).out).toBe("Nothing found");
      expect((await ion("memory", "open")).out).toBe(mem);
      // Task 5, 2026-11-22 (tour): a file whose description is its name read "Call Sam: Call Sam".
      expect((await ion("memory", "search", "Sam")).out).toBe("you/call-sam.md  fact  Call Sam");
      // Security review, 2026-11-22: a chat's preference waits for you; keep makes it every project's.
      file("you/tabs.md", "name: Tabs\ndescription: Use tabs\ntype: preference\nsuggested: app", "Tabs.");
      const prefs = () => ion("memory", "ls", "--type", "preference");
      for (let i = 0; i < 30 && !(await prefs()).out.includes("tabs"); i++)
        await new Promise((r) => setTimeout(r, 200));
      expect((await prefs()).out).toContain("you/tabs.md  preference suggested  Tabs: Use tabs");
      expect((await ion("memory", "keep", "tabs")).out).toBe("Kept for every project");
      expect((await ion("memory", "ls", "--type", "preference")).out).toContain(
        "you/tabs.md  preference  Tabs: Use tabs",
      );
    });

    // The user, 2026-11-21: "does memory cover todo as well". To-dos are memory files; `ion todo` adds, lists and
    // closes them, the same files ion keeps.
    it("ion todo adds, lists and closes", async () => {
      await setup();
      expect((await ion("todo")).out).toBe("Nothing to do");
      expect((await ion("todo", "add", "Update the README", "--due", "2026-12-04")).out).toBe(
        "Added to your to-dos: Update the README (2026-12-04)",
      );
      expect((await ion("todo", "add", "Rotate keys", "-p", "app")).out).toBe(
        "Added to app's to-dos: Rotate keys",
      );
      // Task review, 2026-11-22: a name you type stays as you typed it (only agents' file-name names become words).
      expect((await ion("todo", "add", "e2e-tests")).out).toBe("Added to your to-dos: e2e-tests");
      expect(await ion("todo", "done", "e2e-tests")).toMatchObject({ code: 0 });
      expect(await ion("todo", "add", "Call the bank", "--due", "friday")).toMatchObject({
        code: 1,
        err: "Give the date as YYYY-MM-DD",
      });
      const both = "Update the README  due 2026-12-04\nRotate keys  app";
      expect((await ion("todo")).out).toBe(both);
      expect((await ion("todo", "ls")).out).toBe(both);
      const file = join(home, "data", "memory", "you", "update-the-readme.md");
      for (const line of ["type: todo", "status: open", "due: 2026-12-04"])
        expect(readFileSync(file, "utf8")).toContain(`\n${line}\n`);
      expect((await ion("todo", "done", "update-the-readme")).out).toBe("Done: Update the README");
      expect(readFileSync(file, "utf8")).toContain("status: done");
      expect((await ion("todo")).out).toBe("Rotate keys  app");
      // Task review, 2026-11-22: the list leads with the name; the path is in --json.
      const json = JSON.parse((await ion("todo", "--json")).out) as { memoryId: string }[];
      expect(json.map((m) => m.memoryId)).toEqual(["projects/app/rotate-keys.md"]);
      expect(await ion("todo", "done", "nope")).toMatchObject({ code: 1, err: "Unknown memory: nope" });
    });

    // Plan 09: ions from the CLI (messaging one starts real work, so only the list and a refusal here).
    it("lists ion chief and each project's ion, and refuses an ion it doesn't know", async () => {
      await setup();
      expect((await ion("ions")).out).toBe("chief  ion  -\napp    app  -");
      expect(await ion("ions", "message", "nope", "hello")).toMatchObject({
        code: 1,
        err: "Unknown ion: nope",
      });
    });

    it("lists chats and archives one", async () => {
      await setup();
      const r = await ion("ask", "hello there", "-p", "app", "--harness", "fake", "--json");
      const chatId = JSON.parse(r.out.split("\n")[0]!).chatId as string;
      // UX tour: lined-up columns, the title last so a long one doesn't push the others out.
      expect((await ion("chats")).out).toBe(`${chatId}  done  app  hello there`);
      expect((await ion("chats", "archive", chatId)).out).toBe("Archived");
      expect((await ion("chats")).out).toBe("No chats");
      expect(await ion("chats", "archive", "nope")).toMatchObject({ code: 1, err: "Unknown chat: nope" });
    });

    it("prints one JSON event per line with --json", async () => {
      await setup();
      const r = await ion("ask", "hello", "-p", "app", "--harness", "fake", "--json");
      const events = r.out.split("\n").map((l) => JSON.parse(l));
      expect(events.slice(0, 3).map((e) => e.type)).toEqual(["message.sent", "run.queued", "run.started"]);
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
