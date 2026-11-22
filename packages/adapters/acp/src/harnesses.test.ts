import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPENCODE_PLUGIN } from "./gate.js";
import { GROK_BUILD, OPENCODE, opencodeFailure } from "./harnesses.js";

// Regression (final review I8): a repo's opencode.json could set permissions back to "allow".
describe("opencode environment", () => {
  it("asks for edits, shell and web at every level, and ignores the repo's opencode config", () => {
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "x/y", permission: { edit: "allow" } });
    try {
      const env = OPENCODE.env?.() ?? {};
      const config = JSON.parse(
        readFileSync(join(env.XDG_CONFIG_HOME ?? "", "opencode", "opencode.json"), "utf8"),
      );
      const ask = { edit: "ask", bash: "ask", webfetch: "ask" };
      expect(config.model).toBe("x/y");
      expect(config.permission).toEqual(ask);
      expect(config.agent.build.permission).toEqual(ask);
      expect(config.agent.plan.permission).toEqual(ask);
      expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    } finally {
      delete process.env.OPENCODE_CONFIG_CONTENT;
    }
  });

  // Regression (Plan 03 end to end): a user's own permission_mode = "always-approve" let Grok run shell
  // commands without asking ion.
  it("starts Grok in ask mode whatever the user's Grok config says, with read-only commands asking too", () => {
    const env = GROK_BUILD.env!();
    expect(env.GROK_ASK_LOCAL_READS).toBe("false");
    // The CLI's name for ask mode is "default" (it has no "ask"); it outranks the user's config.toml.
    expect(GROK_BUILD.args).toEqual(["--permission-mode", "default", "agent", "stdio"]);
  });
  // The user, 2026-11-18: Grok's questions failed with "Method not found". Its own question card calls a client
  // method ion doesn't have (there's no card to show), so it's off, and Grok asks through ion's ask tool.
  it("turns off Grok's own question card, with or without the gate", () => {
    expect(GROK_BUILD.env?.(undefined).GROK_ASK_USER_QUESTION).toBe("false");
  });
});

const KEY = "sk-ant-api03-ionTestKeyThatMustNotTravel0123456789";

/**
 * A home with opencode's own config where opencode keeps it (servers, a plugin, a model, a provider key, file
 * references) and the legacy ~/.opencode; a cache folder of its own (never your real one).
 */
function opencodeHome(): { home: string; xdg: string; cache: string } {
  const home = mkdtempSync(join(tmpdir(), "ion-oc-home-"));
  const xdg = join(home, ".config");
  mkdirSync(join(xdg, "opencode"), { recursive: true });
  mkdirSync(join(home, ".opencode"), { recursive: true });
  const own = {
    model: "a/b",
    provider: { anthropic: { options: { apiKey: KEY } } },
    mcp: { everything: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"] } },
    plugin: ["file:///somewhere/mine.js"],
    instructions: ["rules.md", "/abs/other.md"],
    agent: { review: { prompt: "{file:./prompts/review.md}", model: "{env:REVIEW_MODEL}" } },
  };
  // opencode reads JSONC: comments and trailing commas.
  const text = `// mine\n${JSON.stringify(own, null, 2).replace(/\n}$/, ",\n}")}`;
  writeFileSync(join(xdg, "opencode", "opencode.jsonc"), text);
  writeFileSync(
    join(home, ".opencode", "opencode.json"),
    JSON.stringify({ mcp: { legacy: { type: "local" } } }),
  );
  return { home, xdg, cache: join(home, "cache") };
}

/** Runs `f` with these environment variables, then puts them back. */
function withEnv<T>(vars: Record<string, string | undefined>, f: () => T): T {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) delete process.env[k];
      else process.env[k] = x;
    }
  };
  put(vars);
  try {
    return f();
  } finally {
    put(was);
  }
}

/** opencode's plugin package as opencode installs it: asked for in package.json, there in node_modules. */
function installPlugin(dir: string, version: string) {
  const pkg = join(dir, "node_modules", "@opencode-ai", "plugin");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@opencode-ai/plugin", version }));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { "@opencode-ai/plugin": version } }),
  );
}

/** The config file read back, any key of it reachable (what the tests check). */
interface Loose {
  [k: string]: Loose;
}

