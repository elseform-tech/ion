import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bwrapArgs,
  removeProfiles,
  realForms,
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
    const data = realpathSync(mkdtempSync(join(tmpdir(), "ion-sbf-")));
    try {
      const paths = { ...FIXED, deny: [...FIXED.deny, data] };
      const w = sandboxed({ kind: "seatbelt", paths, dataDir: data }, "opencode", ["acp"]);
      expect(w.command).toBe("/usr/bin/sandbox-exec");
      expect(w.args[0]).toBe("-f");
      expect(w.args.slice(2)).toEqual(["opencode", "acp"]);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
    const b = sandboxed({ kind: "bwrap", paths: FIXED, dataDir: "/ion-test/data" }, "grok", [
      "agent",
      "stdio",
    ]);
    expect(b.command).toBe("bwrap");
    expect(b.args.slice(-4)).toEqual(["--", "grok", "agent", "stdio"]);
  });

  // The user, 2026-11-21: on a machine without a sandbox the run still starts (Settings says "Not sandboxed").
  it("runs a command as it is where there's no sandbox", () => {
    expect(sandboxed({ kind: "none", paths: FIXED, dataDir: "/ion-test/data" }, "grok", ["agent"])).toEqual({
      command: "grok",
      args: ["agent"],
    });
    expect(sandboxed(undefined, "grok", ["agent"])).toEqual({ command: "grok", args: ["agent"] });
  });

  it("adds an agent's own paths", () => {
    const sb = withPaths({ kind: "seatbelt", paths: FIXED, dataDir: "/d" }, { noWrite: ["/h/.grok/hooks"] });
    expect(sb?.paths.noWrite).toEqual([...FIXED.noWrite, "/h/.grok/hooks"]);
    expect(sb?.paths.deny).toEqual(FIXED.deny);
    expect(sb?.dataDir).toBe("/d");
  });
});

