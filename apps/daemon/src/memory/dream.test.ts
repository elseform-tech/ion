import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig, type UserConfig } from "@ion/config";
import { EV, type MemoryBy, type MemoryScope, type MemoryType } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../api/commands.js";
import { memoryHandlers } from "../api/memory.js";
import { Dreams } from "../scheduler/dreams.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { type DreamDeps, type DreamTurn, dreamDue, restoreForgotten, runDream } from "./dream.js";
import { MemoryFiles } from "./index.js";
import { ScopedMemory } from "./scoped.js";

// The user, 2026-11-22: "could we also have a 'dream' setting to allow active harness to manage stale information and
// update memory … so that memories can be maintained" → chose "Apply everything". ion's dream merges, rewrites and
// forgets on its own, overnight, within strict limits; every change is in History with Restore.

let db: Db;
let store: EventStore;
let memory: MemoryFiles;
let configFile: string;

const CHIEF: MemoryBy = { ion: "chief" };
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);

type Seed = { scope: MemoryScope; type: MemoryType; text: string; by?: MemoryBy };

function seed(name: string, s: Seed) {
  const header = { name, description: `About ${name}`, type: s.type };
  return memory.write({ scope: s.scope, header, text: s.text, by: s.by ?? CHIEF });
}

/** ion's dream as its tools have it: every project shared with ion. */
/** ion's dream as its tools have it: pass A (chats files: a project's, or yours) or pass B (ions files). */
const dream = (see: "chats" | "ions" = "ions", project: string | null = null) =>
  new ScopedMemory(memory, {
    kind: "ion",
    ionId: "_dream",
    projects: ["shop", "bank"],
    dream: { see, project },
  });
/** Runs `f` on the first pass only (a dream has a pass per kind of file). */
const once = (f: () => void) => {
  let ran = false;
  return async () => {
    if (!ran) f();
    ran = true;
    return done();
  };
};
const done = (reply = "Tidied."): DreamTurn => ({ reply, status: "done" });
const deps = (think: DreamDeps["think"]): DreamDeps => ({ store, db, memory, configFile, think });
const dreamed = () => store.read({ types: [EV.memoryDreamed] });