const gate = (home: string) => ({ url: "http://127.0.0.1:1/gate/k", cwd: home });
/** opencode's env for a run in this home, and the config file ion wrote for it. */
function started(
  h: ReturnType<typeof opencodeHome>,
  more: Record<string, string | undefined> = {},
  own?: boolean,
) {
  const vars = {
    HOME: h.home,
    XDG_CONFIG_HOME: h.xdg,
    XDG_CACHE_HOME: h.cache,
    OPENCODE_CONFIG_CONTENT: undefined,
    ION_HOME: undefined,
  };
  const env = withEnv({ ...vars, ...more }, () => OPENCODE.env?.(gate(h.home), own) ?? {});
  const file = join(env.XDG_CONFIG_HOME ?? "", "opencode", "opencode.json");
  return { env, file, config: JSON.parse(readFileSync(file, "utf8")) as Loose };
}

// PR #26 follow-up, 2026-11-22: an ion on opencode couldn't read a file outside its project although ion's gate allowed
// the read. opencode's read tool then asks its own `external_directory` permission over ACP (kind "other", rawInput
// `{filepath, parentDir}`), which ion can't tell from any other call, so an ion refused it; Grok has no second ask.
describe("opencode outside the project", () => {
  it("leaves reads outside to ion's gate when there is one, and asks itself when there isn't", () => {
    const h = opencodeHome();
    const { env } = started(h);
    expect(JSON.parse(env.OPENCODE_PERMISSION ?? "{}")).toEqual({ external_directory: "allow" });
    const none = withEnv(
      { HOME: h.home, XDG_CONFIG_HOME: h.xdg, XDG_CACHE_HOME: h.cache },
      () => OPENCODE.env?.() ?? {},
    );
    expect(none.OPENCODE_PERMISSION).toBe("");
  });
});

