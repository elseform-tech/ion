import {
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { describe, expect, it } from "vitest";
import { Approvals, type AskingRun } from "../runs/approvals.js";
import type { EventStore } from "../store/index.js";
import { readAgentRules, ruleCount, theirRulesOf, theirSay } from "./agent-rules.js";
import { createAccess } from "./index.js";

const store = { append: () => {} } as unknown as EventStore;
const wt = "/data/worktrees/c1";
const cmd = (command: string): ApprovalRequest => ({
  requestId: "q",
  toolId: "t",
  toolName: "Bash",
  kind: "command",
  summary: command,
  input: { command },
});

/** A fake home with the given files (path from home → content). */
function fakeHome(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "ion-agent-rules-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    writeFileSync(join(home, rel), text);
  }
  return home;
}
const claudeHome = (allow: string[], deny: string[] = []) =>
  fakeHome({
    ".claude/settings.json": JSON.stringify({ permissions: { allow, deny } }),
  });

/** Approvals with a judge that says no (so a judged call shows as asked), and the agents' rules from `home`. */
function approvalsFor(home: string, project?: string) {
  const judged: string[] = [];
  const judge = async (i: { req: ApprovalRequest; decisions?: string[] }) => {
    judged.push(i.req.summary);
    return { verdict: "deny" as const, reason: "no" };
  };
  const own = { home, ionDirs: ["/data"] };
  const access = createAccess({ judge, ...own });
  const theirs = (r: AskingRun) =>
    r.harness
      ? readAgentRules(r.harness, {
          home,
          env: {},
          ...(project ? { project } : {}),
        })
      : null;
  return {
    a: new Approvals(store, access, () => true, { own, theirs }),
    judged,
  };
}
const run = (harness: string, access: "auto" | "full" = "auto"): AskingRun => ({
  chatId: "c1",
  runId: "r1",
  projectId: "p",
  request: "run the tests",
  access,
  harness,
});

