import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { describe, expect, it } from "vitest";
import { createAccess, judgePrompt } from "../access/index.js";
import type { EventStore } from "../store/index.js";
import { Approvals, type AskingRun } from "./approvals.js";

const home = "/Users/me";
const wt = "/data/worktrees/c1";
const store = { append: () => {} } as unknown as EventStore;
const judge = async () => ({ verdict: "allow" as const, reason: "fine" });
const own = { home, ionDirs: ["/data", `${home}/.config/ion`] };
const access = createAccess({ judge, ...own });
const run = (a: "auto" | "full"): AskingRun => ({
  chatId: "c1",
  runId: "r1",
  projectId: "p",
  request: "x",
  access: a,
});
const cmd = (command: string): ApprovalRequest => ({
  requestId: "q",
  toolId: "t",
  toolName: "Bash",
  kind: "command",
  summary: command,
  input: { command },
});
const write = (file_path: string): ApprovalRequest => ({
  ...cmd("x"),
  kind: "edit",
  toolName: "Write",
  input: { file_path, content: "{}" },
});

// Task review, 2026-11-20: Full access allowed everything before any rule, so a run in Full could rewrite ion's
// config or mcp.json, or read ion's keys from the keychain. ion's own files and keys hold in Full too.
describe("ion's own files and keys, even in Full access", () => {
  const probes = [
    write(`${home}/.config/ion/mcp.json`),
    write(`${home}/.config/ion/config.toml`),
    cmd("rm /data/ion.db"),
    cmd("security find-generic-password -s ion -a key:GH -w"),
    cmd("echo find-generic-password | security -i"),
    cmd("secret-tool lookup service ion account key:GH"),
    cmd("cat ~/.grok/hooks/ion.json"),
  ];
  for (const access0 of ["auto", "full"] as const)
    it(`are refused in ${access0}`, async () => {
      const a = new Approvals(store, access, () => true, { own });
      for (const p of probes) expect((await a.gate(run(access0), p, [wt])).decision, p.summary).toBe("deny");
    });

  it("Full still allows the rest", async () => {
    const a = new Approvals(store, access, () => true, { own });
    expect((await a.gate(run("full"), cmd("curl https://example.com"), [wt])).decision).toBe("allow");
  });
});

// Security review, 2026-11-20: the rules that hold in Full ran only through Auto's access (none configured: skipped)
// and after the policy's allow. They run first, in every mode, whatever else is set up.
describe("ion's own files come first", () => {
  it("with no Auto set up, Full still can't write mcp.json", async () => {
    const a = new Approvals(store, undefined, () => true, { own });
    expect((await a.gate(run("full"), write(`${home}/.config/ion/mcp.json`), [wt])).decision).toBe("deny");
  });

  it("a read the policy allows is refused when it reaches ion's config", async () => {
    const proj = "/code/app";
    const inside = { home, ionDirs: ["/data", `${proj}/.ion`] };
    const a = new Approvals(store, access, () => true, { own: inside });
    const read: ApprovalRequest = {
      ...cmd("x"),
      kind: "read",
      toolName: "Read",
      input: { file_path: ".ion/config.toml" },
    };
    for (const mode of ["auto", "full"] as const)
      expect((await a.gate(run(mode), read, [proj])).decision).toBe("deny");
    // The worktree's own files, in ion's data folder, are still the run's.
    const mine: ApprovalRequest = { ...read, input: { file_path: "src/a.ts" } };
    expect((await a.gate(run("auto"), mine, [wt])).decision).toBe("allow");
  });

  // A keychain subcommand in a file's text is refused (security review, 2026-11-20: a script written then run).
  it("an edit inside the project that only mentions ion's files is fine", async () => {
    const a = new Approvals(store, access, () => true, { own });
    const edit: ApprovalRequest = {
      ...write("docs/keys.md"),
      input: {
        file_path: "docs/keys.md",
        content: "see ~/.config/ion/mcp.json and .grok/hooks",
      },
    };
    expect((await a.gate(run("auto"), edit, [wt])).decision).toBe("allow");
  });
});

// Task review, 2026-11-20: on macOS (folders ignore case) "/DATA/ion.db" or "~/.CONFIG/ion/mcp.json" is ion's file,
// but the hard rule compared case-sensitively and let it through in Full.
describe.runIf(process.platform === "darwin")("ion's own files, whatever the case", () => {
  it("are refused in Full", async () => {
    const a = new Approvals(store, undefined, () => true, { own });
    for (const p of [
      write("/DATA/ion.db"),
      write("/Data/worktrees/c2/a"),
      write(`${home}/.CONFIG/ion/mcp.json`),
      cmd("cat /data/WORKTREES/c2/secret.txt"),
    ])
      expect((await a.gate(run("full"), p, [wt])).decision, JSON.stringify(p.input)).toBe("deny");
    // The run's own worktree, however it's spelled, is still its own.
    expect((await a.gate(run("full"), write("/DATA/worktrees/C1/a.ts"), [wt])).decision).toBe("allow");
  });
});