// The user, 2026-11-21: "Only ion's, plus Import": in ion's chats every agent uses only the servers, hooks and skills
// set up in ion. opencode's own config folder is swapped for one of ion's (XDG_CONFIG_HOME: checked on opencode 1.18.8,
// `--pure` would drop ion's gate too), what else your config says is carried, and ion's plugin stays.
describe("only ion's tools in ion's chats", () => {
  it("an opencode chat in ion doesn't load opencode's own servers or plugins (ion's gate stays)", () => {
    const h = opencodeHome();
    const { env, config } = started(h, { OPENCODE_CONFIG: "/x.json" });
    expect(env.XDG_CONFIG_HOME).toBe(join(h.cache, "ion", "opencode", "default"));
    expect(env.ION_XDG_CONFIG_HOME).toBe(h.xdg);
    expect(env).toMatchObject({
      OPENCODE_CONFIG: "",
      OPENCODE_CONFIG_DIR: "",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    });
    expect(config.model).toBe("a/b");
    expect(config.plugin).toEqual([OPENCODE_PLUGIN]);
    expect(config.permission).toMatchObject({ edit: "ask", bash: "ask", webfetch: "ask" });
    // ~/.opencode still loads in opencode: its servers are turned off by name.
    expect(config.mcp).toEqual({ legacy: { enabled: false } });
  });

  // Task review, 2026-11-21: carried in OPENCODE_CONFIG_CONTENT, your provider keys reached every process opencode
  // started (LSP servers, formatters). They stay in a file of ion's (only you can read it); only the gate is in env.
  it("a key in your opencode config never appears in the agent's env", () => {
    const h = opencodeHome();
    const { env, file, config } = started(h, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "t", mcp: { x: {} } }),
    });
    expect(JSON.stringify(env)).not.toContain(KEY);
    expect(env.OPENCODE_CONFIG_CONTENT).toBe("");
    expect(env.ION_GATE_URL).toBe("http://127.0.0.1:1/gate/k");
    expect(config.provider.anthropic.options.apiKey).toBe(KEY);
    expect(config).toMatchObject({ theme: "t" });
    expect(config.mcp.x).toBeUndefined();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
  });

  it("keeps {env:} and {file:} references, with paths made whole against your config folder", () => {
    const h = opencodeHome();
    const { config } = started(h);
    expect(config.agent.review.model).toBe("{env:REVIEW_MODEL}");
    expect(config.agent.review.prompt).toBe(`{file:${join(h.xdg, "opencode", "prompts", "review.md")}}`);
    expect(config.instructions).toEqual([join(h.xdg, "opencode", "rules.md"), "/abs/other.md"]);
  });

  it("writes the file only when what ion wants changes", () => {
    const h = opencodeHome();
    const { file } = started(h);
    const before = statSync(file).mtimeMs;
    const ino = statSync(file).ino;
    started(h);
    expect(statSync(file).mtimeMs).toBe(before);
    expect(statSync(file).ino).toBe(ino);
  });

  // Task review, 2026-11-21: anything left in ion's folder (a plugin, a tool, another config file, a dependency) would
  // load in every later chat. Each start puts the folder back to exactly what ion wants.
  it("a planted plugin, tool, config file or dependency is removed at start", () => {
    const h = opencodeHome();
    const dir = join(h.cache, "ion", "opencode", "default", "opencode");
    mkdirSync(join(dir, "plugin"), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "tool"), { recursive: true });
    writeFileSync(join(dir, "plugin", "x.js"), "export const X = async () => ({})");
    writeFileSync(join(dir, "tool", "y.ts"), "");
    writeFileSync(join(dir, "opencode.jsonc"), '{"mcp":{"evil":{}}}');
    writeFileSync(join(dir, "AGENTS.md"), "do evil");
    const deps = { "@opencode-ai/plugin": "1.18.8", "left-pad": "1.0.0" };
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
    started(h);
    expect(readdirSync(dir).sort()).toEqual([".gitignore", "opencode.json", "package.json"]);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({ "@opencode-ai/plugin": "1.18.8" });
  });

  it("refuses a folder that isn't ion's own (a link, or open to others)", () => {
    const h = opencodeHome();
    mkdirSync(join(h.cache, "ion"), { recursive: true, mode: 0o700 });
    const elsewhere = mkdtempSync(join(tmpdir(), "ion-oc-elsewhere-"));
    symlinkSync(elsewhere, join(h.cache, "ion", "opencode"));
    expect(() => started(h)).toThrow("ion's folder for opencode isn't safe");
    const h2 = opencodeHome();
    mkdirSync(join(h2.cache, "ion", "opencode"), { recursive: true, mode: 0o777 });
    chmodSync(join(h2.cache, "ion", "opencode"), 0o777);
    expect(() => started(h2)).toThrow("ion's folder for opencode isn't safe");
  });

  // Final review, 2026-11-21: one folder per computer, so the tour, a dev daemon and the app (each its own ION_HOME)
  // rewrote and cleaned the same folder under each other. It's one per ion home, still in ~/.cache/ion.
  it("each ion home gets its own folder for opencode, inside ~/.cache/ion/opencode", () => {
    const h = opencodeHome();
    const a = started(h, { ION_HOME: "/homes/a" }).env.XDG_CONFIG_HOME!;
    const b = started(h, { ION_HOME: "/homes/b" }).env.XDG_CONFIG_HOME!;
    const again = started(h, { ION_HOME: "/homes/a" }).env.XDG_CONFIG_HOME!;
    expect(a).not.toBe(b);
    expect(again).toBe(a);
    for (const d of [a, b]) expect(d.startsWith(`${join(h.cache, "ion", "opencode")}/`)).toBe(true);
  });

  // Live, 2026-11-21: opencode installs its plugin package into ion's folder once; a first chat that waits on it timed
  // out as "didn't respond". Until it's there, a start that times out says opencode is setting up.
  // Task review, 2026-11-21: "setting up" was read from files a run could write (an empty plugin folder counted as
  // installed). It's ion's own state now: set when ion prepares the folder and finds the package opencode asked for.
  it("says opencode is setting up while its folder isn't ready", () => {
    const h = opencodeHome();
    const { env } = started(h);
    const dir = join(env.XDG_CONFIG_HOME!, "opencode");
    const hint = () => withEnv({ XDG_CACHE_HOME: h.cache }, () => OPENCODE.notResponding?.());
    expect(hint()).toBe("Not responding — opencode is setting up, try again");
    mkdirSync(join(dir, "node_modules", "@opencode-ai", "plugin"), { recursive: true });
    started(h);
    expect(hint()).toBe("Not responding — opencode is setting up, try again");
    installPlugin(dir, "1.18.8");
    expect(hint()).toBe("Not responding — opencode is setting up, try again");
    started(h);
    expect(hint()).toBeUndefined();
  });

  // Grok has no switch for its own config.toml servers, ~/.grok/hooks or its plugins (GROK_CONFIG can't set them;
  // GROK_HOME moves its sign-in too): ion turns off what it reads from Claude and Cursor, and Settings says the rest.
  // Task review, 2026-11-21: opencode too (~/.opencode/plugin still loads).
  it("Grok reads no Claude or Cursor servers, hooks or skills, and Settings says Grok and opencode load their own", () => {
    const env = GROK_BUILD.env!();
    for (const k of [
      "CLAUDE_MCPS",
      "CLAUDE_HOOKS",
      "CLAUDE_SKILLS",
      "CURSOR_MCPS",
      "CURSOR_HOOKS",
      "CURSOR_SKILLS",
    ])
      expect(env[`GROK_${k}_ENABLED`]).toBe("false");
    expect(GROK_BUILD.ownTools).toBe(true);
    expect(OPENCODE.ownTools).toBe(true);
  });
});

