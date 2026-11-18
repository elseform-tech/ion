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

  it("refuses bad names and names already taken", async () => {
    const c = withRoot();
    await expect(createProject(c, "My App")).rejects.toThrow("Use lowercase letters, numbers, - . _");
    const { config } = await createProject(c, "app");
    await expect(createProject(config, "app")).rejects.toThrow("A project named app already exists");
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