function config(dream: "off" | "nightly" | "weekly", quietOn = true): UserConfig {
  return {
    ...DEFAULT_CONFIG,
    memory: { dream },
    notifications: { ...DEFAULT_CONFIG.notifications, quiet: { on: quietOn, from: "22:00", to: "08:00" } },
    projects: [
      { id: "shop", path: "/p/shop", starred: false },
      { id: "bank", path: "/p/bank", starred: false },
    ],
  };
}

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  const root = mkdtempSync(join(tmpdir(), "ion-dream-"));
  memory = new MemoryFiles({ root: join(root, "memory"), store, db });
  configFile = join(root, "config.toml");
  saveUserConfig(configFile, config("nightly"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ion's dream", () => {
  it("dream runs only when on, in quiet hours", async () => {
    const none = new Set<string>();
    const night = "2026-11-20";
    const due = (c: UserConfig, now: Date, served = none) => dreamDue(c, now, served) !== null;
    expect(due(config("off"), at(20, 3, 30))).toBe(false);
    expect(dreamDue(config("nightly"), at(20, 3, 30), none)).toBe(night);
    // The working day: never.
    expect(due(config("nightly"), at(20, 14))).toBe(false);
    // Asleep at 3:00: later that night, while quiet hours last; with quiet hours off, until 6:00 only.
    expect(due(config("nightly"), at(20, 7, 30))).toBe(true);
    expect(due(config("nightly", false), at(20, 7, 30))).toBe(false);
    expect(due(config("nightly", false), at(20, 5))).toBe(true);
    // Once a night; once a week (the night to Monday, 3:00).
    expect(due(config("nightly"), at(20, 4), new Set([night]))).toBe(false);
    expect(due(config("nightly"), at(21, 3, 30), new Set([night]))).toBe(true);
    const monday = "2026-11-23";
    expect(dreamDue(config("weekly"), at(23, 3, 30), none)).toBe(monday);
    expect(due(config("weekly"), at(24, 3, 30), new Set([monday]))).toBe(false);
    expect(due(config("weekly"), at(30, 3, 30), new Set([monday]))).toBe(true);

    // The scheduler (quiet hours off, so 1:00 isn't a catch-up): one turn at 3:00, none while off.
    seed("Node", { scope: { projectId: "shop" }, type: "fact", text: "Node 22." });
    saveUserConfig(configFile, config("nightly", false));
    vi.useFakeTimers();
    vi.setSystemTime(at(20, 1));
    const think = vi.fn(async () => done());
    const stop = new Dreams(deps(think)).start();
    await vi.advanceTimersByTimeAsync(at(20, 2, 59).getTime() - Date.now());
    expect(think).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(at(20, 3, 10).getTime() - Date.now());
    expect(think).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(at(20, 7).getTime() - Date.now());
    expect(think).toHaveBeenCalledTimes(1);
    saveUserConfig(configFile, config("off"));
    await vi.advanceTimersByTimeAsync(at(21, 4).getTime() - Date.now());
    expect(think).toHaveBeenCalledTimes(1);
    stop();
  });

  // The user, 2026-11-22 ("sure"): a missed dream (the Mac asleep, or ion not running at 3:00) catches up once: the
  // next time ion is up in quiet hours, else at the next 3:00; never in the working day, never twice for one night.
  it("a missed dream catches up once, in quiet hours, never in the working day", async () => {
    vi.useFakeTimers();
    seed("Node", { scope: { projectId: "shop" }, type: "fact", text: "Node 22." });
    const think = vi.fn(async () => done());
    // Started at 7:00 after a missed 3:00, quiet hours off: it waits for the next 3:00.
    saveUserConfig(configFile, config("nightly", false));
    vi.setSystemTime(at(20, 7));
    const stop = new Dreams(deps(think)).start();
    await vi.advanceTimersByTimeAsync(at(21, 2, 50).getTime() - Date.now());
    expect(think).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(at(21, 3, 5).getTime() - Date.now());
    expect(think).toHaveBeenCalledTimes(1);
    stop();
    // Quiet hours 22:00–7:00 and a start at 23:00 after a missed 3:00: it runs then, once, and not again for that night.
    saveUserConfig(configFile, {
      ...config("nightly"),
      notifications: { ...DEFAULT_CONFIG.notifications, quiet: { on: true, from: "22:00", to: "07:00" } },
    });
    vi.setSystemTime(at(22, 23));
    const again = vi.fn(async () => done());
    const stop2 = new Dreams(deps(again)).start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(again).toHaveBeenCalledTimes(1);
    // A restart in the same quiet hours: that night's run is recorded, so none again.
    stop2();
    const stop3 = new Dreams(deps(again)).start();
    await vi.advanceTimersByTimeAsync(at(23, 2, 50).getTime() - Date.now());
    expect(again).toHaveBeenCalledTimes(1);
    stop3();
    const periods = dreamed().map((e) => (e.data as { period?: string }).period);
    expect(new Set(periods)).toEqual(new Set(["2026-11-21", "2026-11-22"]));
  });

  it("dream sees recent chats' words as data, and memory's index", async () => {
    seed("Package manager", { scope: { projectId: "shop" }, type: "fact", text: "The shop uses npm." });
    store.append({
      chatId: "c1",
      runId: null,
      origin: "daemon",
      type: EV.chatCreated,
      data: { title: "Tooling", projectId: "shop" },
    });
    const said = "We switched the shop to pnpm last week.";
    store.append({ chatId: "c1", runId: null, origin: "daemon", type: EV.messageSent, data: { text: said } });
    let prompt = "";
    await runDream(
      deps(async (p) => {
        prompt = p;
        return done();
      }),
    );
    const chats = prompt.slice(prompt.indexOf('source="recent chats'));
    expect(prompt).toContain("<ion-data id=");
    expect(chats).toContain("switched the shop to pnpm");
    expect(prompt).toContain("Package manager");
  });

  it("dream merges duplicates keeping both details", async () => {
    const a = seed("Deploy steps", {
      scope: { projectId: "shop" },
      type: "fact",
      text: "Deploys run from main.",
    });
    const b = seed("Deploy notes", {
      scope: { projectId: "shop" },
      type: "fact",
      text: "Deploys need the VPN on.",
    });
    const info = await runDream(
      deps(
        once(() => {
          const m = dream("chats", "shop");
          m.write({
            scope: "shop",
            path: a.path,
            text: "Deploys run from main, with the VPN on.",
            expect: a.hash,
          });
          m.forget(b.path, b.hash, a.path);
        }),
      ),
    );
    expect(info).toMatchObject({ merged: 1, updated: 0, forgot: 0, moved: 0 });
    const kept = memory.read(a.path);
    expect(kept.ok && kept.file.text).toMatch(/main[\s\S]*VPN/);
    expect(memory.read(b.path)).toMatchObject({ ok: false, gone: true });
    // Recorded as it started, and what it did.
    expect(dreamed().map((e) => (e.data as { status: string }).status)).toEqual(["started", "done"]);
  });

  it("dream never touches person files, recent edits, or to-do status", async () => {
    const person = seed("Sam", { scope: "you", type: "person", text: "Sam is the user's partner." });
    const mine = seed("Editor", { scope: "you", type: "preference", text: "Uses Helix.", by: "you" });
    const todo = memory.write({
      scope: "you",
      header: { name: "Renew passport", description: "Renew it", type: "todo", status: "open" },
      text: "Renew the passport.",
      by: CHIEF,
    });
    const quiet = memory.write({
      scope: "you",
      header: { name: "Home town", description: "Where", type: "fact", see: "ions" },
      text: "Grew up in Porto.",
      by: CHIEF,
    });
    const tries: (() => unknown)[] = [
      () => dream().write({ scope: "you", path: person.path, text: "Sam moved.", expect: person.hash }),
      () => dream().forget(person.path, person.hash),
      () => dream("chats").write({ scope: "you", path: mine.path, text: "Uses Vim.", expect: mine.hash }),
      () => dream("chats").forget(mine.path, mine.hash),
      () => dream().write({ scope: "you", path: todo.path, status: "done", expect: todo.hash }),
      () => dream().forget(todo.path, todo.hash),
      // Task review, 2026-11-22: not even a to-do's text; the dream may only note it.
      () => dream().write({ scope: "you", path: todo.path, text: "Renew it soon.", expect: todo.hash }),
      () => dream().write({ scope: "you", path: quiet.path, see: "chats", expect: quiet.hash }),
      () =>
        dream().write({ scope: "you", name: "Kid", description: "Kid", type: "person", text: "Has a kid." }),
      () =>
        dream().write({
          scope: "you",
          name: "Shared",
          description: "x",
          type: "fact",
          text: "x",
          see: "chats",
        }),
    ];
    const refused: string[] = [];
    await runDream(
      deps(
        once(() => {
          for (const t of tries)
            try {
              t();
            } catch (e) {
              refused.push((e as Error).message);
            }
        }),
      ),
    );
    expect(refused).toHaveLength(tries.length);
    expect(refused[2]).toBe("The user changed this in the last day; leave it");
    expect(refused[6]).toBe("A to-do is yours; I'll note it");
    for (const f of [person, mine, todo, quiet]) expect(memory.row(f.path)?.hash).toBe(f.hash);
  });

  it("every dream change has history and can be restored", async () => {
    const fact = seed("Node version", {
      scope: { projectId: "shop" },
      type: "fact",
      text: "The shop runs Node 18.",
    });
    const old = seed("Old launch", {
      scope: { projectId: "shop" },
      type: "fact",
      text: "Launch is on 1 March 2025.",
    });
    await runDream(
      deps(
        once(() => {
          const m = dream("chats", "shop");
          m.write({ scope: "shop", path: fact.path, text: "The shop runs Node 22.", expect: fact.hash });
          m.forget(old.path, old.hash);
        }),
      ),
    );
    const last = memory.history(fact.path).at(-1);
    expect(last).toMatchObject({ kind: "written", by: { ion: "_dream" } });
    const ctx = { db, store, memory, configFile } as unknown as Ctx;
    const shown = memoryHandlers["memory.history"]({ path: fact.path }, ctx);
    expect(shown[0]).toMatchObject({ source: "ion:_dream", text: "The shop runs Node 22." });
    // Restore an older text (History), and a forgotten file (Memory's Tidied line).
    const now = memoryHandlers["memory.read"]({ name: fact.path }, ctx);
    memoryHandlers["memory.write"]({ path: fact.path, text: shown[1]!.text!, expect: now.hash }, ctx);
    expect(memory.read(fact.path)).toMatchObject({ ok: true, file: { text: "The shop runs Node 18." } });
    expect(memoryHandlers["memory.tidied"]({}, ctx)).toMatchObject({
      forgot: 1,
      forgotten: [{ path: old.path }],
    });
    restoreForgotten(memory, old.path);
    expect(memory.read(old.path)).toMatchObject({
      ok: true,
      file: { header: { name: "Old launch" }, text: "Launch is on 1 March 2025." },
    });
    expect(memoryHandlers["memory.tidied"]({}, ctx)).toMatchObject({ forgotten: [] });
  });
  // Task review, 2026-11-22: ions-only text could be copied into a file chats see. The dream runs in two passes: one
  // sees and writes only chats files (one project's, or yours), the other sees everything but writes only ions files.
  it("dream can't copy ions-only text into a chats file", async () => {
    const secret = memory.write({
      scope: "you",
      header: { name: "Health", description: "A private note", type: "fact", see: "ions" },
      text: "Has a hospital visit on Friday.",
      by: CHIEF,
    });
    const shared = seed("Deploy steps", { scope: { projectId: "shop" }, type: "fact", text: "From main." });
    const mine = seed("Tabs", { scope: "you", type: "preference", text: "Tabs, width 2." });
    const write = (m: ScopedMemory, f: typeof shared, text: string) => () =>
      m.write({ scope: f.scope === "you" ? "you" : "shop", path: f.path, text, expect: f.hash });
    const refused = (f: () => unknown) => {
      try {
        f();
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    // A private pass sees your private note, and may not write a file chats see.
    expect(dream("ions", "shop").read(secret.path).text).toContain("hospital");
    expect(refused(write(dream("ions", "shop"), shared, "From main. Has a hospital visit on Friday."))).toBe(
      "This pass only changes files chats can't see",
    );
    // Pass A (shop's) can't see it at all, nor change your shared files.
    expect(refused(() => dream("chats", "shop").read(secret.path))).toBe("No such memory");
    expect(
      dream("chats", "shop")
        .index()
        .map((r) => r.path),
    ).not.toContain(secret.path);
    expect(refused(write(dream("chats", "shop"), mine, "Spaces."))).toBe(
      "This pass only changes shop's files",
    );
    // Neither changes who sees a file, and a new file is seen as its pass's files are.
    const widen = () => dream().write({ scope: "you", path: secret.path, see: "chats", expect: secret.hash });
    expect(refused(widen)).toBe("I never change who sees a file");
    const made = dream().write({ scope: "you", name: "Visit", description: "x", type: "fact", text: "x" });
    expect(made.header.see).toBe("ions");
    for (const f of [secret, shared, mine]) expect(memory.row(f.path)?.hash).toBe(f.hash);
  });

  // Task review, 2026-11-22: a merge's target is a file the dream may change (not one you just edited), and an `into`
  // that names two files is refused rather than guessed.
  it("dream merges only into a file it may change, named once", async () => {
    const a = seed("Deploy", { scope: { projectId: "shop" }, type: "fact", text: "From main.", by: "you" });
    const b = seed("Deploy notes", { scope: { projectId: "shop" }, type: "fact", text: "VPN on." });
    seed("Deploy", { scope: "you", type: "preference", text: "Mine." });
    const m = dream("chats", "shop");
    expect(() => m.forget(b.path, b.hash, a.path)).toThrow("The user changed this in the last day; leave it");
    expect(() => m.forget(b.path, b.hash, "Deploy")).toThrow(/^Several match: .*; give the path$/);
    expect(memory.row(b.path)?.hash).toBe(b.hash);
  });

  // Task review, 2026-11-22: a dream that started but never ended (ion stopped mid-dream) is summed up at the next
  // start, so the briefing and Memory say what it changed, and that night isn't dreamed again.
  it("a dream cut off mid-way is summed up at the next start", async () => {
    store.append({
      ...{ chatId: null, runId: null, origin: "daemon" },
      type: EV.memoryDreamed,
      data: {
        ...{ merged: 0, updated: 0, forgot: 0, moved: 0, forgotten: [], changed: [], notes: [] },
        ...{ status: "started", period: "2026-11-20" },
      },
    });
    const f = seed("Node", { scope: { projectId: "shop" }, type: "fact", text: "Node 18." });
    dream("chats", "shop").write({ scope: "shop", path: f.path, text: "Node 22.", expect: f.hash });
    const stop = new Dreams(deps(async () => done())).start();
    stop();
    const last = dreamed().at(-1)?.data as { status: string; updated: number; period?: string };
    expect(last).toMatchObject({ status: "failed", updated: 1, period: "2026-11-20" });
  });

  // Task review, 2026-11-22: the private pass read every project's chats and wrote any project's (and your) ions
  // files, so one project's chat could reach another project's ion. Every pass keeps to one project, or to your files
  // with no chats at all.
  it("text only in project A's chats never lands in project B's files or in your files", async () => {
    const files = [
      seed("Shop deploys", { scope: { projectId: "shop" }, type: "fact", text: "Shop deploys on Fridays." }),
      seed("Bank deploys", { scope: { projectId: "bank" }, type: "fact", text: "Bank deploys on Mondays." }),
      seed("Tabs", { scope: "you", type: "preference", text: "Tabs." }),
    ];
    for (const [scope, name] of [
      [{ projectId: "shop" }, "Shop roadmap"],
      [{ projectId: "bank" }, "Bank roadmap"],
      ["you", "Health"],
    ] as const)
      files.push(
        memory.write({
          scope,
          header: { name, description: name, type: "fact", see: "ions" },
          text: name,
          by: CHIEF,
        }),
      );
    const secret = "The shop's launch code is KESTREL.";
    store.append({
      chatId: "c1",
      runId: null,
      origin: "daemon",
      type: EV.chatCreated,
      data: { title: "Launch", projectId: "shop" },
    });
    store.append({
      chatId: "c1",
      runId: null,
      origin: "daemon",
      type: EV.messageSent,
      data: { text: secret },
    });
    const seen: { see: string; project: string | null; secret: boolean }[] = [];
    await runDream(
      deps(async (prompt, step) => {
        seen.push({
          see: step.pass.see,
          project: step.pass.project ?? null,
          secret: prompt.includes("KESTREL"),
        });
        return done();
      }),
    );
    // A pass per project and kind, and one per kind of yours; only shop's passes read shop's chat.
    expect(seen.map((x) => `${x.see}:${x.project ?? "you"}`).sort()).toEqual(
      ["chats:bank", "chats:shop", "chats:you", "ions:bank", "ions:shop", "ions:you"].sort(),
    );
    expect(seen.filter((x) => x.secret).map((x) => x.project)).toEqual(["shop", "shop"]);
    // And a shop pass changes only shop's files.
    for (const see of ["chats", "ions"] as const)
      for (const f of files.filter((x) => x.scope === "you" || x.scope.projectId === "bank"))
        expect(() =>
          dream(see, "shop").write({
            scope: f.scope === "you" ? "you" : "bank",
            path: f.path,
            text: "KESTREL",
            expect: f.hash,
          }),
        ).toThrow();
    for (const f of files) expect(memory.row(f.path)?.hash).toBe(f.hash);
  });
});
