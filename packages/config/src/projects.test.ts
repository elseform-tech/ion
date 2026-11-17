import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addProject, DEFAULT_CONFIG, setProjectAccess } from "./index.js";

const repo = (name: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "ion-proj-")), name);
  mkdirSync(join(p, ".git"), { recursive: true });
  return p;
};

describe("addProject", () => {
  it("adds a git repo with the folder name as id", () => {
    const p = repo("storefront");
    expect(addProject(DEFAULT_CONFIG, p).projects).toEqual([{ id: "storefront", path: p, starred: false }]);
  });
  it("rejects a folder that isn't a git repo", () => {
    const p = mkdtempSync(join(tmpdir(), "ion-plain-"));
    expect(() => addProject(DEFAULT_CONFIG, p)).toThrow(`Not a git repository: ${p}`);
  });
  it("rejects a missing path", () => {
    expect(() => addProject(DEFAULT_CONFIG, "/nope/nothing")).toThrow("Not a git repository: /nope/nothing");
  });
  it("rejects the same path twice", () => {
    const p = repo("api");
    const c = addProject(DEFAULT_CONFIG, p);
    expect(() => addProject(c, p)).toThrow("Already added: api");
  });
  it("suffixes ids on collision", () => {
    const c = addProject(addProject(DEFAULT_CONFIG, repo("api")), repo("api"));
    expect(c.projects.map((x) => x.id)).toEqual(["api", "api-2"]);
  });
  it("doesn't change the config it was given", () => {
    const c = structuredClone(DEFAULT_CONFIG);
    addProject(c, repo("web"));
    expect(c).toEqual(DEFAULT_CONFIG);
  });
});

describe("access", () => {
  it("defaults to Auto, and a project can have its own", () => {
    expect(DEFAULT_CONFIG.access.default).toBe("auto");
    const c = addProject(DEFAULT_CONFIG, repo("app"));
    expect(c.projects[0]!.access).toBeUndefined();
    expect(setProjectAccess(c, "app", "full").projects[0]!.access).toBe("full");
    expect(() => setProjectAccess(c, "nope", "full")).toThrow("Unknown project: nope");
  });
});