// The user, 2026-11-21: "since grok build and opencode can't turn their own servers and plugins off, then i don't see
// the point of disabling … Hooks probably should stay as these would need to be consistent." With "Use its own
// tools" on, each agent brings its own; ion's gate stays.
describe("agents bring their own tools", () => {
  it("opencode carries the user's mcp and plugins, and ion's gate plugin stays", () => {
    const h = opencodeHome();
    const dir = join(h.xdg, "opencode");
    mkdirSync(join(dir, "plugin"));
    writeFileSync(join(dir, "plugin", "notify.js"), "export const N = async () => ({})");
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({ command: { ship: { template: "ship it" } }, plugin: ["oc-thing", "./local.js"] }),
    );
    const { env, config } = started(h, {}, true);
    // A folder of its own, so a chat with its own tools and ion's judge never rewrite each other's file.
    expect(env.XDG_CONFIG_HOME).toBe(join(h.cache, "ion", "opencode", "default-own"));
    // ion's gate plugin last (task review, 2026-11-21): it judges a call as your plugins left it.
    expect(config.plugin).toEqual([
      "oc-thing",
      `file://${join(dir, "local.js")}`,
      "file:///somewhere/mine.js",
      `file://${join(dir, "plugin", "notify.js")}`,
      OPENCODE_PLUGIN,
    ]);
    expect(config.mcp).toEqual({
      everything: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"] },
    });
    expect(config.command.ship).toEqual({ template: "ship it" });
    expect(config.agent.review.prompt).toBe(`{file:${join(dir, "prompts", "review.md")}}`);
    expect(config.instructions).toEqual([join(dir, "rules.md"), "/abs/other.md"]);
    expect(config.permission).toMatchObject({ edit: "ask", bash: "ask", webfetch: "ask" });
    expect(env.ION_GATE_URL).toBe("http://127.0.0.1:1/gate/k");
  });

  it("Use its own tools off brings back ion's tools only (opencode)", () => {
    const h = opencodeHome();
    const { config, env } = started(h, {}, false);
    expect(env.XDG_CONFIG_HOME).toBe(join(h.cache, "ion", "opencode", "default"));
    expect(config.plugin).toEqual([OPENCODE_PLUGIN]);
    expect(config.mcp).toEqual({ legacy: { enabled: false } });
  });

  it("a folder of its own takes opencode's plugin package from the other, so a first chat needn't wait", () => {
    const h = opencodeHome();
    const off = started(h).env.XDG_CONFIG_HOME!;
    mkdirSync(join(off, "opencode", "node_modules", "@opencode-ai", "plugin"), { recursive: true });
    installPlugin(join(off, "opencode"), "1");
    const own = started(h, {}, true).env.XDG_CONFIG_HOME!;
    expect(statSync(join(own, "opencode", "node_modules", "@opencode-ai", "plugin")).isDirectory()).toBe(
      true,
    );
    const hint = () => withEnv({ XDG_CACHE_HOME: h.cache }, () => OPENCODE.notResponding?.(true));
    expect(hint()).toBeUndefined();
  });

  it("Grok keeps its own servers and skills; Claude's and Cursor's hooks stay off, and Settings says its own hooks run", () => {
    const env = GROK_BUILD.env!(undefined, true);
    for (const k of ["CLAUDE_MCPS", "CLAUDE_SKILLS", "CURSOR_MCPS", "CURSOR_SKILLS"])
      expect(env[`GROK_${k}_ENABLED`]).toBeUndefined();
    for (const k of ["CLAUDE_HOOKS", "CURSOR_HOOKS"]) expect(env[`GROK_${k}_ENABLED`]).toBe("false");
    expect(GROK_BUILD.ownHooks).toBe(true);
    expect(OPENCODE.ownHooks).toBe(true);
  });
});

