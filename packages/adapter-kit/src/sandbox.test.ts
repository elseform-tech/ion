import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bwrapArgs,
  type RunSandbox,
  sandboxed,
  sandboxKind,
  type SandboxPaths,
  seatbeltProfile,
  withPaths,
} from "./sandbox.js";

// The user, 2026-11-21: agents run in the OS sandbox, away from ion's own files. The Task 8 review showed a chat's
// agent, running as you, could read ion's full key from daemon.json and get round "only you turn it on"; word rules
// (the frozen command-parsing stopgaps) kept finding new tricks. The OS sandbox is the control.

/** Paths that exist nowhere, so the goldens read the same on every computer. */
const FIXED: SandboxPaths = {
  deny: ["/ion-test/home/.local/share/ion", "/ion-test/home/.config/ion", "/ion-test/home/.cache/ion"],
  read: ["/ion-test/home/.local/share/ion/skills/run-1", "/ion-test/home/.local/share/ion/bin"],
  write: ["/ion-test/home/.local/share/ion/worktrees/chat-1"],
  noWrite: ["/ion-test/home/.claude/settings.json", '/ion-test/home/odd "name"'],
};

describe("the sandbox's rules", () => {
  it("writes the Seatbelt profile (golden)", async () => {
    await expect(seatbeltProfile(FIXED)).toMatchFileSnapshot("../golden/seatbelt.sb");
  });

  it("writes bubblewrap's arguments (golden)", async () => {
    await expect(`${bwrapArgs(FIXED, {}).join("\n")}\n`).toMatchFileSnapshot("../golden/bwrap.txt");
  });

  // Task review, 2026-11-21: bubblewrap's run had the terminal's session (TIOCSTI), the D-Bus session socket and the
  // host's /dev/shm.
  it("gives bubblewrap's run its own session, no D-Bus session socket and its own /dev/shm", () => {
    const a = bwrapArgs(FIXED, { XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(a).toContain("--new-session");
    expect(a.join(" ")).toContain("--tmpfs /dev/shm");
    expect(a.join(" ")).toContain("--tmpfs /run/user/1000/bus");
  });

  it("wraps a command in the sandbox, every process it starts inside", () => {
    const sb: RunSandbox = { kind: "seatbelt", paths: FIXED };
    const w = sandboxed(sb, "opencode", ["acp"]);
    expect(w.command).toBe("/usr/bin/sandbox-exec");
    expect(w.args.slice(0, 1)).toEqual(["-p"]);
    expect(w.args.slice(2)).toEqual(["opencode", "acp"]);
    const b = sandboxed({ kind: "bwrap", paths: FIXED }, "grok", ["agent", "stdio"]);
    expect(b.command).toBe("bwrap");
    expect(b.args.slice(-4)).toEqual(["--", "grok", "agent", "stdio"]);
  });

  // The user, 2026-11-21: on a machine without a sandbox the run still starts (Settings says "Not sandboxed").
  it("runs a command as it is where there's no sandbox", () => {
    expect(sandboxed({ kind: "none", paths: FIXED }, "grok", ["agent"])).toEqual({
      command: "grok",
      args: ["agent"],
    });
    expect(sandboxed(undefined, "grok", ["agent"])).toEqual({ command: "grok", args: ["agent"] });
  });

  it("adds an agent's own paths", () => {
    const sb = withPaths({ kind: "seatbelt", paths: FIXED }, { noWrite: ["/h/.grok/hooks"] });
    expect(sb?.paths.noWrite).toEqual([...FIXED.noWrite, "/h/.grok/hooks"]);
    expect(sb?.paths.deny).toEqual(FIXED.deny);
  });
});

const real = sandboxKind() === "seatbelt";

/** osascript asking Finder its name, in the sandbox, as [command, args]. */
const osascript = (sb: RunSandbox): [string, string[]] => {
  const w = sandboxed(sb, "osascript", ["-e", 'tell application "Finder" to get name']);
  return [w.command, w.args];
};

/** A pretend home with ion's data folder in it: daemon.json, a worktree, the run's skills and the launcher. */
describe.skipIf(!real)("a run in the real sandbox (macOS)", () => {
  let home = "";
  let data = "";
  let wt = "";
  let sb: RunSandbox;
  const run = (script: string, cwd = wt) => {
    const w = sandboxed(sb, "/bin/sh", ["-c", script]);
    return spawnSync(w.command, w.args, { cwd, encoding: "utf8", timeout: 15_000 });
  };

  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "ion-sb-")));
    data = join(home, ".local", "share", "ion");
    wt = join(data, "worktrees", "chat-1");
    for (const d of [wt, join(data, "skills", "run-1"), join(data, "bin"), join(home, ".config", "ion")])
      mkdirSync(d, { recursive: true });
    writeFileSync(join(data, "daemon.json"), '{"token":"full-token"}\n');
    writeFileSync(join(home, ".config", "ion", "mcp.json"), "{}\n");
    writeFileSync(join(wt, "a.txt"), "in the worktree\n");
    writeFileSync(join(data, "skills", "run-1", "SKILL.md"), "a skill\n");
    writeFileSync(join(data, "bin", "ion"), "#!/bin/sh\necho launcher ran\n");
    chmodSync(join(data, "bin", "ion"), 0o755);
    mkdirSync(join(home, ".claude"));
    execFileSync("git", ["init", "-q"], { cwd: wt });
    sb = {
      kind: "seatbelt",
      paths: {
        deny: [data, join(home, ".config", "ion")],
        read: [join(data, "skills", "run-1"), join(data, "bin")],
        write: [wt],
        noWrite: [join(home, ".claude", "settings.json")],
      },
    };
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("can't read daemon.json (cat, python, a script it wrote, a link, a moved folder)", () => {
    const file = join(data, "daemon.json");
    const tries = [
      `cat ${file}`,
      `cat ${join(home, ".local", "share", "ION", "DAEMON.JSON")}`,
      `python3 -c "print(open('${data}/' + 'daemon.json').read())"`,
      `printf 'cat ${file}\\n' > s.sh && sh s.sh`,
      `cat "$(echo ${Buffer.from(file).toString("base64")} | base64 -d)"`,
      `ln -s ${file} l && cat l`,
      `ln ${file} h && cat h`,
      `mv ${join(home, ".local", "share")} ${join(home, "moved")}; cat ${join(home, "moved", "ion", "daemon.json")}`,
      `cat ${join(home, ".config", "ion", "mcp.json")}`,
      `ls ${data}`,
    ];
    for (const t of tries) {
      const r = run(t);
      expect(`${r.stdout}`, t).not.toContain("full-token");
      expect(`${r.stdout}`, t).not.toContain("{}");
      expect(r.status, t).not.toBe(0);
    }
  });

  it("can read and change its worktree, use git there, read its skills and run the launcher", () => {
    const r = run(
      `cat a.txt && echo new > b.txt && git add b.txt && git -c user.name=t -c user.email=t@t commit -qm t && cat ${join(data, "skills", "run-1", "SKILL.md")} && ${join(data, "bin", "ion")}`,
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("in the worktree\na skill\nlauncher ran\n");
  });

  // Task review, 2026-11-21: `open -g Probe.app` started an app through LaunchServices, outside the sandbox, and it
  // copied daemon.json. Launching apps and sending Apple Events are refused; ordinary tools still run.
  it("can't start an app or send Apple Events (they'd run outside the sandbox)", () => {
    expect(run("open -g -j -a Calculator").status).not.toBe(0);
    // Refused, osascript waits on LaunchServices: stopped at the time limit, it never got Finder's answer.
    const osa = spawnSync(...osascript(sb), { encoding: "utf8", timeout: 3000 });
    expect([osa.status, osa.stdout]).not.toEqual([0, "Finder\n"]);
    expect(osa.status).not.toBe(0);
    expect(run("node -e 'console.log(1)' && git --version && python3 -c 'print(2)'").status).toBe(0);
  }, 30_000);

  // Security review, 2026-11-21: renaming the folder above an agent's config moved it out from under the rule
  // (`mv ~/.claude ~/.c2`, then write ~/.c2/settings.json).
  it("can't move the folders that hold the agent's config", () => {
    expect(run(`mv ${join(home, ".claude")} ${join(home, "c2")}`).status).not.toBe(0);
    expect(run(`echo x > ${join(home, "c2", "settings.json")}`).status).not.toBe(0);
  });

  it("can't write its skills, the launcher or the agent's own config", () => {
    for (const f of [
      join(data, "skills", "run-1", "x"),
      join(data, "bin", "ion"),
      join(home, ".claude", "settings.json"),
    ])
      expect(run(`echo x > ${f}`).status, f).not.toBe(0);
    expect(run(`echo x > ${join(home, ".claude", "other.json")}`).status).toBe(0);
  });
});
