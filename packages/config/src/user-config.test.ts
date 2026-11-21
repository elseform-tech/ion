import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  ionPaths,
  loadUserConfig,
  ownToolsOn,
  PROFILE_CHARS,
  saveUserConfig,
} from "./index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "ion-cfg-"));

describe("ionPaths", () => {
  it("uses ION_HOME for both config and data", () => {
    expect(ionPaths({ ION_HOME: "/x" })).toEqual({ configFile: "/x/config.toml", dataDir: "/x/data" });
  });
  it("uses XDG dirs when set", () => {
    expect(ionPaths({ HOME: "/h", XDG_CONFIG_HOME: "/c", XDG_DATA_HOME: "/d" })).toEqual({
      configFile: "/c/ion/config.toml",
      dataDir: "/d/ion",
    });
  });
  it("falls back to ~/.config and ~/.local/share", () => {
    expect(ionPaths({ HOME: "/h" })).toEqual({
      configFile: "/h/.config/ion/config.toml",
      dataDir: "/h/.local/share/ion",
    });
  });
});

describe("loadUserConfig", () => {
  it("returns defaults when the file is missing", () => {
    expect(loadUserConfig(join(tmp(), "config.toml"))).toEqual({
      config: DEFAULT_CONFIG,
      error: null,
      warning: null,
    });
  });
  it("returns defaults and a one-line error for a bad value", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(f, '[ion]\ndeepEffort = "huge"\n');
    const r = loadUserConfig(f);
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.error).toBe("config.toml: ion.deepEffort must be one of low, medium, high, max");
  });
  it("returns defaults and an error for broken TOML", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(f, "[ion\n");
    const r = loadUserConfig(f);
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.error).toMatch(/^config\.toml: /);
  });
  it("fills missing keys with defaults", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(f, '[ion]\nuseDeep = "never"\n');
    expect(loadUserConfig(f).config.ion).toEqual({ ...DEFAULT_CONFIG.ion, useDeep: "never" });
  });
  it("saves the file readable only by you, in a private folder", () => {
    const f = join(tmp(), "new-dir", "config.toml");
    saveUserConfig(f, DEFAULT_CONFIG);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(f, "..")).mode & 0o777).toBe(0o700);
  });

  // Regression (final review I3): saving used to erase keys this version doesn't know.
  it("keeps keys it doesn't know when saving", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(f, '[ion]\nfutureKnob = "on"\n\n[notifications]\nsound = "ping"\n');
    const { config } = loadUserConfig(f);
    saveUserConfig(f, { ...config, projects: [{ id: "api", path: "/code/api", starred: false }] });
    const text = readFileSync(f, "utf8");
    expect(text).toContain('futureKnob = "on"');
    expect(text).toContain('sound = "ping"');
    expect(text).toContain("[[projects]]");
  });

  it("round-trips through saveUserConfig", () => {
    const f = join(tmp(), "nested", "config.toml");
    const c = { ...DEFAULT_CONFIG, projects: [{ id: "api", path: "/code/api", starred: true }] };
    saveUserConfig(f, c);
    expect(loadUserConfig(f)).toEqual({ config: c, error: null, warning: null });
    expect(readFileSync(f, "utf8")).toContain("[[projects]]");
  });

  it("defaults resources.max_runs to auto and accepts a number", () => {
    expect(DEFAULT_CONFIG.resources.max_runs).toBe("auto");
    const file = join(mkdtempSync(join(tmpdir(), "ion-cfg-")), "config.toml");
    writeFileSync(file, "[resources]\nmax_runs = 3\n");
    expect(loadUserConfig(file).config.resources.max_runs).toBe(3);
    writeFileSync(file, "[resources]\nmax_runs = 0\n");
    expect(loadUserConfig(file).warning).toContain("max_runs");
  });

  it("leaves the models to each harness by default", () => {
    expect(DEFAULT_CONFIG.ion).toMatchObject({ quick: "claude-code", deep: "claude-code" });
  });
});

