import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { listArtifacts } from "./artifacts.js";

const worktree = () => realpathSync(mkdtempSync(join(tmpdir(), "ion-art-")));

function put(root: string, rel: string, body: string, at: Date): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  utimesSync(file, at, at);
}

// The user, 2026-11-19: "the workspace preview should also list artifacts and running processes".
describe("listArtifacts", () => {
  const since = "2026-11-19T10:00:00.000Z";
  const at = (min: number) => new Date(Date.parse(since) + min * 60_000);

  it("lists files the chat made, ignored outputs too, newest first", async () => {
    const dir = worktree();
    put(dir, "old.txt", "old", at(-30));
    put(dir, "notes.md", "hi", at(5));
    put(dir, "dist/app.js", "x", at(9));
    put(dir, "shot.png", "png", at(7));
    put(dir, "page.html", "<p/>", at(8));
    put(dir, "blob.bin", "\0\0", at(6));
    writeFileSync(join(dir, ".gitignore"), "dist\n");
    utimesSync(join(dir, ".gitignore"), at(-60), at(-60));
    const list = await listArtifacts(dir, since);
    expect(list.map((a) => [a.path, a.kind])).toEqual([
      ["dist/app.js", "text"],
      ["page.html", "html"],
      ["shot.png", "image"],
      ["blob.bin", "binary"],
      ["notes.md", "text"],
    ]);
    expect(list[0]).toMatchObject({ size: 1, changedAt: at(9).toISOString() });
  });

  it("skips .git, node_modules and links out of the worktree", async () => {
    const dir = worktree();
    const outside = worktree();
    put(outside, "secret.txt", "s", at(5));
    put(dir, ".git/HEAD", "x", at(5));
    put(dir, "node_modules/a/index.js", "x", at(5));
    put(dir, "pkg/node_modules/b.js", "x", at(5));
    put(dir, "keep.txt", "k", at(5));
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    symlinkSync(outside, join(dir, "linkdir"));
    const list = await listArtifacts(dir, since);
    expect(list.map((a) => a.path)).toEqual(["keep.txt"]);
  });

  it("stops at 200", async () => {
    const dir = worktree();
    for (let i = 0; i < 230; i++) put(dir, `f${i}.txt`, "x", at(i));
    const list = await listArtifacts(dir, since);
    expect(list).toHaveLength(200);
    expect(list[0]?.path).toBe("f229.txt");
  });

  // Task review, 2026-11-19: in an ion worktree `.git` is a file (a gitdir pointer), and it was listed.
  it("skips a .git file", async () => {
    const dir = worktree();
    put(dir, ".git", "gitdir: /x", at(1));
    put(dir, "a.txt", "a", at(2));
    expect((await listArtifacts(dir, since)).map((a) => a.path)).toEqual(["a.txt"]);
  });

  // Task review, 2026-11-19: a huge deep folder could use the whole budget before shallow files were seen.
  it("walks wide first, so a big deep folder can't hide top-level files", async () => {
    const dir = worktree();
    for (const top of ["a", "b"]) {
      for (let i = 0; i < 20; i++) put(dir, `${top}/deep/f${i}.txt`, "x", at(1));
      put(dir, `${top}/shallow.txt`, "t", at(1));
    }
    const list = await listArtifacts(dir, since, 6);
    expect(list.map((a) => a.path)).toEqual(expect.arrayContaining(["a/shallow.txt", "b/shallow.txt"]));
  });

  // Task review, 2026-11-19: an invalid `since` listed everything (NaN compares false).
  it("lists nothing for an invalid since", async () => {
    const dir = worktree();
    put(dir, "a.txt", "a", at(1));
    expect(await listArtifacts(dir, "not a date")).toEqual([]);
  });

  // Security review, 2026-11-19: a folder was read in full before the budget cut it; it's streamed now.
  it("visits at most the budget in one big folder", async () => {
    const dir = worktree();
    for (let i = 0; i < 40; i++) put(dir, `big/f${i}.txt`, "x", at(1));
    expect((await listArtifacts(dir, since, 10)).length).toBeLessThanOrEqual(9);
  });
});
