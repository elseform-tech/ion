import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@ion/config";
import { describe, expect, it } from "vitest";
import { git } from "./git.js";
import { createProject, ensureDefaultProject } from "./projects.js";

const withRoot = () => {
  const root = join(mkdtempSync(join(tmpdir(), "ion-root-")), "projects");
  return { ...structuredClone(DEFAULT_CONFIG), folders: { projects: root } };
};

describe("createProject", () => {
  it("makes <root>/<name> as a git repo with one commit, and adds it", async () => {
    const c = withRoot();
    const { config, id } = await createProject(c, "app");
    const path = join(c.folders.projects, "app");
    expect(id).toBe("app");
    expect(config.projects).toEqual([{ id: "app", path, starred: false }]);
    expect((await git(["rev-parse", "HEAD"], path)).code).toBe(0);
  });

  it("adds an existing git repo untouched, and refuses a folder that isn't one", async () => {
    const c = withRoot();
    const path = join(c.folders.projects, "old");
    mkdirSync(path, { recursive: true });
    await git(["init", "-q", "-b", "main"], path);
    expect((await createProject(c, "old")).id).toBe("old");
    mkdirSync(join(c.folders.projects, "plain"));
    await expect(createProject(c, "plain")).rejects.toThrow(
      `Folder exists and isn't a git repo: ${join(c.folders.projects, "plain")}`,
    );
  });

  // The user, 2026-11-19: "create project is not working". "My App" and "Website" were refused (lowercase only),
  // and the app hid why. Any name works: ion makes its id (and folder) from it and shows the name as typed.
  it("takes any name: makes an id from it and keeps the name as you typed it", async () => {
    const c = withRoot();
    const made = await createProject(c, "  My App!  ");
    expect(made.id).toBe("my-app");
    expect(made.config.projects[0]).toMatchObject({ id: "my-app", name: "My App!" });
    expect((await createProject(made.config, "website")).config.projects[1]).not.toHaveProperty("name");
  });

  it("refuses an empty name, ion's own, and names already taken", async () => {
    const c = withRoot();
    await expect(createProject(c, " !! ")).rejects.toThrow("Give the project a name");
    await expect(createProject(c, "Chief")).rejects.toThrow("That name is ion's own");
    const { config } = await createProject(c, "app");
    await expect(createProject(config, "App")).rejects.toThrow("A project named app already exists");
  });
});

describe("ensureDefaultProject", () => {
  it("creates default once, kept from ion", async () => {
    const once = await ensureDefaultProject(withRoot());
    const twice = await ensureDefaultProject(once);
    expect(twice.projects).toHaveLength(1);
    expect(twice.projects[0]).toMatchObject({ id: "default", shareWithIon: false });
  });
});
