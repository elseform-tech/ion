import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EV } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserError } from "../api/errors.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { memoryView } from "../views/memory.js";
import { MemoryFiles } from "./index.js";

let dir: string;
let root: string;
let db: Db;
let store: EventStore;
let files: MemoryFiles;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ion-memory-"));
  root = join(dir, "memory");
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  files = new MemoryFiles({ root, store, db });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const likes = { name: "Short answers", description: "How I like replies", type: "preference" as const };
const memoryEvents = () => store.read({ types: [EV.memoryWritten, EV.memoryForgotten] });

describe("memory files", () => {
  // The user, 2026-11-21: "repurpose memory into multiple memory files": a YAML header, then the text.
  it("a file is parsed into its header and text", () => {
    mkdirSync(join(root, "projects", "shop"), { recursive: true });
    writeFileSync(
      join(root, "projects", "shop", "deploys.md"),
      [
        "---",
        "name: Deploys",
        'description: "How we ship: on Fridays"',
        "type: fact",
        "owner: me",
        "---",
        "",
        "Run `make ship`, then **check**.",
        "",
      ].join("\n"),
    );
    const r = files.read("projects/shop/deploys.md");
    expect(r).toMatchObject({
      ok: true,
      file: {
        path: "projects/shop/deploys.md",
        scope: { projectId: "shop" },
        slug: "deploys",
        // A project's files are for its chats unless they say otherwise; keys ion doesn't know are kept aside.
        header: { name: "Deploys", description: "How we ship: on Fridays", type: "fact", see: "chats" },
        extra: { owner: "me" },
        text: "Run `make ship`, then **check**.",
      },
    });
    // Written back by ion, the header round-trips, and the key it doesn't know stays in the file.
    const w = files.write({ scope: { projectId: "shop" }, slug: "deploys", ...edit(r), by: "you" });
    expect(readFileSync(join(root, "projects", "shop", "deploys.md"), "utf8")).toContain("owner: me");
    expect(files.read(w.path)).toMatchObject({ ok: true, file: { text: "Now on Mondays", hash: w.hash } });
  });

  // The user, 2026-11-21: a file that fails to parse keeps its last good indexed version, with one plain line.
  it("a broken header keeps the last good version and is reported", () => {
    const good = files.write({ scope: "you", header: likes, text: "Keep it short", by: "you" });
    expect(good).toMatchObject({ path: "you/short-answers.md", header: { see: "chats" } });
    const broken = [
      "no header at all",
      "---\nname: [a, b]\ndescription: x\n---\ntext",
      "---\nname: &a Short\ndescription: *a\n---\ntext",
      "---\nname: !!str Short\ndescription: x\n---\ntext",
      "---\n<<: {name: x}\ndescription: x\n---\ntext",
      "---\ndescription: no name\n---\ntext",
      "---\nname: x\ndescription: y\ntype: secret\n---\ntext",
      "---\nname: x\ndescription: y\n",
    ];
    for (const raw of broken) {
      writeFileSync(join(root, good.path), raw);
      files.sync(good.path);
      expect(memoryView.get(db, good.path)).toMatchObject({ name: "Short answers", hash: good.hash });
      expect(files.problems()).toEqual(["you/short-answers.md can't be read"]);
    }
    expect(files.list(null, ["chats", "ions"])[0]).toMatchObject({
      problem: "you/short-answers.md can't be read",
    });
    expect(memoryEvents()).toHaveLength(1);
    // Fixed: the problem goes, and the change is yours.
    writeFileSync(join(root, good.path), "---\nname: Short\ndescription: Replies\n---\nShorter\n");
    files.sync(good.path);
    expect(files.problems()).toEqual([]);
    expect(memoryEvents().at(-1)).toMatchObject({ data: { by: "you", header: { name: "Short" } } });
  });

  // Plan 19, Review Focus 2: a huge file, a link out of the folder, a name like ../x.md: refused, nothing read.
  it("a file over 8 KB, a symlink, or a path outside the folder is refused", () => {
    mkdirSync(join(root, "you"), { recursive: true });
    writeFileSync(join(root, "you", "big.md"), `---\nname: Big\ndescription: x\n---\n${"x".repeat(12_000)}`);
    expect(files.read("you/big.md")).toEqual({ ok: false, gone: false, problem: "you/big.md can't be read" });
    expect(() => files.write({ scope: "you", header: likes, text: "é".repeat(4097), by: "you" })).toThrow(
      new UserError("A memory file holds 8 KB of text at most"),
    );
    const secret = join(dir, "secret.md");
    writeFileSync(secret, "---\nname: Secret\ndescription: outside\n---\nkey\n");
    symlinkSync(secret, join(root, "you", "link.md"));
    expect(files.read("you/link.md")).toMatchObject({ ok: false, problem: "you/link.md can't be read" });
    mkdirSync(join(dir, "elsewhere"));
    writeFileSync(join(dir, "elsewhere", "a.md"), readFileSync(secret));
    mkdirSync(join(root, "projects"));
    symlinkSync(join(dir, "elsewhere"), join(root, "projects", "evil"));
    expect(files.read("projects/evil/a.md")).toMatchObject({ ok: false });
    expect(() => files.write({ scope: { projectId: "evil" }, header: likes, text: "x", by: "you" })).toThrow(
      UserError,
    );
    expect(readFileSync(join(dir, "elsewhere", "a.md"), "utf8")).toBe(readFileSync(secret, "utf8"));
    for (const path of ["../x.md", "you/../../secret.md", "/etc/hosts", "you/link", "projects/../you/a.md"])
      expect(files.read(path)).toMatchObject({ ok: false, problem: "Not a memory file" });
    expect(() => files.write({ scope: "you", slug: "../x", header: likes, text: "x", by: "you" })).toThrow(
      UserError,
    );
    expect(() => files.write({ scope: { projectId: "../.." }, header: likes, text: "x", by: "you" })).toThrow(
      UserError,
    );
    files.reindex();
    expect(memoryView.search(db, { scopes: ["you", "evil"], see: ["chats", "ions"] })).toEqual([]);
  });

  // Plan 19, Review Focus 1: you edit a file while a chat writes to it; ion writes only if it's unchanged.
  it("writing a file you changed since it was read is refused", () => {
    const w = files.write({ scope: "you", header: likes, text: "Keep it short", by: "you" });
    const read = files.read(w.path);
    writeFileSync(join(root, w.path), "---\nname: Short answers\ndescription: Mine\n---\nMy own words\n");
    const chat = { chatId: "c1", runId: "r1" };
    const again = { scope: "you" as const, slug: "short-answers", header: likes, text: "Theirs", by: chat };
    expect(() => files.write({ ...again, expectHash: hashOf(read) })).toThrow(
      new UserError("Changed since you read it"),
    );
    expect(() => files.write(again)).toThrow(new UserError("Changed since you read it"));
    expect(readFileSync(join(root, w.path), "utf8")).toContain("My own words");
    // Read again, it goes through.
    const now = files.read(w.path);
    expect(files.write({ ...again, expectHash: hashOf(now) }).hash).not.toBe(hashOf(now));
    expect(memoryEvents().at(-1)).toMatchObject({ data: { by: chat, before: { text: "My own words" } } });
  });
});

function hashOf(r: ReturnType<MemoryFiles["read"]>): string {
  if (!r.ok) throw new Error(r.problem);
  return r.file.hash;
}

function edit(r: ReturnType<MemoryFiles["read"]>) {
  if (!r.ok) throw new Error(r.problem);
  return { header: r.file.header, text: "Now on Mondays", expectHash: r.file.hash };
}