// Final review, 2026-11-19: the profile's limit was written three times (the config, its ion's tool, Settings).
// One constant, here, is what the config checks.
describe("a project's profile", () => {
  it("is at most PROFILE_CHARS long, as is a suggestion", () => {
    const f = join(tmp(), "config.toml");
    const at = (n: number) => ({ id: "a", path: "/a", starred: false, profile: "x".repeat(n) });
    saveUserConfig(f, { ...DEFAULT_CONFIG, projects: [at(PROFILE_CHARS)] });
    expect(loadUserConfig(f).error).toBeNull();
    writeFileSync(
      f,
      readFileSync(f, "utf8").replace("x".repeat(PROFILE_CHARS), "x".repeat(PROFILE_CHARS + 1)),
    );
    expect(loadUserConfig(f).error).toMatch(/profile/);
  });
});

// The user, 2026-11-19: Settings (General, Notifications) are kept in your config.
describe("general and notification settings", () => {
  it("has defaults, and a bad time or a count outside 1-32 falls back with a warning", () => {
    expect(DEFAULT_CONFIG.notifications.briefing).toEqual({ on: true, at: "08:30" });
    expect(DEFAULT_CONFIG.notifications.quiet).toEqual({ on: true, from: "22:00", to: "08:00" });
    const file = join(mkdtempSync(join(tmpdir(), "ion-cfg-")), "config.toml");
    for (const bad of ['[notifications.briefing]\nat = "25:00"', "[resources]\nmax_runs = 33"]) {
      writeFileSync(file, bad);
      expect(loadUserConfig(file).warning).not.toBeNull();
    }
    writeFileSync(file, '[[projects]]\nid = "a"\npath = "/a"\nnotify = "muted"\n');
    expect(loadUserConfig(file).config.projects[0]!.notify).toBe("muted");
  });
});

// Task review, 2026-11-20: a hand-edited bad value in notifications or max_runs failed the whole load, so every
// project, routine and profile vanished and every write was refused. It falls back alone, with a warning.
describe("a bad hand-edited setting", () => {
  it("falls back to its default with a warning, and the rest of the config loads", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(
      f,
      [
        "[resources]",
        "max_runs = 40",
        "[notifications]",
        'briefing = "08:30"',
        "[notifications.quiet]",
        'from = "25:00"',
        'to = "07:00"',
        "[[projects]]",
        'id = "api"',
        'path = "/code/api"',
        'profile = "the api"',
        "",
      ].join("\n"),
    );
    const { config, error, warning } = loadUserConfig(f);
    expect(error).toBeNull();
    expect(config.projects[0]).toMatchObject({ id: "api", profile: "the api" });
    expect(config.resources.max_runs).toBe("auto");
    expect(config.notifications.briefing).toEqual({ on: true, at: "08:30" });
    expect(config.notifications.quiet).toEqual({ on: true, from: "22:00", to: "07:00" });
    expect(warning).toContain("max_runs");
    expect(warning).toContain("briefing");
    expect(warning).toContain("quiet.from");
  });

  // The user, 2026-11-20/21: Auto-approval is never turned off in Settings, only per chat with the composer's access
  // icon, so General's Default access is gone: a hand-edited access.default is ignored, with a warning.
  it("ignores access.default with a warning: new chats start on Auto", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(f, '[access]\ndefault = "full"\njudge = "x:y"\n');
    const { config, error, warning } = loadUserConfig(f);
    expect(error).toBeNull();
    expect(config.access).not.toHaveProperty("default");
    expect(config.access.judge).toBe("x:y");
    expect(warning).toContain("access.default");
    writeFileSync(f, '[access]\ndefault = "nope"\n');
    expect(loadUserConfig(f).error).toBeNull();
    writeFileSync(f, '[access]\ndefault = "auto"\n');
    expect(loadUserConfig(f).warning).toBeNull();
  });

  // Task review, 2026-11-21: a project's own access still switched Auto-approval off for its chats. It's ignored, with
  // a warning, like access.default.
  it("a project's access is ignored: new chats start on Auto", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(f, '[[projects]]\nid = "shop"\npath = "/s"\naccess = "full"\n');
    const { config, error, warning } = loadUserConfig(f);
    expect(error).toBeNull();
    expect(config.projects[0]).not.toHaveProperty("access");
    expect(warning).toContain("shop.access");
  });

  it("has no warning when everything is fine", () => {
    expect(loadUserConfig(join(tmp(), "none.toml")).warning).toBeNull();
  });

  // Task review, 2026-11-20: a bad project `notify`, or `notifications` that isn't a table, still failed the load.
  it("drops a bad project notify and a non-table notifications alone", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(
      f,
      'notifications = "on"\n[[projects]]\nid = "storefront"\npath = "/s"\nnotify = "loud"\n[[projects]]\nid = "api"\npath = "/a"\nnotify = "muted"\n',
    );
    const { config, error, warning } = loadUserConfig(f);
    expect(error).toBeNull();
    expect(config.projects.map((p) => [p.id, p.notify])).toEqual([
      ["storefront", undefined],
      ["api", "muted"],
    ]);
    expect(config.notifications.briefing).toEqual({ on: true, at: "08:30" });
    expect(warning).toContain("storefront.notify");
    expect(warning).toContain("notifications");
  });
});

