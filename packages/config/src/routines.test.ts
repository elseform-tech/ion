import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addRoutine,
  DEFAULT_CONFIG,
  loadUserConfig,
  removeRoutine,
  updateRoutine,
  type UserConfig,
} from "./index.js";

const base = (): UserConfig => ({
  ...DEFAULT_CONFIG,
  projects: [
    { id: "storefront", path: "/p/storefront", starred: false },
    { id: "default", path: "/p/default", starred: false },
  ],
});

const routinesOf = (c: UserConfig) => c.projects.find((p) => p.id === "storefront")?.routines ?? [];

describe("routines in your config", () => {
  it("adds one to a project, on, with an id from its name", () => {
    const { config, routine } = addRoutine(base(), "storefront", {
      name: "Morning check",
      when: "daily 9:00",
      text: "Run the tests and say what broke.",
    });
    expect(routine).toEqual({
      id: "morning-check",
      name: "Morning check",
      when: "daily 09:00",
      text: "Run the tests and say what broke.",
      on: true,
    });
    expect(routinesOf(config)).toEqual([routine]);
  });

  it("gives a second routine of the same name its own id", () => {
    const one = addRoutine(base(), "storefront", { name: "Check", when: "every 4h", text: "a" }).config;
    const two = addRoutine(one, "storefront", { name: "Check", when: "every 4h", text: "b" });
    expect(two.routine.id).toBe("check-2");
  });

  it("refuses a bad schedule, an empty name or text, default, and an unknown project", () => {
    const add = (projectId: string, r: { name: string; when: string; text: string }) => () =>
      addRoutine(base(), projectId, r);
    expect(add("storefront", { name: "x", when: "sometimes", text: "y" })).toThrow("Pick when it runs");
    expect(add("storefront", { name: " ", when: "daily 9:00", text: "y" })).toThrow("Give it a name");
    expect(add("storefront", { name: "x", when: "daily 9:00", text: "" })).toThrow("Say what to do");
    expect(add("default", { name: "x", when: "daily 9:00", text: "y" })).toThrow("default has no ion");
    expect(add("nope", { name: "x", when: "daily 9:00", text: "y" })).toThrow("Unknown project: nope");
  });

  it("changes and removes one; a null effort or skip clears it", () => {
    let c = addRoutine(base(), "storefront", {
      name: "A",
      when: "daily 9:00",
      text: "t",
      effort: "low",
    }).config;
    c = updateRoutine(c, "storefront", "a", {
      on: false,
      when: "fri 17:00",
      effort: null,
      skip: "2026-11-20T08:00:00.000Z",
    });
    expect(routinesOf(c)[0]).toEqual({
      id: "a",
      name: "A",
      when: "fri 17:00",
      text: "t",
      on: false,
      skip: "2026-11-20T08:00:00.000Z",
    });
    c = updateRoutine(c, "storefront", "a", { skip: null });
    expect(routinesOf(c)[0]?.skip).toBeUndefined();
    expect(() => updateRoutine(c, "storefront", "zz", { on: true })).toThrow("Unknown routine: zz");
    expect(routinesOf(removeRoutine(c, "storefront", "a"))).toEqual([]);
  });

  it("reads them back from the file, and a bad one is a config error", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ion-rt-")), "config.toml");
    writeFileSync(
      f,
      '[[projects]]\nid = "s"\npath = "/s"\n[[projects.routines]]\nid = "a"\nname = "A"\nwhen = "daily 09:00"\ntext = "t"\non = true\n',
    );
    expect(loadUserConfig(f).config.projects[0]?.routines?.[0]?.when).toBe("daily 09:00");
    writeFileSync(
      f,
      '[[projects]]\nid = "s"\npath = "/s"\n[[projects.routines]]\nid = "a"\nname = "A"\nwhen = "soon"\ntext = "t"\non = true\n',
    );
    expect(loadUserConfig(f).error).toMatch(/projects\.0\.routines\.0\.when/);
  });

  it("keeps pause all", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ion-rt-")), "config.toml");
    writeFileSync(f, "[routines]\npaused = true\n");
    expect(loadUserConfig(f).config.routines?.paused).toBe(true);
    expect(DEFAULT_CONFIG.routines).toBeUndefined();
  });
});