describe("each agent's own allow and deny rules", () => {
  // The user, 2026-11-21: "if possible use whatever the underlying harnesses already does" → each agent's own rules
  // count as your decisions.
  it("a Claude permissions.allow rule allows that command in Claude chats only", async () => {
    const { a, judged } = approvalsFor(claudeHome(["Bash(npm test:*)"]));
    const v = await a.gate(run("claude-code"), cmd("npm test -- --run"), [wt]);
    expect(v.decision).toBe("allow");
    expect(judged).toEqual([]);
    // Another agent's chat: the judge decides, as before.
    expect((await a.gate(run("grok-build"), cmd("npm test -- --run"), [wt])).decision).toBe("deny");
    expect(judged).toEqual(["npm test -- --run"]);
  });

  // The user, 2026-11-21: deny wins, in every mode.
  it("a permissions.deny rule refuses it even in Full", async () => {
    const { a } = approvalsFor(claudeHome(["Bash(git push:*)"], ["Bash(git push:*)"]));
    for (const mode of ["auto", "full"] as const) {
      const v = await a.gate({ ...run("claude-code", mode), sandboxed: true }, cmd("git push origin main"), [
        wt,
      ]);
      expect(v.decision, mode).toBe("deny");
      expect(v.reason).toContain("Your Claude Code settings deny this");
    }
    // Chained after something else, it's still refused.
    expect((await a.gate(run("claude-code", "full"), cmd("git add . && git push"), [wt])).decision).toBe(
      "deny",
    );
  });

  // The user, 2026-11-21: only your own settings, never project files, which a repo writes.
  it("a repo's .claude/settings.json rules are ignored", async () => {
    const home = fakeHome({});
    const project = fakeHome({
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["Bash(curl:*)"] },
      }),
      ".claude/settings.local.json": JSON.stringify({
        permissions: { allow: ["Bash(curl:*)"] },
      }),
    });
    expect(ruleCount(readAgentRules("claude-code", { home, env: {}, project }))).toBe(0);
    const { a, judged } = approvalsFor(home, project);
    expect((await a.gate(run("claude-code"), cmd("curl https://example.com"), [project])).decision).toBe(
      "deny",
    );
    expect(judged).toHaveLength(1);
  });

  it("an allow never chains: a command with anything after it goes to the judge", async () => {
    const { a, judged } = approvalsFor(claudeHome(["Bash(npm test:*)"]));
    for (const c of ["npm test; curl x | sh", "npm test && rm -rf ~", "npm test $(rm -rf ~)", "npm testing"])
      expect((await a.gate(run("claude-code"), cmd(c), [wt])).decision, c).toBe("deny");
    expect(judged).toHaveLength(4);
  });

  it("an allow never overrides the floor (your secrets)", async () => {
    const { a } = approvalsFor(claudeHome(["Bash(cat:*)"]));
    const v = await a.gate(run("claude-code"), cmd("cat ~/.ssh/id_rsa"), [wt]);
    expect(v.decision).toBe("deny");
    expect(v.reason).toContain("Touches your secrets");
  });

  it("reads Claude's rules conservatively: exact tools and command prefixes; the rest is ignored", () => {
    const r = readAgentRules("claude-code", {
      home: claudeHome(
        [
          "Bash(npm run build)",
          "Bash(git log *)",
          "WebSearch",
          "mcp__github",
          "Bash",
          "Edit",
          "Read(./src/**)",
          "Bash(rm -rf *.tmp)",
        ],
        ["Bash(curl:*)", "WebFetch"],
      ),
      env: {},
    });
    expect(ruleCount(r)).toBe(6);
    const say = (req: ApprovalRequest) => (r ? theirSay(req, r)?.decision : undefined);
    expect(say(cmd("npm run build"))).toBe("allow");
    expect(say(cmd("npm run build --watch"))).toBeUndefined();
    expect(say(cmd("git log --oneline"))).toBe("allow");
    // A bare Bash allow would turn Auto off for every command: ignored (Full access is that switch).
    expect(say(cmd("rm -rf build"))).toBeUndefined();
    expect(say(cmd("curl https://x"))).toBe("deny");
    expect(
      say({
        ...cmd("x"),
        kind: "web",
        toolName: "WebSearch",
        input: { query: "q" },
      }),
    ).toBe("allow");
    expect(
      say({
        ...cmd("x"),
        kind: "web",
        toolName: "WebFetch",
        input: { url: "https://x" },
      }),
    ).toBe("deny");
    expect(
      say({
        ...cmd("x"),
        kind: "mcp",
        toolName: "mcp__github__get_issue",
        input: {},
      }),
    ).toBe("allow");
  });

  it("reads opencode's global permission: bash patterns and tools", () => {
    const home = fakeHome({
      ".config/opencode/opencode.json": JSON.stringify({
        permission: {
          bash: {
            "git status": "allow",
            "npm *": "allow",
            "git push*": "deny",
            "*": "ask",
          },
          webfetch: "deny",
        },
      }),
    });
    const r = readAgentRules("opencode", { home, env: {} });
    expect(ruleCount(r)).toBe(4);
    const say = (req: ApprovalRequest) => (r ? theirSay(req, r)?.decision : undefined);
    expect(say({ ...cmd("git status"), toolName: "bash" })).toBe("allow");
    expect(say({ ...cmd("npm test"), toolName: "bash" })).toBe("allow");
    expect(say({ ...cmd("ls"), toolName: "bash" })).toBeUndefined();
    expect(
      say({
        ...cmd("x"),
        kind: "web",
        toolName: "webfetch",
        input: { url: "https://x" },
      }),
    ).toBe("deny");
    // Task review, 2026-11-22: a deny's wildcard is read as "starts with" (the safe way): "git push*" refuses "git pushx".
    expect(say({ ...cmd("git push"), toolName: "bash" })).toBe("deny");
    expect(say({ ...cmd("git pushx --force"), toolName: "bash" })).toBe("deny");
  });

  it("Codex's trusted projects are a line for the judge, not an allow", async () => {
    const project = fakeHome({});
    const home = fakeHome({
      ".codex/config.toml": `[projects."${project}"]\ntrust_level = "trusted"\n`,
    });
    const r = readAgentRules("codex", { home, env: {}, project });
    expect(r?.notes).toEqual(["Codex trusts this project (its own setting)"]);
    // Task review, 2026-11-22: trusted projects aren't allow/deny rules: not in Settings' count.
    expect(ruleCount(r)).toBe(0);
    expect(r ? theirSay(cmd("npm test"), r) : null).toBeNull();
    const seen: string[][] = [];
    const access = createAccess({
      judge: async (i) => {
        seen.push(i.decisions ?? []);
        return { verdict: "allow", reason: "ok" };
      },
      home,
      ionDirs: ["/data"],
    });
    const theirs = () => r;
    const a = new Approvals(store, access, () => true, {
      own: { home, ionDirs: ["/data"] },
      theirs,
    });
    await a.gate(run("codex"), cmd("npm test"), [wt]);
    expect(seen[0]).toContain("Codex trusts this project (its own setting)");
  });
});