// Plan 18 (the user, 2026-11-20: "adding new mcp required us to follow industry standard"): servers come from
// mcp.json; ion's config keeps only what you turned on, your hooks and the skills you turned on. No keys, ever.
// The user, 2026-11-20: a skill is instructions every Claude chat follows, so it's off until you turn it on.
// The user, 2026-11-20: a new server starts off until you turn it on — ion keeps the ones you turned on.
describe("tools in your config", () => {
  it("has empty tools by default, keeps what you turned off and your hooks, and never a key", () => {
    expect(DEFAULT_CONFIG.tools).toEqual({ mcpOn: [], hooks: [], hooksOn: [], skills: { on: [] } });
    const f = join(tmp(), "config.toml");
    const hook = { id: "h1", name: "Tell me", on: true, event: "run.finished" as const, run: "say done" };
    saveUserConfig(f, {
      ...DEFAULT_CONFIG,
      tools: {
        mcpOn: ["github@0123456789ab"],
        hooks: [hook],
        hooksOn: ["h1@0123456789ab"],
        skills: { on: ["~/.claude/skills/pdf@0123456789ab"] },
      },
    });
    expect(loadUserConfig(f).config.tools).toEqual({
      mcpOn: ["github@0123456789ab"],
      hooks: [hook],
      hooksOn: ["h1@0123456789ab"],
      skills: { on: ["~/.claude/skills/pdf@0123456789ab"] },
    });
  });

  it("drops a bad hook alone, with a warning, and the rest loads", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(
      f,
      [
        "[tools]",
        'mcpOn = ["github@0123456789ab"]',
        "[[tools.hooks]]",
        'id = "good"',
        'name = "Tell me"',
        'event = "run.finished"',
        'run = "say done"',
        "[[tools.hooks]]",
        'id = "bad"',
        'name = "Nope"',
        'event = "run.failed"',
        "",
      ].join("\n"),
    );
    const { config, error, warning } = loadUserConfig(f);
    expect(error).toBeNull();
    expect(config.tools.mcpOn).toEqual(["github@0123456789ab"]);
    expect(config.tools.hooks.map((h) => [h.id, h.on])).toEqual([["good", true]]);
    expect(warning).toContain("hooks.bad");
  });
});

describe("agents.<id>.ownTools", () => {
  // The user, 2026-11-21: "user would like to use the skills, mcp, or plugins that is already in the harness": each
  // agent brings its own by default; "Use its own tools" off brings back ion's tools only.
  it("is on unless you turn it off, and a bad value falls back alone", () => {
    const f = join(tmp(), "config.toml");
    writeFileSync(
      f,
      ["[agents.codex]", "ownTools = false", "[agents.grok-build]", 'ownTools = "no"', ""].join("\n"),
    );
    const { config, error } = loadUserConfig(f);
    expect(error).toBeNull();
    expect(ownToolsOn(config, "codex")).toBe(false);
    expect(ownToolsOn(config, "grok-build")).toBe(true);
    expect(ownToolsOn(config, "claude-code")).toBe(true);
    expect(ownToolsOn(DEFAULT_CONFIG, "opencode")).toBe(true);
  });
});
