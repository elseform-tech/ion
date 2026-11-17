import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, ionPaths, loadUserConfig, saveUserConfig } from "./index.js";

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
    writeFileSync(f, '[ion]\nfutureKnob = "on"\n\n[notifications]\nbriefing = "08:30"\n');
    const { config } = loadUserConfig(f);
    saveUserConfig(f, { ...config, projects: [{ id: "api", path: "/code/api", starred: false }] });
    const text = readFileSync(f, "utf8");
    expect(text).toContain('futureKnob = "on"');
    expect(text).toContain('briefing = "08:30"');
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
});