// Security review, 2026-11-20: the rule that holds in Full only caught some keychain subcommands, and only in a
// command; any use of security or secret-tool, and a keychain subcommand anywhere in a call, is refused.
describe("the keychain, in every mode", () => {
  // Task review, 2026-11-20 (round 5): read by verbs now, so `security find-identity` (no keychain item) is allowed.
  it("refuses security and secret-tool with a keychain verb, and the words anywhere", async () => {
    const a = new Approvals(store, undefined, () => true, { own });
    const anywhere: ApprovalRequest = {
      ...cmd("x"),
      toolName: "Task",
      kind: "other" as never,
      input: { script: "x; find-generic-password -s ion" },
    };
    for (const p of [
      cmd("security dump-keychain"),
      cmd("/usr/bin/security find-generic-password -s ion"),
      cmd("FOO=1 secret-tool search service ion"),
      anywhere,
    ])
      expect((await a.gate(run("full"), p, [wt])).decision, JSON.stringify(p.input)).toBe("deny");
  });
});

// Security review, 2026-11-20: a wildcard was compared as written, so "~/.config/io*/mcp.json" or "/data/*.db"
// got past ion's own files.
describe("ion's own files behind a wildcard", () => {
  it("are refused in Full", async () => {
    const a = new Approvals(store, undefined, () => true, { own });
    for (const c of [
      `cat ${home}/.config/io*/mcp.json`,
      "ls /data/w*/c2",
      "cat /data/*.db",
      `cat ${home}/.conf?g/ion/config.toml`,
      "cat /da[t]a/ion.db",
    ])
      expect((await a.gate(run("full"), cmd(c), [wt])).decision, c).toBe("deny");
    // A wildcard inside the run's own worktree is its own.
    expect((await a.gate(run("full"), cmd("cat /data/worktrees/c1/src/*.ts"), [wt])).decision).toBe("allow");
  });
});

// Task review, 2026-11-20: a file's text isn't run; a chat working on ion itself must be able to edit its keychain
// code. Keychain words count only where something runs (a command, a script); the programs stay refused.
describe("a file's text isn't a command", () => {
  it("allows editing a file that names keychain commands, and still refuses running them", async () => {
    const a = new Approvals(store, access, () => true, { own });
    const text = 'const MAC = ["find-generic-password", "-s", "ion"]; // security -i, secret-tool';
    const edits: ApprovalRequest[] = [
      { ...write("src/secrets/index.ts"), input: { file_path: "src/secrets/index.ts", content: text } },
      {
        ...write("src/secrets/index.ts"),
        toolName: "Edit",
        input: { file_path: "src/secrets/index.ts", old_string: "x", new_string: text },
      },
    ];
    for (const mode of ["auto", "full"] as const)
      for (const e of edits) expect((await a.gate(run(mode), e, [wt])).decision, e.toolName).toBe("allow");
    expect((await a.gate(run("full"), cmd("security find-generic-password -s ion"), [wt])).decision).toBe(
      "deny",
    );
  });
});

