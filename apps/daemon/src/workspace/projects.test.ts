import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@ion/config";
import { describe, expect, it } from "vitest";
import { git } from "./git.js";
import { addFolder, createProject, ensureDefaultProject } from "./projects.js";

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

// Plan 21 audit, 2026-11-23: `ion projects add ~/tip-calc` said "Not a git repository" and stopped, though `git init`
// was all it needed; the app couldn't add a folder at all. A folder that isn't a git repo now gets ion's git setup: a
// new repo with your files in its first commit (a chat's worktree starts from it), and ion says so.
describe("addFolder", () => {
  const plain = () => {
    const p = join(mkdtempSync(join(tmpdir(), "ion-plain-")), "tip-calc");
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "README.md"), "tip calculator\n");
    writeFileSync(join(p, "src", "tip.js"), "export const tip = (x) => x * 0.2;\n");
    return p;
  };

  it("picking a non-git folder sets up git and says so", async () => {
    const path = plain();
    const { config, gitSetUp } = await addFolder(withRoot(), path);
    expect(gitSetUp).toBe(true);
    expect(config.projects).toEqual([{ id: "tip-calc", path, starred: false }]);
    const files = (await git(["ls-tree", "-r", "--name-only", "HEAD"], path)).stdout.trim().split("\n");
    expect(files.sort()).toEqual(["README.md", "src/tip.js"]);
  });

  it("adds a git repo as it is", async () => {
    const path = plain();
    await git(["init", "-q", "-b", "main"], path);
    const { gitSetUp } = await addFolder(withRoot(), path);
    expect(gitSetUp).toBe(false);
    expect((await git(["rev-parse", "--verify", "HEAD"], path)).code).not.toBe(0);
  });

  // Plan 21 Review Focus 4: a home-folder-sized folder works or says plainly why not; it never hangs.
  it("refuses your home folder and one too big to set up, touching nothing", async () => {
    await expect(addFolder(withRoot(), homedir())).rejects.toThrow(
      "Pick a project folder, not your home folder",
    );
    const path = plain();
    await expect(addFolder(withRoot(), path, { maxFiles: 1 })).rejects.toThrow(
      "Too many files to set up git here (over 1). Pick a project folder, or run git init in it yourself",
    );
    expect(existsSync(join(path, ".git"))).toBe(false);
    await expect(addFolder(withRoot(), join(path, "nope"))).rejects.toThrow(
      `No folder at ${join(path, "nope")}`,
    );
  });
});
