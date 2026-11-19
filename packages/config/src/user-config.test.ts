import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, ionPaths, loadUserConfig, PROFILE_CHARS, saveUserConfig } from "./index.js";

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
    expect(loadUserConfig(join(tmp(), "config.toml"))).toEqual({ config: DEFAULT_CONFIG, error: null });
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
    expect(loadUserConfig(f)).toEqual({ config: c, error: null });
    expect(readFileSync(f, "utf8")).toContain("[[projects]]");
  });

  it("defaults resources.max_runs to auto and accepts a number", () => {
    expect(DEFAULT_CONFIG.resources.max_runs).toBe("auto");
    const file = join(mkdtempSync(join(tmpdir(), "ion-cfg-")), "config.toml");
    writeFileSync(file, "[resources]\nmax_runs = 3\n");
    expect(loadUserConfig(file).config.resources.max_runs).toBe(3);
    writeFileSync(file, "[resources]\nmax_runs = 0\n");
    expect(loadUserConfig(file).error).toContain("max_runs");
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
  it("has defaults, and refuses a bad time or a count outside 1-32", () => {
    expect(DEFAULT_CONFIG.notifications.briefing).toEqual({ on: true, at: "08:30" });
    expect(DEFAULT_CONFIG.notifications.quiet).toEqual({ on: true, from: "22:00", to: "08:00" });
    const file = join(mkdtempSync(join(tmpdir(), "ion-cfg-")), "config.toml");
    for (const bad of ['[notifications.briefing]\nat = "25:00"', "[resources]\nmax_runs = 33"]) {
      writeFileSync(file, bad);
      expect(loadUserConfig(file).error).not.toBeNull();
    }
    writeFileSync(file, '[[projects]]\nid = "a"\npath = "/a"\nnotify = "muted"\n');
    expect(loadUserConfig(file).config.projects[0]!.notify).toBe("muted");
  });
});