// Task review, 2026-11-21: opencode read skills from ~/.claude and ~/.agents by itself, whatever the switch said, and
// its own skills folder was dropped with its config folder. External skills are off; with "Use its own tools" on,
// ion names your home skill folders; a project's never (they'd come only once consented in ion).
describe("opencode's skills", () => {
  it("are what the switch says: your home folders with it on, none of its own with it off", () => {
    const h = opencodeHome();
    const on = started(h, {}, true);
    expect(on.env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1");
    expect(on.config.skills.paths).toEqual([
      join(h.xdg, "opencode", "skills"),
      join(h.home, ".claude", "skills"),
      join(h.home, ".agents", "skills"),
    ]);
    const off = started(h, {}, false);
    expect(off.env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1");
    expect(off.config.skills).toBeUndefined();
  });
});

// Task review, 2026-11-21: Settings said "Off in ion" for what an agent still loads. Each agent says what its switch
// really turns off, by kind, and whether it trusts a project's own tools by itself.
describe("what each switch really turns off", () => {
  it("opencode: its servers and skills, not every plugin; Grok: none of its own, and its own trust", () => {
    expect(OPENCODE.ownOff).toEqual({ servers: true, skills: true, plugins: false });
    expect(GROK_BUILD.ownOff).toEqual({ servers: false, skills: false, plugins: false });
    expect(GROK_BUILD.ownTrust).toBe(true);
    expect(OPENCODE.ownTrust).toBeUndefined();
  });
});

// Live, 2026-11-21: opencode out of its free quota only said so in its own log.
describe("opencode's log", () => {
  it("gives a failed model call's reason, without the SDK's error name", () => {
    const line =
      'timestamp=x level=ERROR message="stream error" providerID=opencode error.error="AI_APICallError: Free usage limit reached. Try again later." x=1';
    // Automated review, 2026-11-21: a known case in ion's own words; anything else without URLs or key-like words.
    expect(opencodeFailure(line)).toBe(
      "opencode's free usage is used up — try again later or pick another model",
    );
    const other =
      'level=ERROR message="stream error" error.error="AI_APICallError: Unauthorized for https://api.example/v1?key=sk-abc123 token=xyz Bearer abc.def secret_thing"';
    const said = opencodeFailure(other)!;
    expect(said).toMatch(/^opencode: Unauthorized for/);
    for (const bad of ["https://", "sk-abc123", "xyz", "abc.def", "secret_thing", "?key"])
      expect(said).not.toContain(bad);
    expect(
      opencodeFailure(`level=ERROR message="stream error" error.error="${"x ".repeat(300)}"`)!.length,
    ).toBeLessThanOrEqual(200);
    expect(opencodeFailure('level=INFO message="init"')).toBeNull();
    expect(OPENCODE.args).toEqual(["acp", "--print-logs", "--log-level", "WARN"]);
  });
});

// The user, 2026-11-21 (Plan 18 Task 12): in a run's sandbox, opencode reads ion's folder for it (its config) but no
// one in the run writes it, nor your own opencode config; Grok's hooks (ion's gate among them) can't be changed.
describe("agents' own paths in a run's sandbox", () => {
  it("opencode reads ion's config for it; its own config folders aren't written", () => {
    const h = opencodeHome();
    const { env } = started(h);
    mkdirSync(join(env.XDG_CONFIG_HOME!, "opencode", "node_modules", "@opencode-ai", "plugin"), {
      recursive: true,
    });
    const p = withEnv({ XDG_CACHE_HOME: h.cache }, () => OPENCODE.sandboxPaths?.(false));
    expect(p?.read?.[0]).toMatch(/\/ion\/opencode\/[^/]+$/);
    expect(p?.noWrite).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/opencode$/), expect.stringMatching(/\/\.opencode$/)]),
    );
    expect(p?.write).toBeUndefined();
  });

  // Live, 2026-11-21: in the sandbox opencode stopped at its start ("FileSystem.writeFile … opencode/.gitignore"): it
  // writes its .gitignore into its config folder when it's missing. ion writes it first, so a run needn't; until
  // opencode's plugin package is installed there (a first start), the run may write that folder.
  // Task review, 2026-11-21: a run that may write ion's folder for opencode (while it set up) could plant code there for
  // later chats. ion installs opencode's plugin package itself, outside the sandbox, before a sandboxed start: every
  // run only reads that folder.
  it("opencode's folder has its .gitignore already, and a run never writes it", () => {
    const h = opencodeHome();
    const { env } = started(h, {}, true);
    const dir = join(env.XDG_CONFIG_HOME!, "opencode");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore",
    );
    const paths = withEnv({ XDG_CACHE_HOME: h.cache }, () => OPENCODE.sandboxPaths?.(true));
    expect(paths?.write).toBeUndefined();
    expect(paths?.read).toEqual([env.XDG_CONFIG_HOME]);
  });

  // Final review, 2026-11-22: a Grok run could plant code in ~/.grok/installed-plugins (an enabled plugin's files,
  // its registry) or ~/.grok/plugins, which Grok loads in later starts, some outside the sandbox. Read-only too.
  it("Grok's hooks, config, skills and plugins aren't written", () => {
    const p = GROK_BUILD.sandboxPaths?.();
    expect(p?.noWrite?.map((x) => x.split("/").pop())).toEqual([
      "hooks",
      "config.toml",
      "skills",
      "installed-plugins",
      "plugins",
    ]);
  });
});