// The user, 2026-11-20 ("In Plan 18 now": ion as the gateway to your MCP servers): ion gates each tools/call it
// forwards with the server, the real tool name and its input, the same way as the run's other calls.
describe("a tools/call at ion's gateway", () => {
  const mcpCall = (toolName: string, input: Record<string, unknown>) => ({
    toolName,
    kind: "mcp",
    mcpServer: "fs",
    summary: `fs: ${toolName}`,
    input,
  });

  it("hard rules see the call's input (a filesystem-style tool asked for ~/.config/ion/mcp.json is refused)", async () => {
    const a = new Approvals(store, access, () => true, { own });
    for (const mode of ["auto", "full"] as const) {
      const v = await a.gateway(run(mode), mcpCall("read_file", { path: "~/.config/ion/mcp.json" }), [wt]);
      expect(v.decision, mode).toBe("deny");
      expect(v.reason).toContain("Touches ion's own files");
    }
  });

  it("goes by the run's access: Auto asks the judge with the real name and input; Full allows", async () => {
    const seen: unknown[] = [];
    const judged = createAccess({
      judge: async (q: { req: { toolName: string; input: unknown } }) => {
        seen.push(q.req);
        return { verdict: "deny" as const, reason: "Not for this task" };
      },
      ...own,
    });
    const a = new Approvals(store, judged, () => true, { own });
    const v = await a.gateway(run("auto"), mcpCall("delete_issue", { id: 7 }), [wt]);
    expect(v.decision).toBe("deny");
    expect(seen).toEqual([
      expect.objectContaining({ toolName: "delete_issue", input: { id: 7 }, mcpServer: "fs" }),
    ]);
    expect((await a.gateway(run("full"), mcpCall("delete_issue", { id: 7 }), [wt])).decision).toBe("allow");
  });

  // Asking the judge (or you) twice for one call: the agent's own prompt, then ion's gateway.
  it("a call the agent's side just allowed isn't judged again; another call is", async () => {
    let judged = 0;
    const counting = createAccess({
      judge: async () => {
        judged++;
        return { verdict: "allow" as const, reason: "fine" };
      },
      ...own,
    });
    const a = new Approvals(store, counting, () => true, { own });
    const r = { ...run("auto"), viaIon: ["fs"] };
    const prompt: ApprovalRequest = {
      ...cmd("x"),
      ...mcpCall("mcp__fs__read_file", { path: "a.txt", n: 1 }),
    };
    a.noteStored({ type: "approval.requested", data: { requestId: "q" } } as never);
    expect(await a.decide(r, prompt, [wt])).toBe("allow");
    expect(judged).toBe(1);
    expect((await a.gateway(r, mcpCall("read_file", { n: 1, path: "a.txt" }), [wt])).decision).toBe("allow");
    expect(judged).toBe(1);
    // Used up; a different tool on the same input is judged in full.
    await a.gateway(r, mcpCall("delete_file", { n: 1, path: "a.txt" }), [wt]);
    expect(judged).toBe(2);
    // Grok's hook (live check, 2026-11-20): `fs__read_file`, kind "other", its arguments wrapped in tool_input.
    const grok = { toolName: "fs__read_file", kind: "other", summary: "fs__read_file", input: {} };
    const wrapped = { variant: "UseTool", tool_name: "fs__read_file", tool_input: { path: "b.txt" } };
    await a.gate(r, { ...grok, input: wrapped }, [wt]);
    expect(judged).toBe(3);
    expect((await a.gateway(r, mcpCall("read_file", { path: "b.txt" }), [wt])).decision).toBe("allow");
    expect(judged).toBe(3);
    // Other arguments than the agent's side allowed: judged.
    await a.gate(r, { ...grok, input: { ...wrapped, tool_input: { path: "c.txt" } } }, [wt]);
    expect(judged).toBe(4);
    await a.gateway(r, mcpCall("read_file", { path: "d.txt" }), [wt]);
    expect(judged).toBe(5);
  });
});

// Task review, 2026-11-20: a handoff came from any allow (the loose gate-allows queue, the policy), could pile up,
// and outlived an agent-side no. Only ion's, your or Full's allow of exactly the call hands off, once, for 10 s.
describe("the handoff to ion's gateway", () => {
  const counting = () => {
    const n = { judged: 0, allow: true };
    const access0 = createAccess({
      judge: async () => {
        n.judged++;
        return n.allow
          ? { verdict: "allow" as const, reason: "fine" }
          : { verdict: "deny" as const, reason: "no" };
      },
      ...own,
    });
    return { n, a: new Approvals(store, access0, () => true, { own }) };
  };
  const at = (toolName: string, input: Record<string, unknown>) => ({
    toolName,
    kind: "mcp",
    mcpServer: "fs",
    summary: toolName,
    input,
  });
  const r = { ...run("auto"), viaIon: ["fs"] };

  it("one pending allow per call: a second gateway call of it is judged", async () => {
    const { n, a } = counting();
    await a.gate(r, at("fs__lookup", { q: "x" }), [wt]);
    await a.gate(r, at("fs__lookup", { q: "x" }), [wt]);
    const before = n.judged;
    await a.gateway(r, at("lookup", { q: "x" }), [wt]);
    expect(n.judged).toBe(before);
    await a.gateway(r, at("lookup", { q: "x" }), [wt]);
    expect(n.judged).toBe(before + 1);
  });

  it("an agent-side no drops what was pending for the call", async () => {
    const { n, a } = counting();
    await a.gate(r, at("fs__lookup", { q: "y" }), [wt]);
    n.allow = false;
    // The same call asked again (another request, so the judge isn't answered from its cache), and refused.
    expect((await a.gate({ ...r, request: "again" }, at("fs__lookup", { q: "y" }), [wt])).decision).toBe(
      "deny",
    );
    const before = n.judged;
    expect((await a.gateway(r, at("lookup", { q: "y" }), [wt])).decision).toBe("deny");
    expect(n.judged).toBe(before + 1);
  });

  it("the policy's allow doesn't hand off", async () => {
    const { n, a } = counting();
    const inWorktree = { ...at("fs__read", { file_path: `${wt}/a.txt` }), kind: "read", mcpServer: null };
    expect((await a.gate(r, inWorktree, [wt])).decision).toBe("allow");
    expect(n.judged).toBe(0);
    await a.gateway(r, at("read", { file_path: `${wt}/a.txt` }), [wt]);
    expect(n.judged).toBe(1);
  });
});

