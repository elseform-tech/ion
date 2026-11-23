import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  loadUserConfig,
  projectRemembered,
  setMemory,
  type UserConfig,
  youRemembered,
} from "./index.js";

const withProjects: UserConfig = {
  ...DEFAULT_CONFIG,
  projects: [
    { id: "shop", path: "/p/shop", starred: false },
    { id: "api", path: "/p/api", starred: false },
  ],
};

// The user, 2026-11-23: "a way to disable memory": on or off everywhere (your own memory follows it), and per
// project (absent: it follows everywhere).
describe("memory's switches", () => {
  it("is on by default, everywhere and in every project", () => {
    expect(youRemembered(DEFAULT_CONFIG)).toBe(true);
    expect(projectRemembered(withProjects, "shop")).toBe(true);
  });

  it("a project follows everywhere until you set it", () => {
    const off = setMemory(withProjects, false);
    expect([youRemembered(off), projectRemembered(off, "shop"), projectRemembered(off, "nope")]).toEqual([
      false,
      false,
      false,
    ]);
    const shopOn = setMemory(off, true, "shop");
    expect([projectRemembered(shopOn, "shop"), projectRemembered(shopOn, "api")]).toEqual([true, false]);
  });

  it("a project set like everywhere follows it again", () => {
    const shopOff = setMemory(withProjects, false, "shop");
    expect(shopOff.projects.find((p) => p.id === "shop")?.memory).toBe(false);
    const back = setMemory(shopOff, true, "shop");
    expect(back.projects.find((p) => p.id === "shop")).not.toHaveProperty("memory");
    // Everywhere off and on again keeps a project you turned off.
    const again = setMemory(setMemory(shopOff, false), true);
    expect(projectRemembered(again, "shop")).toBe(false);
  });

  it("refuses an unknown project", () => {
    expect(() => setMemory(withProjects, false, "nope")).toThrow("Unknown project: nope");
  });

  it("a bad value in the file falls back to on, with the rest kept", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ion-mem-cfg-")), "config.toml");
    writeFileSync(
      f,
      '[memory]\non = "no"\ndream = "nightly"\n\n[[projects]]\nid = "shop"\npath = "/p/shop"\nmemory = "maybe"\n',
    );
    const r = loadUserConfig(f);
    expect(r.error).toBeNull();
    expect([youRemembered(r.config), projectRemembered(r.config, "shop"), r.config.memory.dream]).toEqual([
      true,
      true,
      "nightly",
    ]);
    expect(r.warning).toContain("shop.memory");
  });
});
