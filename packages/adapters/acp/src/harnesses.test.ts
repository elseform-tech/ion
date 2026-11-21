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
import { GROK_BUILD, OPENCODE } from "./harnesses.js";

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

/** The config file read back, any key of it reachable (what the tests check). */
interface Loose {
  [k: string]: Loose;
}

const gate = (home: string) => ({ url: "http://127.0.0.1:1/gate/k", cwd: home });
/** opencode's env for a run in this home, and the config file ion wrote for it. */
function started(h: ReturnType<typeof opencodeHome>, more: Record<string, string | undefined> = {}) {
  const vars = {
    HOME: h.home,
    XDG_CONFIG_HOME: h.xdg,
    XDG_CACHE_HOME: h.cache,
    OPENCODE_CONFIG_CONTENT: undefined,
    ION_HOME: undefined,
  };
  const env = withEnv({ ...vars, ...more }, () => OPENCODE.env?.(gate(h.home)) ?? {});
  const file = join(env.XDG_CONFIG_HOME ?? "", "opencode", "opencode.json");
  return { env, file, config: JSON.parse(readFileSync(file, "utf8")) as Loose };
}

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
    expect(readdirSync(dir).sort()).toEqual(["opencode.json", "package.json"]);
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
  it("says opencode is setting up while its folder isn't ready", () => {
    const h = opencodeHome();
    const { env } = started(h);
    const hint = () => withEnv({ XDG_CACHE_HOME: h.cache }, () => OPENCODE.notResponding?.());
    expect(hint()).toBe("Not responding — opencode is setting up, try again");
    mkdirSync(join(env.XDG_CONFIG_HOME!, "opencode", "node_modules", "@opencode-ai", "plugin"), {
      recursive: true,
    });
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