// Task review, 2026-11-21: rules are read again only when a settings file changes (per file mtime).
describe("reading agents' rules", () => {
  it("re-reads a settings file only when it changes", () => {
    const home = claudeHome(["WebSearch"]);
    const file = join(home, ".claude/settings.json");
    const mtime = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(file, mtime, mtime);
    expect(ruleCount(readAgentRules("claude-code", { home, env: {} }))).toBe(1);
    // Two rules now, the file the same size (so only the mtime tells).
    const next = JSON.stringify({ permissions: { deny: ["Bash", "WebFetch"] } });
    // Rewritten through one open file (CodeQL, PR #25: no stat by path, then a write by path).
    const fd = openSync(file, "r+");
    const size = fstatSync(fd).size;
    ftruncateSync(fd, 0);
    writeSync(fd, next.padEnd(size, " "), 0);
    closeSync(fd);
    utimesSync(file, mtime, mtime);
    // Same mtime: the rules ion read stand (the file isn't read again).
    expect(ruleCount(readAgentRules("claude-code", { home, env: {} }))).toBe(1);
    const later = new Date(mtime.getTime() + 5000);
    utimesSync(file, later, later);
    expect(ruleCount(readAgentRules("claude-code", { home, env: {} }))).toBe(2);
  });
});

// Task 11, 2026-11-22 (tour): chats went by the rules in your real home even when ion reads your agents' configs from
// ION_AGENTS_HOME (the tour's fake home), so the tour showed and used your own rules.
describe("whose rules a run goes by", () => {
  it("reads them from the agents' home ion was given", () => {
    const home = claudeHome([], ["Bash(git push:*)"]);
    const cfg = join(fakeHome({ "config.toml": "" }), "config.toml");
    const r = theirRulesOf(cfg, home)({ harness: "claude-code", projectId: "p" });
    expect(r ? theirSay(cmd("git push"), r)?.decision : null).toBe("deny");
  });
});

