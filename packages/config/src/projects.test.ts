import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addProject,
  DEFAULT_CONFIG,
  DEFAULT_PROJECT,
  projectNameError,
  removeProject,
  renameProject,
} from "./index.js";

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
  it("has the judge only: no default and no per-project access", () => {
    // No judge set by default: the first ready agent in your order, at its quick model (Plan 21 audit, 2026-11-23).
    expect(DEFAULT_CONFIG.access).toEqual({});
  });
});

describe("projects by name", () => {
  it("accepts simple names only", () => {
    expect(projectNameError("My App")).toBe("Use lowercase letters, numbers, - . _");
    expect(projectNameError("../x")).toBe("Use lowercase letters, numbers, - . _");
    expect(projectNameError("app")).toBeNull();
    expect(projectNameError("default")).toBeNull();
  });
  it("keeps projects in a folder you can change; default ~/ion/projects", () => {
    expect(DEFAULT_CONFIG.folders.projects).toBe("~/ion/projects");
    expect(DEFAULT_PROJECT).toBe("default");
  });
});

// Final review I11: "chief" is ion chief's; no project takes it.
describe("reserved names", () => {
  it("never names a project chief", async () => {
    const { projectNameError } = await import("./projects.js");
    expect(projectNameError("chief")).toBe("That name is ion's own");
  });

  // Task review, 2026-11-22: a project called "you" shared your memory's scope (its files reached every chat).
  it("never names a project you", () => {
    expect(projectNameError("you")).toBe("That name is ion's own");
    expect(addProject(DEFAULT_CONFIG, repo("you")).projects[0]!.id).toBe("you-2");
  });

  // Plan 21 final review (2026-11-28, M5): a picked folder "My App (old)" became the id "My App (old)", which commands
  // and URLs can't take. Its id is a slug; its name stays the folder's.
  it("slugs a picked folder's id and keeps its name", () => {
    expect(addProject(DEFAULT_CONFIG, repo("My App (old)")).projects[0]).toMatchObject({
      id: "my-app-old",
      name: "My App (old)",
    });
    expect(addProject(DEFAULT_CONFIG, repo("api")).projects[0]).not.toHaveProperty("name");
    expect(addProject(DEFAULT_CONFIG, repo("…")).projects[0]!.id).toBe("project");
  });

  // Task review, 2026-11-22: ion's dream runs as "_dream", an id no project can have, so a project named dream works.
  it("names a project dream", () => {
    expect(projectNameError("dream")).toBeNull();
    expect(addProject(DEFAULT_CONFIG, repo("dream")).projects[0]!.id).toBe("dream");
  });
});

// The user, 2026-11-19: rename and remove projects. A rename is the name ion shows (its id stays: every event,
// decision and thread refers to it); removing takes it out of ion and never touches its folder.
describe("rename and remove", () => {
  const two = () => ({
    ...DEFAULT_CONFIG,
    projects: [
      { id: "shop", path: "/p/shop", starred: false },
      { id: "api", path: "/p/api", starred: false },
    ],
  });

  it("renames a project's shown name, keeping its id", () => {
    const c = renameProject(two(), "shop", "  Storefront  ");
    expect(c.projects[0]).toMatchObject({ id: "shop", name: "Storefront" });
    expect(renameProject(c, "shop", "shop").projects[0]!.name).toBeUndefined();
  });

  it("refuses an empty name, a taken one, default and an unknown project", () => {
    expect(() => renameProject(two(), "shop", "  ")).toThrow("Give the project a name");
    expect(() => renameProject(two(), "shop", "api")).toThrow("That name is taken");
    expect(() => renameProject(two(), DEFAULT_PROJECT, "x")).toThrow("default can't be renamed");
    expect(() => renameProject(two(), "nope", "x")).toThrow("Unknown project: nope");
  });

  it("removes a project from ion, but never default", () => {
    expect(removeProject(two(), "shop").projects.map((p) => p.id)).toEqual(["api"]);
    expect(() => removeProject(two(), DEFAULT_PROJECT)).toThrow("default can't be removed");
    expect(() => removeProject(two(), "nope")).toThrow("Unknown project: nope");
  });
});