// Final review, 2026-11-22 (live: Grok's judge timed out in every live chat, up to 44 s): the judge ran Grok with all
// its tools (it tried them, got refused, tried again) on its slow default model at high effort. A bare start runs Grok
// with an agent profile that allows no tool of consequence (checked live: GROK_CONFIG's toolset can't remove tools and
// `--tools` doesn't reach `agent stdio`; a profile does), on its fast model at low effort, and its sessions are
// deleted after. opencode's are deleted too; its tools are refused by ion's gate (no switch removes them all).
describe("ion's judge on ACP agents", () => {
  it("runs Grok with a no-tools profile, its fast model and low effort", () => {
    const dir = mkdtempSync(join(tmpdir(), "ion-bare-grok-"));
    const args = GROK_BUILD.bare?.args?.(dir) ?? [];
    const at = args.indexOf("--agent-profile");
    expect(at).toBeGreaterThan(-1);
    expect(args).toEqual(
      expect.arrayContaining(["--permission-mode", "default", "agent", "--no-leader", "stdio"]),
    );
    const profile = readFileSync(args[at + 1]!, "utf8");
    expect(args[at + 1]!.startsWith(dir)).toBe(true);
    expect(profile).toMatch(/^tools: todo_write$/m);
    expect(profile).toMatch(/^mcpInheritance: none$/m);
    expect(GROK_BUILD.bare?.model).toBe("grok-4.7-build-fast");
    expect(GROK_BUILD.bare?.effort).toBe("low");
  });

  // PR #25 review, 2026-11-22: the profile is written fresh (no link followed, nothing left in its place reused).
  it("writes Grok's profile fresh, never through a link left in its place", () => {
    const dir = mkdtempSync(join(tmpdir(), "ion-bare-grok-"));
    const target = join(dir, "elsewhere.md");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, "ion-judge.md"));
    const args = GROK_BUILD.bare?.args?.(dir) ?? [];
    const file = args[args.indexOf("--agent-profile") + 1]!;
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(readFileSync(file, "utf8")).toMatch(/^tools: todo_write$/m);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("deletes the judge's sessions from each agent's history", () => {
    expect(GROK_BUILD.forgetArgs?.("abc")).toEqual(["sessions", "delete", "abc"]);
    expect(OPENCODE.forgetArgs?.("ses_1")).toEqual(["session", "delete", "ses_1"]);
    expect(OPENCODE.bare?.effort).toBe("low");
  });
});