// The user, 2026-11-20: "auto-approval hook should be listed as built-in". Your "Before a tool runs" hooks come
// after ion's own files (hard rules first, always) and before everything else: the worktree's policy, Full access,
// Auto-approval.
describe("Before a tool runs hooks", () => {
  const recorded: unknown[] = [];
  const log = { append: (e: { data: unknown }) => recorded.push(e.data) } as unknown as EventStore;
  const asked: string[] = [];
  const beforeTool = async (_r: unknown, c: { summary: string }) => {
    asked.push(c.summary);
    return c.summary.startsWith("rm ") ? { reason: "No rm here" } : null;
  };

  it("a Before a tool runs hook that exits 2 refuses the call with its message", async () => {
    const a = new Approvals(log, access, () => true, { own, beforeTool });
    for (const mode of ["auto", "full"] as const) {
      const r = await a.gate(run(mode), cmd(`rm ${wt}/a.txt`), [wt]);
      expect(r).toEqual({ decision: "deny", reason: "No rm here" });
    }
    expect(recorded.at(-1)).toMatchObject({ decision: "deny", by: "hook", reason: "No rm here" });
    expect((await a.gate(run("auto"), cmd(`ls ${wt}`), [wt])).decision).toBe("allow");
  });

  it("ion's own files are refused before any hook is asked", async () => {
    asked.length = 0;
    const a = new Approvals(log, access, () => true, { own, beforeTool });
    expect((await a.gate(run("full"), cmd("rm /data/ion.db"), [wt])).decision).toBe("deny");
    expect(asked).toEqual([]);
  });
});

// Task review, 2026-11-21: a "Before a tool runs" hook that failed or timed out let the call go on to Auto-approval,
// and the judge never knew a guard you set up hadn't run.
describe("a check that didn't finish", () => {
  it("is said to the judge in one line", async () => {
    const seen: string[] = [];
    const judging = createAccess({
      judge: async (i) => {
        seen.push(judgePrompt(i));
        return { verdict: "allow" as const, reason: "fine" };
      },
      ...own,
    });
    const a = new Approvals(store, judging, () => true, { own, beforeTool: async () => ({ failed: true }) });
    expect((await a.gate(run("auto"), cmd("curl https://example.com"), [wt])).decision).toBe("allow");
    // A fixed sentence: never a hook's name, which is config text (Task review, 2026-11-21).
    expect(seen[0]).toContain(
      "From ion: one of the checks before tools run didn't finish or failed. Judge this action more carefully.",
    );
  });
});

// Task review, 2026-11-21: a run's skills plugin lives in ion's data folder, so the hard rule refused every file a
// skill brings except SKILL.md ("Read …/skills/pdf/ref.md", "python …/scripts/fill.py": "Touches ion's own files").
describe("a run's own skills plugin", () => {
  const plugin = "/data/skills/r1";
  const withPlugin = (a: "auto" | "full"): AskingRun => ({ ...run(a), pluginDir: plugin });
  const read = (file_path: string): ApprovalRequest => ({
    ...cmd("x"),
    kind: "read",
    toolName: "Read",
    input: { file_path },
  });

  it("a run can read and run its own skills plugin's files but not write them", async () => {
    const a = new Approvals(store, access, () => true, { own });
    for (const mode of ["auto", "full"] as const) {
      const r = withPlugin(mode);
      for (const ok of [
        read(`${plugin}/skills/pdf/ref.md`),
        cmd(`python3 ${plugin}/skills/pdf/scripts/fill.py in.pdf`),
        cmd(`cat ${plugin}/skills/pdf/ref.md | head -5`),
        cmd(`${plugin}/skills/pdf/scripts/run.sh`),
      ])
        expect((await a.gate(r, ok, [wt])).decision, `${mode} ${ok.summary}`).toBe("allow");
      for (const no of [
        write(`${plugin}/skills/pdf/SKILL.md`),
        cmd(`rm -rf ${plugin}/skills/pdf`),
        cmd(`echo x > ${plugin}/skills/pdf/ref.md`),
        cmd(`python3 -c "open('${plugin}/skills/pdf/ref.md','w')"`),
        cmd(`cp x ${plugin}/skills/pdf/ref.md`),
        cmd(`python3 ${plugin}/skills/pdf/scripts/fill.py /data/ion.db`),
        read("/data/ion.db"),
      ])
        expect((await a.gate(r, no, [wt])).decision, `${mode} ${no.summary}`).toBe("deny");
    }
    // In Auto a skill's own files are the run's, like its worktree: no judge to say no.
    const strict = createAccess({ judge: async () => ({ verdict: "deny" as const, reason: "no" }), ...own });
    const b = new Approvals(store, strict, () => true, { own });
    expect((await b.gate(withPlugin("auto"), read(`${plugin}/skills/pdf/ref.md`), [wt])).decision).toBe(
      "allow",
    );
  });

  // Security review of e526f98, 2026-11-21: commands naming the plugin skipped the judge, so
  // `LD_PRELOAD=/tmp/x.so python <plugin>/s.py` ran unasked. Only reading a skill's files skips the judge.
  it("a command running a skill's script goes to the judge; reading its files doesn't", async () => {
    const asked: string[] = [];
    const judgeNo = async (q: { req: { summary: string } }) => {
      asked.push(q.req.summary);
      return { verdict: "deny" as const, reason: "no" };
    };
    const a = new Approvals(store, createAccess({ judge: judgeNo, ...own }), () => true, { own });
    const r = withPlugin("auto");
    const c = `LD_PRELOAD=/tmp/x.so python ${plugin}/s.py`;
    expect((await a.gate(r, cmd(c), [wt])).decision, c).toBe("deny");
    expect(asked, c).toContain(c);
    // Task review, 2026-11-21: a script ion can't read that the command runs (/tmp/x.js here) isn't allowed.
    expect((await a.gate(r, cmd(`node --require /tmp/x.js ${plugin}/s.js`), [wt])).decision).toBe("deny");
    asked.length = 0;
    expect((await a.gate(r, read(`${plugin}/skills/x/ref.md`), [wt])).decision).toBe("allow");
    expect(asked).toEqual([]);
    expect((await a.gate(r, write(`${plugin}/skills/x/ref.md`), [wt])).decision).toBe("deny");
    expect(asked).toEqual([]);
  });

  it("another run's plugin folder stays denied", async () => {
    const a = new Approvals(store, access, () => true, { own });
    for (const mode of ["auto", "full"] as const) {
      for (const no of [read("/data/skills/r2/skills/pdf/ref.md"), cmd("python3 /data/skills/r2/x.py")])
        expect((await a.gate(withPlugin(mode), no, [wt])).decision, mode).toBe("deny");
      // Without a plugin of its own, nothing in the skills folder is the run's.
      expect((await a.gate(run(mode), read(`${plugin}/skills/pdf/ref.md`), [wt])).decision).toBe("deny");
    }
  });
});