// Security review, 2026-11-28 (hooks fix, C1): a chat's agent could swap its worktree folder for a link to your home;
// the hook's sandbox then allowed writes there, after the deny, so over ion's own folders. A path the sandbox would
// let through that is, holds, or leads to one of ion's folders is left out, whatever asked for it.
describe("a path let through that would reach ion's folders", () => {
  it("is left out, linked or not; one inside ion's folders stays", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ion-sbg-")));
    try {
      const home = join(root, "home");
      const data = join(home, ".local", "share", "ion");
      const wt = join(data, "worktrees", "c1");
      mkdirSync(wt, { recursive: true });
      const link = join(data, "worktrees", "c2");
      symlinkSync(home, link);
      const paths = { deny: [data], read: [home], write: [wt, home, data, link], noWrite: [] };
      const profile = seatbeltProfile(paths);
      const allowed = profile.split("\n").filter((l) => l.startsWith("(allow file-read*"));
      expect(allowed.join("\n")).toContain(`(subpath "${wt}")`);
      expect(allowed.join("\n")).not.toContain(`(subpath "${home}")`);
      expect(allowed.join("\n")).not.toContain(`(subpath "${data}")`);
      expect(allowed.join("\n")).not.toContain(link);
      const b = bwrapArgs(paths, {});
      expect(b).toContain(wt);
      expect(b.filter((a) => a === home || a === link)).toEqual([]);
      expect(b.filter((a) => a === data)).toEqual([data]); // its empty folder over it, only
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Security re-review, 2026-11-28 (N1, N2): a link inside ion's folders (a chat's worktree root swapped for a link to
// another chat's worktree, or to config.toml) was let through with its target, so the run or hook could write there.
// Inside ion's folders a path is let through only as its own real path.
describe("a link inside ion's folders", () => {
  it("is never let through, nor what it leads to; the profile holds no other path inside ion's folders", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ion-sbl-")));
    try {
      const data = join(root, "data");
      const cfg = join(root, "cfg");
      const wts = join(data, "worktrees");
      for (const d of [join(wts, "c0"), join(wts, "c2"), cfg]) mkdirSync(d, { recursive: true });
      writeFileSync(join(cfg, "config.toml"), "");
      symlinkSync(join(wts, "c2"), join(wts, "c1"));
      symlinkSync(join(cfg, "config.toml"), join(wts, "c3"));
      const outside = join(root, "elsewhere");
      symlinkSync(join(cfg), outside);
      const paths = {
        deny: [data, cfg],
        read: [join(wts, "c3")],
        write: [join(wts, "c0"), join(wts, "c1"), join(wts, "c3"), outside],
        noWrite: [],
      };
      const allowed = seatbeltProfile(paths)
        .split("\n")
        .filter((l) => l.startsWith("(allow file-read*"))
        .join("\n");
      expect(allowed).toBe(`(allow file-read* file-write* (subpath "${join(wts, "c0")}"))`);
      const b = bwrapArgs(paths, {});
      const bound = b.filter((_a, i) => b[i - 1] === "--bind-try" || b[i - 1] === "--ro-bind-try");
      expect(bound).toEqual([join(wts, "c0")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Security re-review, 2026-11-28 (N8): Node's JS realpath keeps the letter case it's given, so on macOS a folder
// named in another case than ion's denied one could pass the "holds a denied folder" check.
describe.runIf(process.platform === "darwin")("a path in another letter case", () => {
  it("is resolved to the folder's own case, and one holding ion's folders is left out", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ion-sbc-")));
    try {
      const home = join(root, "Home");
      const data = join(home, "Data");
      mkdirSync(data, { recursive: true });
      const shouted = join(root, "HOME");
      expect(realForms(shouted)).toEqual([shouted, home]);
      const paths = { deny: [data], read: [], write: [shouted], noWrite: [] };
      expect(seatbeltProfile(paths)).not.toContain("(allow file-read* file-write*");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// CodeQL, PR #25, 2026-11-22: the Seatbelt profile went on sandbox-exec's command line as text built from paths taken
// from the environment (js/indirect-command-line-injection, js/shell-command-injection-from-environment). It goes in
// a 0600 file in a folder of ion's data folder that every run is denied, and every path in it is escaped or refused.
describe("the sandbox's rules file", () => {
  let data = "";
  beforeAll(() => {
    data = realpathSync(mkdtempSync(join(tmpdir(), "ion-sbf-")));
  });
  afterAll(() => rmSync(data, { recursive: true, force: true }));
  const sb = (extra: Partial<SandboxPaths> = {}): RunSandbox => ({
    kind: "seatbelt",
    paths: { deny: [data], read: [], write: [join(data, "worktrees", "w")], noWrite: [], ...extra },
    dataDir: data,
  });

  it("is a 0600 file in a 0700 folder of ion's data folder, read by sandbox-exec -f, holding the profile", () => {
    const s = sb();
    const w = sandboxed(s, "opencode", ["acp"]);
    expect(w.args.slice(0, 1)).toEqual(["-f"]);
    const file = w.args[1] ?? "";
    expect(file.startsWith(`${join(data, "sandbox")}/`)).toBe(true);
    expect(file).toMatch(/\/[0-9a-f]{64}\.sb$/);
    expect(readFileSync(file, "utf8")).toBe(seatbeltProfile(s.paths));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(data, "sandbox")).mode & 0o777).toBe(0o700);
    expect(w.args.join(" ")).not.toContain("(version 1)");
  });

  it("is removed when ion ends", () => {
    const file = sandboxed(sb({ read: [join(data, "skills")] }), "x", []).args[1] ?? "";
    expect(existsSync(file)).toBe(true);
    removeProfiles();
    expect(existsSync(file)).toBe(false);
  });

  it("is never written where a run could reach it", () => {
    expect(() => sandboxed({ ...sb(), paths: { ...sb().paths, deny: [] } }, "x", [])).toThrow();
  });

  it("escapes a quote and a backslash in a path", () => {
    const p = seatbeltProfile({ deny: [], read: [], write: ['/x/a "q" \\ b'], noWrite: [] });
    expect(p).toContain('(subpath "/x/a \\"q\\" \\\\ b")');
  });

  it("refuses a path with a newline or a NUL (Seatbelt and bubblewrap)", () => {
    for (const bad of ["/x/a\n(allow file-read*)", "/x/a\0b", "/x/a\rb"]) {
      const paths = { deny: [], read: [], write: [bad], noWrite: [] };
      expect(() => seatbeltProfile(paths), JSON.stringify(bad)).toThrow(/path/);
      expect(() => bwrapArgs(paths, {}), JSON.stringify(bad)).toThrow(/path/);
    }
    const ok = { deny: [], read: [], write: [], noWrite: [] };
    expect(() => bwrapArgs(ok, { XDG_RUNTIME_DIR: "/run/a\nb" })).toThrow(/path/);
  });

  // bubblewrap takes each path as its own argument (no shell): a space or a quote is just part of it.
  it("gives bubblewrap each path as its own argument", () => {
    const odd = '/x/a "q" b';
    const a = bwrapArgs({ deny: [], read: [], write: [odd], noWrite: [] }, {});
    expect(a.slice(-3)).toEqual(["--bind-try", odd, odd]);
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
  // Each script is fixed text; paths reach it only through its env (CodeQL on PR #25: nothing built into a shell string).
  const run = (script: string, vars: Record<string, string> = {}) => {
    const w = sandboxed(sb, "/bin/sh", ["-c", script]);
    const env = { ...process.env, ...vars };
    return spawnSync(w.command, w.args, { cwd: wt, env, encoding: "utf8", timeout: 15_000 });
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
    mkdirSync(join(data, "worktrees", 'odd "q" \\ b'));
    sb = {
      kind: "seatbelt",
      paths: {
        deny: [data, join(home, ".config", "ion")],
        read: [join(data, "skills", "run-1"), join(data, "bin")],
        write: [wt, join(data, "worktrees", 'odd "q" \\ b')],
        noWrite: [join(home, ".claude", "settings.json")],
      },
      dataDir: data,
    };
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  // Security re-review, 2026-11-28 (N3): ion's own reads of a chat's worktree ran in a sandbox that could write every
  // chat's worktree; a read runs where nothing can be written.
  it("read-only: reads the worktree, writes nothing anywhere", () => {
    const ro = { ...sb, paths: { ...sb.paths, read: [wt], write: [], readOnly: true } };
    const w = sandboxed(ro, "/bin/sh", [
      "-c",
      'cat a.txt; touch b.txt || echo nope; touch "$H/x" || echo nope; echo > /dev/null && echo ok',
    ]);
    const r = spawnSync(w.command, w.args, { cwd: wt, env: { ...process.env, H: home }, encoding: "utf8" });
    expect(r.stdout).toBe("in the worktree\nnope\nnope\nok\n");
    expect(existsSync(join(wt, "b.txt"))).toBe(false);
  });

  it("can't read daemon.json (cat, python, a script it wrote, a link, a moved folder)", () => {
    const file = join(data, "daemon.json");
    const vars = {
      F: file,
      UPPER: join(home, ".local", "share", "ION", "DAEMON.JSON"),
      DATA: data,
      B64: Buffer.from(file).toString("base64"),
      SHARE: join(home, ".local", "share"),
      MOVED: join(home, "moved"),
      MCP: join(home, ".config", "ion", "mcp.json"),
    };
    const tries = [
      'cat "$F"',
      'cat "$UPPER"',
      `python3 -c "import os; print(open(os.environ['DATA'] + '/daemon.json').read())"`,
      `printf 'cat "$F"\\n' > s.sh && sh s.sh`,
      'cat "$(echo "$B64" | base64 -d)"',
      'ln -s "$F" l && cat l',
      'ln "$F" h && cat h',
      'mv "$SHARE" "$MOVED"; cat "$MOVED/ion/daemon.json"',
      'cat "$MCP"',
      'ls "$DATA"',
    ];
    for (const t of tries) {
      const r = run(t, vars);
      expect(`${r.stdout}`, t).not.toContain("full-token");
      expect(`${r.stdout}`, t).not.toContain("{}");
      expect(r.status, t).not.toBe(0);
    }
  });

  it("can read and change its worktree, use git there, read its skills and run the launcher", () => {
    const r = run(
      'cat a.txt && echo new > b.txt && git add b.txt && git -c user.name=t -c user.email=t@t commit -qm t && cat "$SKILL" && "$ION"',
      { SKILL: join(data, "skills", "run-1", "SKILL.md"), ION: join(data, "bin", "ion") },
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("in the worktree\na skill\nlauncher ran\n");
  });

  // CodeQL, PR #25, 2026-11-22: the rules are a file now; a path with a quote and a backslash still works, and the
  // rules file itself is out of the run's reach.
  it("lets a path with a quote and a backslash through, and can't read its own rules file", () => {
    const odd = join(data, "worktrees", 'odd "q" \\ b');
    expect(run('echo x > "$D/f" && cat "$D/f"', { D: odd }).stdout).toBe("x\n");
    const file = sandboxed(sb, "/usr/bin/true", []).args[1] ?? "";
    expect(run('cat "$P"', { P: file }).status).not.toBe(0);
    expect(run('echo x > "$D/../other"', { D: odd }).status).not.toBe(0);
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
    const vars = { C: join(home, ".claude"), C2: join(home, "c2") };
    expect(run('mv "$C" "$C2"', vars).status).not.toBe(0);
    expect(run('echo x > "$C2/settings.json"', vars).status).not.toBe(0);
  });

  it("can't write its skills, the launcher or the agent's own config", () => {
    for (const f of [
      join(data, "skills", "run-1", "x"),
      join(data, "bin", "ion"),
      join(home, ".claude", "settings.json"),
    ])
      expect(run('echo x > "$F"', { F: f }).status, f).not.toBe(0);
    expect(run('echo x > "$F"', { F: join(home, ".claude", "other.json") }).status).toBe(0);
  });
});
