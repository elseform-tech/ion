import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { callBox } from "./git.js";
import { chatDiff, createWorktree, removeWorktree, sandboxGit } from "./index.js";
import { stillOurs } from "./worktrees.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let dataDir: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ion-wt-repo-"));
  dataDir = mkdtempSync(join(tmpdir(), "ion-wt-data-"));
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "init");
});

describe("worktrees", () => {
  it("creates one worktree per chat on its own ion/ branch", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_abc", "Fix checkout rounding!");
    expect(wt.path).toBe(join(realpathSync(dataDir), "worktrees", "chat_abc"));
    expect(wt.branch).toMatch(/^ion\/fix-checkout-rounding-[0-9a-f]{6}$/);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(sh(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
  });

  it("returns the same worktree for the same chat", async () => {
    const a = await createWorktree(repo, dataDir, "chat_abc", "One");
    const b = await createWorktree(repo, dataDir, "chat_abc", "One");
    expect(b).toEqual(a);
  });

  it("recreates a worktree folder deleted by hand, on the same branch", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_abc", "One");
    rmSync(wt.path, { recursive: true, force: true });
    const again = await createWorktree(repo, dataDir, "chat_abc", "One");
    expect(again).toEqual(wt);
    expect(existsSync(join(again.path, "README.md"))).toBe(true);
  });

  it("removes the worktree but keeps its branch", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_abc", "One");
    await removeWorktree(repo, wt.path);
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(repo, "branch", "--list", wt.branch)).toContain(wt.branch);
  });

  it("refuses a folder that isn't a git repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "ion-wt-plain-"));
    await expect(createWorktree(plain, dataDir, "chat_x", "x")).rejects.toThrow("Not a git repository");
  });

  // Regression (security review): a repo's git hooks must never run when ion creates a worktree.
  it("never runs the repo's git hooks", async () => {
    const marker = join(dataDir, "hook-ran");
    writeFileSync(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(repo, ".git", "hooks", "post-checkout"), 0o755);
    await createWorktree(repo, dataDir, "chat_hook", "Hooks");
    expect(existsSync(marker)).toBe(false);
  });

  // Regression (security review): repo config like core.fsmonitor must not run code in ion's git calls.
  it("never runs core.fsmonitor from the repo's config", async () => {
    const marker = join(dataDir, "fsmonitor-ran");
    const script = join(dataDir, "fsmon.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(script, 0o755);
    const wt = await createWorktree(repo, dataDir, "chat_fs", "Fs");
    execFileSync("git", ["config", "core.fsmonitor", script], { cwd: repo });
    await createWorktree(repo, dataDir, "chat_fs", "Fs");
    await removeWorktree(repo, wt.path);
    expect(existsSync(marker)).toBe(false);
  });

  // Security review, 2026-11-28 (hooks fix, M3): a chat's agent or hook can point its worktree's .git at a git folder
  // it made, with core.fsmonitor, core.hooksPath and a clean filter set there; ion's own git (its diff of the chat)
  // must run none of them.
  it("runs nothing from a git folder a chat planted in its worktree", async () => {
    const marker = join(dataDir, "planted-ran");
    const script = join(dataDir, "planted.sh");
    writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${marker}\ncat\n`);
    chmodSync(script, 0o755);
    const wt = await createWorktree(repo, dataDir, "chat_planted", "Planted");
    const planted = join(mkdtempSync(join(tmpdir(), "ion-wt-planted-")), "p");
    sh(repo, "clone", "-q", repo, planted);
    const hooks = join(planted, "hooks");
    mkdirSync(hooks);
    for (const h of ["post-index-change", "reference-transaction", "pre-auto-gc"]) {
      writeFileSync(join(hooks, h), `#!/bin/sh\necho "hook ${h}" >> ${marker}\n`);
      chmodSync(join(hooks, h), 0o755);
    }
    sh(planted, "config", "core.fsmonitor", script);
    sh(planted, "config", "core.hooksPath", hooks);
    sh(planted, "config", "filter.x.clean", script);
    sh(planted, "config", "diff.external", script);
    writeFileSync(join(wt.path, ".git"), `gitdir: ${join(planted, ".git")}\n`);
    writeFileSync(join(wt.path, ".gitattributes"), "* filter=x\n");
    writeFileSync(join(wt.path, "README.md"), "# changed\n");
    // Automated scan, 2026-11-28: ion read through whatever the .git file named. A worktree whose .git points
    // elsewhere is refused, in plain words.
    await expect(chatDiff(repo, wt.path)).rejects.toThrow("The chat's worktree isn't as ion made it");
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });

  it("a worktree whose .git points elsewhere, or is a link, is refused", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_moved", "Moved");
    const other = await createWorktree(repo, dataDir, "chat_other", "Other");
    const otherDotGit = readFileSync(join(other.path, ".git"), "utf8");
    writeFileSync(join(wt.path, ".git"), otherDotGit);
    await expect(chatDiff(repo, wt.path)).rejects.toThrow("The chat's worktree isn't as ion made it");
    rmSync(join(wt.path, ".git"));
    symlinkSync(join(other.path, ".git"), join(wt.path, ".git"));
    await expect(chatDiff(repo, wt.path)).rejects.toThrow("The chat's worktree isn't as ion made it");
    expect((await chatDiff(repo, other.path)).files).toEqual([]);
    // CodeQL, 2026-11-28 (js/file-system-race): the .git is read through the one descriptor it was checked on; a
    // folder there is refused too.
    rmSync(join(wt.path, ".git"));
    mkdirSync(join(wt.path, ".git"));
    await expect(chatDiff(repo, wt.path)).rejects.toThrow("The chat's worktree isn't as ion made it");
  });

  // Automated scan, 2026-11-28: attributes ion's diff reads can name a filter that runs code (the worktree's
  // .gitattributes, or a core.attributesFile in the repo's config).
  it("ion's read commands ignore the worktree's attributes", async () => {
    const marker = join(dataDir, "filter-ran");
    const script = join(dataDir, "filter.sh");
    writeFileSync(script, `#!/bin/sh\necho ran >> ${marker}\ncat\n`);
    chmodSync(script, 0o755);
    const wt = await createWorktree(repo, dataDir, "chat_attrs", "Attrs");
    sh(repo, "config", "filter.x.clean", script);
    const attrs = join(dataDir, "attributes");
    writeFileSync(attrs, "* filter=x\n");
    sh(repo, "config", "core.attributesFile", attrs);
    writeFileSync(join(wt.path, ".gitattributes"), "* filter=x\n");
    writeFileSync(join(wt.path, "README.md"), "# changed\n");
    writeFileSync(join(wt.path, "new.txt"), "new\n");
    const d = await chatDiff(repo, wt.path);
    expect(d.files.map((f) => f.path)).toEqual([".gitattributes", "README.md", "new.txt"]);
    expect(existsSync(marker)).toBe(false);
  });

  // Security re-review, 2026-11-28 (N2): a chat's agent swapped its worktree root for a link to another chat's worktree,
  // and its next run took the folder as it was (its .git was there, through the link) and wrote in the other chat.
  it("refuses a worktree root replaced by a link to another chat's worktree", async () => {
    const one = await createWorktree(repo, dataDir, "chat_one", "One");
    const two = await createWorktree(repo, dataDir, "chat_two", "Two");
    rmSync(one.path, { recursive: true, force: true });
    symlinkSync(two.path, one.path);
    await expect(createWorktree(repo, dataDir, "chat_one", "One")).rejects.toThrow(
      "The chat's worktree isn't as ion made it",
    );
  });

  it("gives the worktree by its real path", async () => {
    const via = join(mkdtempSync(join(tmpdir(), "ion-wt-via-")), "data");
    symlinkSync(dataDir, via);
    const wt = await createWorktree(repo, via, "chat_real", "Real");
    expect(wt.path).toBe(join(realpathSync(dataDir), "worktrees", "chat_real"));
    expect((await createWorktree(repo, via, "chat_real", "Real")).path).toBe(wt.path);
  });

  // Security re-review, 2026-11-28 (N3): a filter named in the project's .git/info/attributes (or the system's
  // gitattributes) still ran in ion's diff; GIT_ATTR_SOURCE and core.attributesFile don't cover those.
  it("runs no filter named in the project's info/attributes", async () => {
    const marker = join(dataDir, "info-filter-ran");
    const script = join(dataDir, "info-filter.sh");
    writeFileSync(script, `#!/bin/sh\necho ran >> ${marker}\ncat\n`);
    chmodSync(script, 0o755);
    const wt = await createWorktree(repo, dataDir, "chat_info", "Info");
    writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=evil.one\n");
    sh(repo, "config", "filter.evil.one.clean", script);
    sh(repo, "config", "filter.evil.one.process", script);
    writeFileSync(join(wt.path, "README.md"), "# changed\n");
    const d = await chatDiff(repo, wt.path);
    expect(d.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "reads a chat's changes in a sandbox where nothing is written",
    async () => {
      const real = realpathSync(dataDir);
      sandboxGit({
        kind: "seatbelt",
        dataDir: real,
        paths: { deny: [real], read: [], write: [join(real, "worktrees")], noWrite: [] },
      });
      try {
        const wt = await createWorktree(repo, dataDir, "chat_ro", "Ro");
        writeFileSync(join(wt.path, "README.md"), "# changed\n");
        writeFileSync(join(wt.path, "new.txt"), "new\n");
        const d = await chatDiff(repo, wt.path);
        expect(d.files.map((f) => [f.path, f.added, f.removed])).toEqual([
          ["README.md", 1, 1],
          ["new.txt", 1, 0],
        ]);
      } finally {
        sandboxGit(undefined);
      }
    },
  );

  // Automated scan, 2026-11-28 (trusted.ts): the worktree's git folder could name another common folder (its
  // `commondir`) or bring its own config (`config.worktree`), and ion's reads followed them.
  it("refuses a worktree whose git folder names another common folder or brings its own config", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_common", "Common");
    const gitDir = sh(wt.path, "rev-parse", "--absolute-git-dir");
    const other = mkdtempSync(join(tmpdir(), "ion-wt-other-"));
    sh(other, "init", "-q");
    writeFileSync(join(gitDir, "commondir"), `${join(other, ".git")}\n`);
    await expect(chatDiff(repo, wt.path)).rejects.toThrow("The chat's worktree isn't as ion made it");
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    expect((await chatDiff(repo, wt.path)).files).toEqual([]);
    writeFileSync(join(gitDir, "config.worktree"), "[core]\n\tfsmonitor = true\n");
    await expect(chatDiff(repo, wt.path)).rejects.toThrow("The chat's worktree isn't as ion made it");
  });

  // Security re-review, 2026-11-28 (N4): git 2.48+ can write a worktree's links as relative paths
  // (worktree.useRelativePaths); ion resolved the git folder's back-reference against its own folder and refused.
  it("reads a worktree whose links are relative", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_rel", "Rel");
    const gitDir = sh(wt.path, "rev-parse", "--absolute-git-dir");
    writeFileSync(join(gitDir, "gitdir"), `${relative(gitDir, join(wt.path, ".git"))}\n`);
    writeFileSync(join(wt.path, ".git"), `gitdir: ${relative(wt.path, gitDir)}\n`);
    writeFileSync(join(wt.path, "README.md"), "# changed\n");
    expect((await chatDiff(repo, wt.path)).files.map((f) => f.path)).toEqual(["README.md"]);
  });

  // Automated scan, 2026-11-28 (worktrees.ts): an existing worktree was taken on its .git being there, and its HEAD
  // read with plain git in it; and ion's worktrees folder itself could be a link.
  it("refuses an existing worktree whose .git points elsewhere, without running its git", async () => {
    const marker = join(dataDir, "existing-ran");
    const script = join(dataDir, "existing.sh");
    writeFileSync(script, `#!/bin/sh\necho ran >> ${marker}\n`);
    chmodSync(script, 0o755);
    const wt = await createWorktree(repo, dataDir, "chat_exist", "Exist");
    const planted = join(mkdtempSync(join(tmpdir(), "ion-wt-planted-")), "p");
    sh(repo, "clone", "-q", repo, planted);
    sh(planted, "config", "core.fsmonitor", script);
    sh(planted, "config", "core.pager", script);
    writeFileSync(join(wt.path, ".git"), `gitdir: ${join(planted, ".git")}\n`);
    await expect(createWorktree(repo, dataDir, "chat_exist", "Exist")).rejects.toThrow(
      "The chat's worktree isn't as ion made it",
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses ion's worktrees folder when it is a link", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "ion-wt-elsewhere-"));
    symlinkSync(elsewhere, join(dataDir, "worktrees"));
    await expect(createWorktree(repo, dataDir, "chat_x", "X")).rejects.toThrow(
      "The chat's worktree isn't as ion made it",
    );
  });

  // Security re-review 2, 2026-11-28 (R2-1): `git worktree add` ran a smudge filter planted in the project's .git, in
  // a sandbox that could write every chat's worktree.
  it("runs no filter from the project's git when it makes a worktree", async () => {
    const marker = join(dataDir, "smudge-ran");
    const script = join(dataDir, "smudge.sh");
    writeFileSync(script, `#!/bin/sh\necho ran >> ${marker}\ncat\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=evil\n");
    sh(repo, "config", "filter.evil.smudge", script);
    sh(repo, "config", "filter.evil.process", script);
    const wt = await createWorktree(repo, dataDir, "chat_smudge", "Smudge");
    expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("# repo\n");
    expect(sh(wt.path, "-c", "filter.evil.process=", "-c", "filter.evil.smudge=", "ls-files")).toBe(
      "README.md",
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("gives each git call that writes only its one worktree, and none for the project's", () => {
    const real = realpathSync(dataDir);
    const box = {
      kind: "seatbelt" as const,
      dataDir: real,
      paths: { deny: [real], read: [], write: [join(real, "worktrees")], noWrite: [] },
    };
    expect(callBox(box, { writes: join(real, "worktrees", "c1") })?.paths.write).toEqual([
      join(real, "worktrees", "c1"),
    ]);
    expect(callBox(box, {})?.paths.write).toEqual([]);
    expect(callBox(box, { readOnly: join(real, "worktrees", "c1") })?.paths).toMatchObject({
      write: [],
      readOnly: true,
    });
  });

  // Security re-review 2, 2026-11-28 (R2-2): a root swapped for a link after createWorktree checked it went to the
  // agent's own sandbox (Codex's) at launch. It's checked again there.
  it("checks a worktree again at launch", async () => {
    const one = await createWorktree(repo, dataDir, "chat_l1", "L1");
    const two = await createWorktree(repo, dataDir, "chat_l2", "L2");
    expect(() => stillOurs(dataDir, "chat_l1", one.path)).not.toThrow();
    rmSync(one.path, { recursive: true, force: true });
    symlinkSync(two.path, one.path);
    expect(() => stillOurs(dataDir, "chat_l1", one.path)).toThrow("The chat's worktree isn't as ion made it");
    expect(() => stillOurs(dataDir, "chat_l1", two.path)).toThrow("The chat's worktree isn't as ion made it");
  });

  // Full check, 2026-11-28 (server.test "removes a project"): with each git call writing only its own worktree,
  // `git worktree prune` in the project couldn't see the other chats' worktrees and forgot them all, so archiving a
  // chat failed ("is not a working tree").
  it.runIf(process.platform === "darwin")(
    "keeps every chat's worktree registered when another is made or removed",
    async () => {
      const real = realpathSync(dataDir);
      sandboxGit({
        kind: "seatbelt",
        dataDir: real,
        paths: { deny: [real], read: [], write: [join(real, "worktrees")], noWrite: [] },
      });
      try {
        const one = await createWorktree(repo, dataDir, "chat_k1", "K1");
        const two = await createWorktree(repo, dataDir, "chat_k2", "K2");
        const three = await createWorktree(repo, dataDir, "chat_k3", "K3");
        await removeWorktree(repo, two.path);
        const list = sh(repo, "worktree", "list", "--porcelain");
        expect(list).toContain(one.path);
        expect(list).toContain(three.path);
        await removeWorktree(repo, one.path);
        expect(existsSync(one.path)).toBe(false);
      } finally {
        sandboxGit(undefined);
      }
    },
  );

  // Security re-review 3, 2026-11-28 (R3-1): a project with submodule.recurse=true made ion's checkout of a new
  // worktree recurse into submodules (their own git config, filters and all); here it failed outright.
  it("makes a worktree in a project that recurses into submodules, without recursing", async () => {
    const inner = mkdtempSync(join(tmpdir(), "ion-wt-inner-"));
    sh(inner, "init", "-q", "-b", "main");
    writeFileSync(join(inner, "f"), "x\n");
    sh(inner, "add", ".");
    sh(inner, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "i");
    sh(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub");
    sh(repo, "commit", "-q", "-m", "sub");
    sh(repo, "config", "submodule.recurse", "true");
    const wt = await createWorktree(repo, dataDir, "chat_sub", "Sub");
    expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("# repo\n");
  });

  it("reports the branch actually checked out, even if the title changed", async () => {
    const first = await createWorktree(repo, dataDir, "chat_abc", "One");
    const again = await createWorktree(repo, dataDir, "chat_abc", "A different title");
    expect(again.branch).toBe(first.branch);
  });

  it("says so when removing a worktree fails, and is fine with one that's already gone", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_abc", "One");
    await removeWorktree(repo, wt.path);
    await expect(removeWorktree(repo, wt.path)).resolves.toBeUndefined();
    const plain = mkdtempSync(join(tmpdir(), "ion-wt-notwt-"));
    writeFileSync(join(plain, "keep.txt"), "x");
    await expect(removeWorktree(repo, plain)).rejects.toThrow("Couldn't remove the chat's worktree");
  });
});