// Task review, 2026-11-21: a skill's scripts can now be run, and the commands inside a script never reach the gate;
// the keychain rule read only scripts in the worktree, so a skill's script could read your keys unseen.
describe("a skill's scripts and the keychain", () => {
  it("a script in the run's plugin that uses the keychain is refused", async () => {
    const data = mkdtempSync(join(tmpdir(), "ion-plugin-"));
    const plugin = join(data, "skills", "r1");
    const scripts = join(plugin, "skills", "x", "scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "run.sh"), "#!/bin/sh\nsecurity find-generic-password -s ion -w\n");
    writeFileSync(join(scripts, "ok.sh"), "#!/bin/sh\necho hello\n");
    writeFileSync(join(scripts, "get.py"), "import os\nos.system('security dump-keychain')\n");
    const mine = { home, ionDirs: [data] };
    const a = new Approvals(store, createAccess({ judge, ...mine }), () => true, { own: mine });
    const r = { ...run("full"), pluginDir: plugin };
    for (const c of [`bash ${scripts}/run.sh`, `${scripts}/run.sh`, `python3 ${scripts}/get.py`])
      expect((await a.gate(r, cmd(c), [wt])).decision, c).toBe("deny");
    expect((await a.gate(r, cmd(`bash ${scripts}/ok.sh`), [wt])).decision).toBe("allow");
  });
});

// The user, 2026-11-21: too many hard blocks stop real work. What ion knows is unsafe (its own files and keys, your
// secrets, an environment dump, dropping the run's key) is refused in every mode, with a safer route. What it only
// guesses (a script it can't be sure of, one the command creates, decoded text that runs, a parse it can't follow):
// in Auto the judge decides, shown the scripts that will run and any decoded text; its no asks you ("ion is wary of
// this"). In Full (no judge) it asks you. "Always" stops the next ask.
describe("refused, judged or asked: what ion knows, and what it guesses", () => {
  type Wary = { reason: string; scripts: { file: string; text: string }[]; decoded: string[] };
  const setup = (verdict: boolean) => {
    const asked: { reason: string; wary?: boolean }[] = [];
    const judged: { summary: string; wary?: Wary }[] = [];
    let always = false;
    const askBlocked = {
      ask: async (_r: AskingRun, b: { reason: string; wary?: true }) => {
        asked.push({ reason: b.reason, ...(b.wary ? { wary: true } : {}) });
        return "allow" as const;
      },
      allowed: () => always,
    };
    const judge = async (q: { req: { summary: string }; wary?: Wary }) => {
      judged.push({ summary: q.req.summary, ...(q.wary ? { wary: q.wary } : {}) });
      return { verdict: verdict ? ("allow" as const) : ("deny" as const), reason: verdict ? "fine" : "no" };
    };
    const a = new Approvals(store, createAccess({ judge, ...own }), () => true, { own, askBlocked });
    return { a, asked, judged, setAlways: () => (always = true) };
  };
  const tree = () => {
    const t = mkdtempSync(join(tmpdir(), "ion-wt-"));
    writeFileSync(join(t, "drop.sh"), "unset ION_RUN_KEY\n");
    return t;
  };

  it("refuses what it knows in Full too, without asking, and says the safer route", async () => {
    const { a, asked, judged } = setup(true);
    for (const c of [
      "security find-generic-password -s ion -w",
      "cat ~/.config/ion/mcp.json",
      "env",
      "unset ION_RUN_KEY",
      "ION_RUN_KEY=x ion mcp ls",
    ]) {
      const v = await a.gate(run("full"), cmd(c), [wt]);
      expect(v.decision, c).toBe("deny");
      expect(v.reason, c).toMatch(/ — \w/);
      expect(v.reason, c).not.toContain("ask the user with ion's ask tool");
    }
    expect(asked).toEqual([]);
    expect(judged).toEqual([]);
  });

  it("in Auto, the judge sees the script that will run; its yes runs it without asking", async () => {
    const t = tree();
    const { a, asked, judged } = setup(true);
    expect((await a.gate(run("auto"), cmd("bash drop.sh"), [t])).decision).toBe("allow");
    expect(asked).toEqual([]);
    expect(judged[0]?.wary?.scripts).toEqual([{ file: "drop.sh", text: "unset ION_RUN_KEY\n" }]);
    expect(judged[0]?.wary?.reason).toMatch(/script/);
  });

  it("in Auto, the judge's no asks you, as ion is wary; Always stops the next ask", async () => {
    const t = tree();
    const { a, asked, judged, setAlways } = setup(false);
    expect((await a.gate(run("auto"), cmd("bash drop.sh"), [t])).decision).toBe("allow");
    expect(asked).toEqual([{ reason: expect.stringMatching(/script/), wary: true }]);
    setAlways();
    expect((await a.gate(run("auto"), cmd("bash drop.sh"), [t])).decision).toBe("allow");
    expect(asked).toHaveLength(1);
    expect(judged.length).toBeGreaterThan(0);
  });

  it("a file the command creates goes to the judge with no contents; decoded text is shown decoded", async () => {
    const { a, judged } = setup(true);
    await a.gate(run("auto"), cmd("gcc main.c -o main && ./main"), [tree()]);
    expect(judged[0]?.wary).toEqual({
      reason: "it runs a script ion can't read",
      scripts: [],
      decoded: [],
    });
    await a.gate(run("auto"), cmd("echo ZWNobyBoaQ== | base64 -d | sh"), [tree()]);
    expect(judged[1]?.wary?.decoded).toEqual(["echo hi"]);
  });

  it("caps what the judge is shown: 64 KB a script, 128 KB in all, no control characters", async () => {
    const t = tree();
    for (const n of ["a", "b", "c"]) writeFileSync(join(t, `${n}.sh`), `echo \u0007${"x".repeat(100_000)}\n`);
    const { a, judged } = setup(true);
    await a.gate(run("auto"), cmd("bash a.sh; bash b.sh; bash c.sh; bash drop.sh"), [t]);
    const shown = judged[0]?.wary?.scripts ?? [];
    expect(shown.length).toBeGreaterThanOrEqual(2);
    expect(shown.every((x) => x.text.length <= 64 * 1024)).toBe(true);
    expect(shown.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(128 * 1024);
    expect(shown.some((x) => x.text.includes("\u0007"))).toBe(false);
  });

  it("in Full (no judge), a guess asks you", async () => {
    const t = tree();
    const { a, asked, judged } = setup(true);
    for (const c of ["gcc main.c -o main && ./main", "echo ZWNobyBoaQ== | base64 -d | sh", "bash drop.sh"])
      expect((await a.gate(run("full"), cmd(c), [t])).decision, c).toBe("allow");
    expect(asked).toHaveLength(3);
    expect(asked.every((x) => x.wary)).toBe(true);
    expect(judged).toEqual([]);
  });

  // The user, 2026-11-21 (Plan 18 Task 12): once a run is in the OS sandbox, ion's files are out of its reach
  // whatever a script, decoded text or a cleared environment does, so the guesses that only guarded ion's key no
  // longer ask (or reach the judge as ion's guess); what ion knows (its files, your keys, env dumps, dropping the run's
  // key) still holds as defence in depth.
  it("in a sandboxed run, the guesses that only guarded ion's key don't ask; what ion knows still holds", async () => {
    const t = tree();
    const { a, asked, judged } = setup(true);
    const boxed = { ...run("full"), sandboxed: true };
    for (const c of [
      "gcc main.c -o main && ./main",
      "echo ZWNobyBoaQ== | base64 -d | sh",
      "bash drop.sh",
      "exec -c ion mcp ls",
      "python3 -c 'import os; os.system(\"ls\")'",
    ])
      expect((await a.gate(boxed, cmd(c), [t])).decision, c).toBe("allow");
    expect(asked).toEqual([]);
    for (const c of [
      "cat ~/.config/ion/mcp.json",
      "unset ION_RUN_KEY",
      "env",
      "security find-generic-password -s ion -w",
    ])
      expect((await a.gate(boxed, cmd(c), [t])).decision, c).toBe("deny");
    expect(judged).toEqual([]);
    await a.gate({ ...run("auto"), sandboxed: true }, cmd("bash drop.sh"), [t]);
    expect(judged).toHaveLength(1);
    expect(judged[0]?.wary).toBeUndefined();
  });

  it("without anyone to ask, a guess is refused with the safer route", async () => {
    const a = new Approvals(store, access, () => true, { own });
    const v = await a.gate(run("full"), cmd("sh /tmp/ion-no-such-script.sh"), [wt]);
    expect(v.decision).toBe("deny");
    expect(v.reason).toContain("read the file first, then run it");
  });

  // Security review, 2026-11-21: a guess still meets every rule (your secrets, ion's files); only the guessing part
  // goes to the judge.
  it("a guess that also names a secret is refused, not judged", async () => {
    const t = tree();
    const { a, asked, judged } = setup(true);
    const v = await a.gate(run("auto"), cmd("bash drop.sh && cat ~/.ssh/id_rsa"), [t]);
    expect(v.decision).toBe("deny");
    expect(judged).toEqual([]);
    expect(asked).toEqual([]);
  });

  // Security review, 2026-11-21: the judge is shown only scripts in the project (or the run's skills plugin); any
  // other is named, not shown.
  it("never shows the judge a script outside the project", async () => {
    const home0 = mkdtempSync(join(tmpdir(), "ion-home-"));
    writeFileSync(join(home0, "x.sh"), "unset ION_RUN_KEY # private-words\n");
    const { a, judged } = setup(true);
    await a.gate(run("auto"), cmd(`bash ${home0}/x.sh`), [tree()]);
    expect(judged[0]?.wary?.scripts).toEqual([{ file: `${home0}/x.sh` }]);
    expect(JSON.stringify(judged)).not.toContain("private-words");
  });
});

// The user, 2026-11-21: agents bring their own servers into ion's chats; ion's gate still judges every call. An own
// server's tool (not ion's, not one ion serves) is never allowed by ion's policy: in Auto it goes to the judge.
describe("an agent's own tool call is judged by ion", () => {
  it("goes to the judge in Auto, with its server and tool named", async () => {
    const seen: string[] = [];
    const judging = createAccess({
      judge: async (prompt: unknown) => {
        seen.push(JSON.stringify(prompt));
        return { verdict: "deny" as const, reason: "not asked for" };
      },
      ...own,
    });
    const a = new Approvals(store, judging, () => true, { own });
    const call: ApprovalRequest = {
      requestId: "q",
      toolId: "t",
      toolName: "mcp__github__delete_repo",
      kind: "mcp",
      mcpServer: "github",
      summary: "delete_repo",
      input: { repo: "me/app" },
    };
    expect((await a.gate(run("auto"), call, [wt])).decision).toBe("deny");
    expect(seen.join("\n")).toContain("mcp__github__delete_repo");
  });
});

// Re-review, 2026-11-21: while ion holds a run's call (its gate, the judge, or your answer), the agent's silence check
// waits: the run's session is told when holding starts and ends.
describe("telling a run's session ion is holding one of its calls", () => {
  it("says held while the gate decides, and not after", async () => {
    let release: (() => void) | undefined;
    const askBlocked = {
      ask: () => new Promise<"allow">((r) => (release = () => r("allow"))),
      allowed: () => false,
    };
    const deny = createAccess({ judge: async () => ({ verdict: "deny" as const, reason: "no" }), ...own });
    const a = new Approvals(store, deny, () => true, { own, askBlocked });
    const said: boolean[] = [];
    a.holding("r1").on((h) => said.push(h));
    const going = a.gate(run("auto"), cmd("curl https://example.com"), [wt]);
    await new Promise((r) => setTimeout(r, 20));
    expect(said).toEqual([true]);
    release?.();
    await going;
    expect(said).toEqual([true, false]);
  });
});

// The user, 2026-11-21: "yes, add unsure to Task 10". The judge's unsure goes the way of a no (you're asked), the
// question says ion isn't sure, and the approval event says which the judge said.
describe("the judge can say unsure", () => {
  it("the judge can say unsure, and you're asked with \"ion isn't sure\"", async () => {
    const asked: { reason: string; unsure?: true }[] = [];
    const recorded: Record<string, unknown>[] = [];
    const rec = {
      append: (e: { data: Record<string, unknown> }) => recorded.push(e.data),
    } as unknown as EventStore;
    const askBlocked = {
      ask: async (_r: AskingRun, b: { reason: string; unsure?: true }) => {
        asked.push({ reason: b.reason, ...(b.unsure ? { unsure: b.unsure } : {}) });
        return "deny" as const;
      },
      allowed: () => false,
    };
    const unsure = createAccess({
      judge: async () => ({ verdict: "unsure" as const, reason: "can't see the script" }),
      ...own,
    });
    const a = new Approvals(rec, unsure, () => true, { own, askBlocked });
    expect((await a.gate(run("auto"), cmd("curl https://example.com"), [wt])).decision).toBe("deny");
    expect(asked).toEqual([{ reason: "can't see the script", unsure: true }]);
    expect(recorded.at(-1)).toMatchObject({ decision: "deny", by: "you", judge: "unsure" });
    const no = createAccess({ judge: async () => ({ verdict: "deny" as const, reason: "risky" }), ...own });
    const b = new Approvals(rec, no, () => true, { own, askBlocked });
    await b.gate(run("auto"), cmd("curl https://example.com"), [wt]);
    expect(asked.at(-1)).toEqual({ reason: "risky" });
    expect(recorded.at(-1)).toMatchObject({ judge: "deny" });
  });
});

// Task review, 2026-11-21: a judge that couldn't decide (failed, slow) is asked as "ion couldn't decide", with no judge
// verdict recorded; ion's guess asked after the judge's no records what the judge said; picks reach the judge.
describe("what the judge said, recorded", () => {
  const rig = (
    judge: () => Promise<{ verdict: "allow" | "deny" | "unsure"; reason: string; decided?: false }>,
  ) => {
    const asked: Record<string, unknown>[] = [];
    const recorded: Record<string, unknown>[] = [];
    const rec = {
      append: (e: { data: Record<string, unknown> }) => recorded.push(e.data),
    } as unknown as EventStore;
    const askBlocked = {
      ask: async (_r: AskingRun, b: Record<string, unknown>) => {
        asked.push(b);
        return "deny" as const;
      },
      allowed: () => false,
    };
    const a = new Approvals(rec, createAccess({ judge, ...own }), () => true, { own, askBlocked });
    return { a, asked, recorded };
  };
  it("a judge that couldn't decide asks as ion couldn't decide, and records no verdict", async () => {
    const { a, asked, recorded } = rig(async () => ({
      verdict: "deny",
      reason: "ion couldn't decide in time",
      decided: false,
    }));
    await a.gate(run("auto"), cmd("curl https://example.com"), [wt]);
    expect(asked[0]).toMatchObject({ undecided: true });
    expect(recorded.at(-1)).not.toHaveProperty("judge");
  });
  it("ion's guess asked after the judge's unsure records it", async () => {
    const t = mkdtempSync(join(tmpdir(), "ion-wt-"));
    writeFileSync(join(t, "drop.sh"), "unset ION_RUN_KEY\n");
    const { a, recorded } = rig(async () => ({ verdict: "unsure", reason: "can't tell" }));
    await a.gate(run("auto"), cmd("bash drop.sh"), [t]);
    expect(recorded.at(-1)).toMatchObject({ judge: "unsure" });
  });
});

// The user, 2026-11-21: Full access is no judging and no asking, inside a fixed floor (ion's files and key, your
// keychain secrets, environment dumps, dropping the run's key, the sandbox, the run key's limits). A guess runs without
// asking when the run is really sandboxed, and still asks when it isn't; your saved "never" still holds; everything
// else runs (pushes, publishes, deploys included).
describe("Full access", () => {
  const asked: string[] = [];
  const askBlocked = {
    ask: async (_r: AskingRun, b: { reason: string }) => {
      asked.push(b.reason);
      return "allow" as const;
    },
    allowed: () => false,
    never: (_r: AskingRun, key: string) => (key === 'Bash {"command":"npm publish"}' ? "npm publish" : null),
  };
  const full = new Approvals(store, access, () => true, { own, askBlocked });
  const t = () => {
    const d = mkdtempSync(join(tmpdir(), "ion-full-"));
    writeFileSync(join(d, "drop.sh"), "unset ION_RUN_KEY\n");
    return d;
  };

  it("runs a guess without asking in a sandboxed run, and asks when the run isn't sandboxed", async () => {
    asked.length = 0;
    const c = cmd("echo ZWNobyBoaQ== | base64 -d | sh");
    expect((await full.gate({ ...run("full"), sandboxed: true }, c, [t()])).decision).toBe("allow");
    expect(asked).toEqual([]);
    expect((await full.gate(run("full"), c, [t()])).decision).toBe("allow");
    expect(asked).toHaveLength(1);
  });

  it("refuses what you said never, in Full too", async () => {
    const v = await full.gate({ ...run("full"), sandboxed: true }, cmd("npm publish"), [wt]);
    expect(v.decision).toBe("deny");
    expect(v.reason).toContain("You said never: npm publish");
  });

  it("runs everything else: a push, a publish you never refused", async () => {
    asked.length = 0;
    for (const c of [
      "git push origin main",
      "npm publish --tag next",
      "curl -X POST https://example.com/deploy",
    ])
      expect((await full.gate({ ...run("full"), sandboxed: true }, cmd(c), [wt])).decision, c).toBe("allow");
    expect(asked).toEqual([]);
  });
});
