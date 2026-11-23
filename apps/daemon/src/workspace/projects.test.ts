import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "@ion/config";
import { describe, expect, it } from "vitest";
import { git } from "./git.js";
import { addFolder, type FolderOpts } from "./folder.js";
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

// Plan 21 audit, 2026-11-23: `ion projects add ~/tip-calc` said "Not a git repository" and stopped, though `git init`
// was all it needed; the app couldn't add a folder at all. A folder that isn't a git repo gets ion's git setup.
// Review of Plan 21 Task 2, 2026-11-23 (and a security scan, HIGH): only after you confirm, never for your home or
// a secrets folder, never committing secrets, big files or build output, and leaving nothing behind when it fails.
describe("addFolder", () => {
  const root = () => mkdtempSync(join(tmpdir(), "ion-add-"));
  const plain = (at = root()) => {
    const p = join(at, "tip-calc");
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "README.md"), "tip calculator\n");
    writeFileSync(join(p, "src", "tip.js"), "export const tip = (x) => x * 0.2;\n");
    return p;
  };
  const opts = (o: Partial<FolderOpts> = {}): FolderOpts => ({ home: root(), ionDirs: [], ...o });
  const committed = async (p: string) =>
    (await git(["ls-tree", "-r", "--name-only", "HEAD"], p)).stdout.trim().split("\n").sort();

  it("asks first, and writes nothing until you confirm", async () => {
    const path = plain();
    expect(await addFolder(withRoot(), path, opts())).toEqual({
      ask: "Set up git here? ion makes a first commit of 2 files",
    });
    expect(existsSync(join(path, ".git"))).toBe(false);
  });

  it("picking a non-git folder sets up git and says so, leaving secrets, big files and build output out", async () => {
    const path = plain();
    writeFileSync(join(path, ".env"), "TOKEN=secret\n");
    writeFileSync(join(path, "server.pem"), "key\n");
    writeFileSync(join(path, "big.bin"), Buffer.alloc(4096));
    mkdirSync(join(path, "node_modules", "x"), { recursive: true });
    writeFileSync(join(path, "node_modules", "x", "i.js"), "1\n");
    const r = await addFolder(withRoot(), path, opts({ confirm: true, maxBytes: 1024 }));
    expect(r).toMatchObject({ gitSetUp: { files: 2, left: 4 } });
    expect(await committed(path)).toEqual(["README.md", "src/tip.js"]);
    expect(readFileSync(join(path, ".git", "info", "exclude"), "utf8")).toContain(".env*");
    // Your files are as they were, and git's own status ignores what was left out.
    expect(readFileSync(join(path, ".env"), "utf8")).toBe("TOKEN=secret\n");
    expect((await git(["status", "--porcelain"], path)).stdout.trim()).toBe("");
  });

  // Security scan of 2e7edd6, 2026-11-23: the walk left out .ENV and SECRET.PEM (any case), but `git add -A` went by
  // .git/info/exclude, case-sensitive, and committed them; a file name with a newline could add an exclude line. ion
  // commits exactly the files its walk listed, by literal path.
  it("commits exactly the files it listed: secrets in any case and odd names stay out", async () => {
    const path = plain();
    writeFileSync(join(path, "SECRET.PEM"), "key\n");
    writeFileSync(join(path, ".ENV"), "TOKEN=x\n");
    writeFileSync(join(path, "a\n!*.pem"), "x\n");
    writeFileSync(join(path, "notes*.md"), "glob-like but literal\n");
    const r = await addFolder(withRoot(), path, opts({ confirm: true }));
    expect(await committed(path)).toEqual(["README.md", "notes*.md", "src/tip.js"]);
    expect(r).toMatchObject({ gitSetUp: { files: 3, left: 3 } });
    expect(readFileSync(join(path, ".git", "info", "exclude"), "utf8")).not.toContain("!*.pem");
  });

  it("leaves out what your own .gitignore ignores, and counts it", async () => {
    const path = plain();
    writeFileSync(join(path, ".gitignore"), "*.log\n");
    writeFileSync(join(path, "debug.log"), "x\n");
    const r = await addFolder(withRoot(), path, opts({ confirm: true }));
    expect(await committed(path)).toEqual([".gitignore", "README.md", "src/tip.js"]);
    expect(r).toMatchObject({ gitSetUp: { files: 3, left: 1 } });
  });

  it("adds a git repo as it is", async () => {
    const path = plain();
    await git(["init", "-q", "-b", "main"], path);
    await git(
      ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"],
      path,
    );
    const r = await addFolder(withRoot(), path, opts());
    expect(r).toMatchObject({ config: { projects: [{ id: "tip-calc", path: realpathSync.native(path) }] } });
    expect(r).not.toHaveProperty("gitSetUp");
  });

  it("a folder inside a repo offers the repo, never a nested one", async () => {
    const top = plain();
    await git(["init", "-q", "-b", "main"], top);
    await git(
      ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"],
      top,
    );
    const real = realpathSync.native(top);
    expect(await addFolder(withRoot(), join(top, "src"), opts())).toEqual({
      ask: `This folder is in the git repo at ${real}. Add that repo?`,
    });
    const r = await addFolder(withRoot(), join(top, "src"), opts({ confirm: true }));
    expect(r).toMatchObject({ config: { projects: [{ path: real }] } });
    expect(existsSync(join(top, "src", ".git"))).toBe(false);
  });

  it("a repo with no commits gets its first commit, and keeps its .git", async () => {
    const path = plain();
    await git(["init", "-q", "-b", "main"], path);
    expect(await addFolder(withRoot(), path, opts())).toEqual({
      ask: "Set up git here? ion makes a first commit of 2 files",
    });
    expect(await addFolder(withRoot(), path, opts({ confirm: true }))).toMatchObject({
      gitSetUp: { files: 2 },
    });
  });

  it("a setup that fails removes the .git it made, and only that", async () => {
    const path = plain();
    writeFileSync(join(path, "locked.txt"), "x\n");
    chmodSync(join(path, "locked.txt"), 0o000);
    try {
      await expect(addFolder(withRoot(), path, opts({ confirm: true }))).rejects.toThrow(
        "Couldn't set up git here",
      );
      expect(existsSync(join(path, ".git"))).toBe(false);
    } finally {
      chmodSync(join(path, "locked.txt"), 0o644);
    }
  });

  it("a folder it can't read says so plainly", async () => {
    const path = plain();
    chmodSync(join(path, "src"), 0o000);
    try {
      await expect(addFolder(withRoot(), path, opts())).rejects.toThrow(
        `ion can't read ${join(realpathSync.native(path), "src")}`,
      );
    } finally {
      chmodSync(join(path, "src"), 0o755);
    }
  });

  // Plan 21 Review Focus 4 and the security scan: home, above it, its hidden folders, secrets folders anywhere,
  // system folders and ion's own, by their real paths (a link or other letter case doesn't get past).
  it("refuses your home, above it, hidden and secrets folders, system folders and ion's own, touching nothing", async () => {
    const home = realpathSync.native(root());
    for (const d of [".cache", ".ssh/keys", "Library/x", "work/.aws"])
      mkdirSync(join(home, d), { recursive: true });
    const o = opts({ home, ionDirs: [join(home, "work")] });
    const refused = (p: string) =>
      expect(addFolder(withRoot(), p, o)).rejects.toThrow(/^Pick a project folder/);
    await refused(home);
    await refused(dirname(home));
    await refused(join(home, ".cache"));
    await refused(join(home, ".ssh", "keys"));
    await refused(join(home, "Library", "x"));
    await refused(join(home, "work"));
    await refused("/etc");
    await refused("/");
    const link = join(root(), "link");
    symlinkSync(home, link);
    await refused(link);
    if (process.platform === "darwin") await refused(home.toUpperCase());
    for (const d of ["", ".cache", "Library/x"]) expect(existsSync(join(home, d, ".git"))).toBe(false);
  });

  // Re-review of 2e7edd6, 2026-11-23: iCloud Drive's sync can damage a .git, so it stays refused, saying why; only
  // ~/Library (and /Library) is refused, not any folder named Library; hidden folders of home at any depth; ion's
  // folders and any folder holding one; a project already added under a link is found.
  it("refuses iCloud Drive saying why, and Library only where it's ~/Library", async () => {
    const home = realpathSync.native(root());
    const cloud = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
    const p = plain(cloud);
    const o = opts({ home, confirm: true });
    await expect(addFolder(withRoot(), p, o)).rejects.toThrow(
      "iCloud Drive can damage a git repo; move the project out of iCloud Drive first",
    );
    mkdirSync(join(home, "Library", "Mail"), { recursive: true });
    await expect(addFolder(withRoot(), join(home, "Library", "Mail"), o)).rejects.toThrow(
      /^Pick a project folder/,
    );
    const code = plain(join(home, "code", "Library"));
    expect(await addFolder(withRoot(), code, o)).toMatchObject({ gitSetUp: { files: 2 } });
  });

  it("refuses anything under a hidden folder of home, at any depth", async () => {
    const home = realpathSync.native(root());
    for (const d of [".cache/foo", ".kube/x"]) {
      const p = plain(join(home, d));
      await expect(addFolder(withRoot(), p, opts({ home }))).rejects.toThrow(/^Pick a project folder/);
    }
  });

  it("refuses ion's folders and any folder that holds one", async () => {
    const ionHome = join(realpathSync.native(root()), "a", "ion-home");
    mkdirSync(join(ionHome, "data"), { recursive: true });
    const inside = plain(ionHome);
    const o = opts({ ionDirs: [join(ionHome, "data"), ionHome] });
    for (const p of [inside, ionHome, dirname(ionHome), join(ionHome, "data")])
      await expect(addFolder(withRoot(), p, o)).rejects.toThrow(/^Pick a project folder/);
  });

  it("finds a project already added under a link", async () => {
    const path = plain();
    const link = join(root(), "link");
    symlinkSync(path, link);
    const c = { ...withRoot(), projects: [{ id: "tip-calc", path: link, starred: false }] };
    await expect(addFolder(c, path, opts({ confirm: true }))).rejects.toThrow("Already added: tip-calc");
  });

  it("refuses a folder too big to set up, touching nothing", async () => {
    const path = plain();
    await expect(addFolder(withRoot(), path, opts({ maxFiles: 1 }))).rejects.toThrow(
      "Too many files to set up git here (over 1). Pick a project folder, or run git init in it yourself",
    );
    expect(existsSync(join(path, ".git"))).toBe(false);
    await expect(addFolder(withRoot(), join(path, "nope"), opts())).rejects.toThrow(
      `No folder at ${join(path, "nope")}`,
    );
  });
});