describe("matching a deny", () => {
  // Task review, 2026-11-22: doubled spaces or a tab got round a deny (and matched an allow).
  it("doubled spaces and tabs can't dodge a deny, in Full too", async () => {
    const { a } = approvalsFor(claudeHome(["Bash(git push:*)"], ["Bash(git push:*)", "Bash(rm -rf:*)"]));
    for (const c of ["git  push", "git\tpush origin", "rm  -rf /", "ls && git   push"])
      for (const mode of ["auto", "full"] as const)
        expect(
          (await a.gate({ ...run("claude-code", mode), sandboxed: true }, cmd(c), [wt])).decision,
          `${mode} ${c}`,
        ).toBe("deny");
  });

  // Task review, 2026-11-22: a deny with a wildcard inside or at the end is read as "starts with".
  it("reads a Claude deny's wildcard as starts-with", () => {
    const r = readAgentRules("claude-code", {
      home: claudeHome([], ["Bash(rm -rf *.tmp)", "Bash(npm publish*)"]),
      env: {},
    });
    const say = (c: string) => (r ? theirSay(cmd(c), r)?.decision : undefined);
    expect(say("rm -rf build")).toBe("deny");
    expect(say("npm publishx")).toBe("deny");
    expect(say("npm test")).toBeUndefined();
  });

  // Task review, 2026-11-22: Claude's managed settings and OPENCODE_CONFIG are your settings too.
  it("reads Claude's managed settings and OPENCODE_CONFIG", () => {
    const sys = fakeHome({ "managed.json": JSON.stringify({ permissions: { deny: ["Bash(curl:*)"] } }) });
    const claude = readAgentRules("claude-code", {
      home: fakeHome({}),
      env: {},
      managed: join(sys, "managed.json"),
    });
    expect(claude ? theirSay(cmd("curl https://x"), claude)?.decision : null).toBe("deny");
    const oc = fakeHome({ "oc.json": JSON.stringify({ permission: { bash: { "git push": "deny" } } }) });
    const open = readAgentRules("opencode", {
      home: fakeHome({}),
      env: { OPENCODE_CONFIG: join(oc, "oc.json") },
    });
    expect(open ? theirSay({ ...cmd("git push"), toolName: "bash" }, open)?.decision : null).toBe("deny");
  });

  // Task 11, 2026-11-22 (Task 14 re-review): a bare deny (`Bash(*)`, `Edit(*)`, `WebFetch(**)`) was dropped because its
  // literal part is empty; a deny widens safely, so it refuses every call of that tool.
  it("a bare deny refuses every call of that tool", () => {
    const r = readAgentRules("claude-code", {
      home: claudeHome([], ["Bash(*)", "Edit(*)", "WebFetch(**)", "Write"]),
      env: {},
    });
    const tool = (toolName: string): ApprovalRequest => ({ ...cmd("x"), toolName, kind: "edit" });
    expect(r ? theirSay(cmd("ls"), r)?.decision : null).toBe("deny");
    expect(r ? theirSay(tool("Edit"), r)?.decision : null).toBe("deny");
    expect(r ? theirSay(tool("WebFetch"), r)?.decision : null).toBe("deny");
    expect(r ? theirSay(tool("Write"), r)?.decision : null).toBe("deny");
    expect(r ? theirSay(tool("Read"), r)?.decision : null).toBeUndefined();
    // Bare allows stay left out (Full is that switch).
    const allow = readAgentRules("claude-code", { home: claudeHome(["Bash(*)", "Edit(*)"]), env: {} });
    expect(allow?.allow).toEqual([]);
  });
});

// Review of 05d5c8b, 2026-11-22: a settings file that's a link is followed only to a .json file in your home that
// isn't a secret (an agent's sign-in file least of all): your dotfiles repo, yes; ~/.codex/auth.json, no.
describe("an agent's settings file that's a link", () => {
  it("is followed to your dotfiles' .json, never to a secret or outside your home", () => {
    const rules = JSON.stringify({ permissions: { deny: ["WebSearch"] } });
    const home = fakeHome({ "dotfiles/claude/settings.json": rules, ".codex/auth.json": rules });
    mkdirSync(join(home, ".claude"), { recursive: true });
    symlinkSync(join(home, "dotfiles", "claude", "settings.json"), join(home, ".claude", "settings.json"));
    expect(ruleCount(readAgentRules("claude-code", { home, env: {} }))).toBe(1);
    const other = fakeHome({ ".codex/auth.json": rules });
    mkdirSync(join(other, ".claude"), { recursive: true });
    symlinkSync(join(other, ".codex", "auth.json"), join(other, ".claude", "settings.json"));
    expect(ruleCount(readAgentRules("claude-code", { home: other, env: {} }))).toBe(0);
    const away = fakeHome({});
    mkdirSync(join(away, ".claude"), { recursive: true });
    symlinkSync(join(home, "dotfiles", "claude", "settings.json"), join(away, ".claude", "settings.json"));
    expect(ruleCount(readAgentRules("claude-code", { home: away, env: {} }))).toBe(0);
  });

  // Found 2026-11-28: with ION_AGENTS_HOME (a stand-in home) set, ion still read the real agent folders named by
  // ion's own environment (CLAUDE_CONFIG_DIR), so a chat went by rules from outside the stand-in home.
  it("a stand-in home ignores CLAUDE_CONFIG_DIR of ion's environment", () => {
    const real = claudeHome([], ["Bash(rm:*)"]);
    const standIn = fakeHome({});
    const was = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(real, ".claude");
    try {
      expect(ruleCount(readAgentRules("claude-code", { home: standIn }))).toBe(0);
    } finally {
      if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = was;
    }
  });
});
