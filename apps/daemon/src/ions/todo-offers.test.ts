import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { EV, type IonCard, type MemoryScope } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFiles } from "../memory/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { Suggestions } from "./suggestions.js";
import { TodoOffers } from "./todo-offers.js";

// The user, 2026-11-21: "does memory cover todo as well". When a chat finishes work that matches an open to-do, the
// ion offers "Mark done?" with Done / Not yet. It never closes one on its own.

let db: Db;
let store: EventStore;
let memory: MemoryFiles;
let configFile: string;
let changed: string[];
let offers: TodoOffers;
let suggestions: Suggestions;
let stops: (() => void)[] = [];
let n = 0;

const todo = (scope: MemoryScope, name: string) =>
  memory.write({
    scope,
    header: { name, description: name, type: "todo", status: "open" },
    text: name,
    by: "you",
  });

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  const root = mkdtempSync(join(tmpdir(), "ion-offers-"));
  configFile = join(root, "config.toml");
  saveUserConfig(configFile, {
    ...DEFAULT_CONFIG,
    projects: [
      { id: "storefront", path: "/p/s", starred: false },
      { id: "private", path: "/p/p", starred: false, shareWithIon: false },
    ],
  });
  memory = new MemoryFiles({ root: join(root, "memory"), store, db });
  changed = [];
  offers = new TodoOffers({ store, db, memory, configFile, changed: async () => changed });
  stops.push(offers.watch());
  suggestions = new Suggestions({
    ...{ store, db, configFile, changes: async () => 0, addRoutine: () => {}, resume: async () => {} },
    todos: offers,
  });
  todo("you", "Update the README");
  todo("you", "Write the changelog");
  todo({ projectId: "storefront" }, "Rotate the API keys");
});

afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

/** A chat in a project whose run ends with this reply. */
async function finish(chatId: string, projectId: string, reply: string, status = "done") {
  if (!store.read({ chatId, types: [EV.chatCreated] }).length)
    store.append({
      chatId,
      runId: null,
      origin: "daemon",
      type: EV.chatCreated,
      data: { title: "Docs pass", projectId },
    });
  const runId = `r${++n}`;
  store.append({ chatId, runId, origin: "adapter", type: EV.messageCompleted, data: { text: reply } });
  store.append({ chatId, runId, origin: "adapter", type: EV.runFinished, data: { status } });
  await vi.waitFor(() => expect(offers.idle()).toBe(true));
}

const cards = (thread: string) =>
  store
    .read({ chatId: thread })
    .filter((e) => e.type === EV.ionSaid)
    .map((e) => e.data as { text: string; card: Extract<IonCard, { kind: "todo" }> });

const status = (path: string) => {
  const r = memory.read(path);
  return r.ok ? r.file.header.status : null;
};

describe("Mark done?", () => {
  it("a finished chat that matches a to-do offers Mark done, and doesn't close it", async () => {
    changed = ["README.md"];
    await finish("c1", "storefront", "I updated the README with the install steps.");
    const said = cards("ion:chief");
    expect(said.map((s) => s.text)).toEqual(["Mark “Update the README” done?"]);
    expect(said[0]!.card).toMatchObject({
      kind: "todo",
      chatId: "c1",
      projectId: "storefront",
      path: "you/update-the-readme.md",
      name: "Update the README",
    });
    expect(status("you/update-the-readme.md")).toBe("open");
    // The same chat finishing again: offered once.
    await finish("c1", "storefront", "Updated the README again.");
    expect(cards("ion:chief")).toHaveLength(1);
    // Not yet: it stays open, and that chat doesn't ask again.
    await suggestions.answer(said[0]!.card.suggestionId, { keep: false });
    expect(status("you/update-the-readme.md")).toBe("open");
    expect(suggestions.list()).toEqual([]);
    // Another chat that does it: offered again; Done closes it, as yours.
    await finish("c2", "storefront", "Updated the README to cover deploys.");
    const again = cards("ion:chief").at(-1)!.card;
    expect(suggestions.list()).toMatchObject([{ suggestionId: again.suggestionId, kind: "todo" }]);
    await suggestions.answer(again.suggestionId, { keep: true });
    expect(status("you/update-the-readme.md")).toBe("done");
    const by = store.read({ types: [EV.memoryWritten] }).at(-1)!.data as { by: unknown };
    expect(by.by).toBe("you");
  });

  it("a project's to-do is offered by its ion; nothing unrelated, failed or kept from ion chief is", async () => {
    await finish("c1", "storefront", "I rotated the API keys and redeployed.");
    expect(cards("ion:storefront").map((s) => s.text)).toEqual(["Mark “Rotate the API keys” done?"]);
    await finish("c2", "storefront", "Fixed the cart badge colour.");
    await finish("c3", "storefront", "I updated the README.", "failed");
    changed = ["README.md"];
    await finish("c4", "private", "I updated the README.");
    expect(cards("ion:chief")).toEqual([]);
    expect(cards("ion:storefront")).toHaveLength(1);
  });

  // Task review, 2026-11-22: a second chat that matched while the first card waited added another card for the same
  // to-do; one word in common ("README") was enough; "I didn't update the README" counted as doing it.
  it("one open card per to-do; two words in common; a mention that says it wasn't done doesn't count", async () => {
    changed = ["README.md"];
    await finish("c1", "storefront", "Fixed a typo.");
    expect(cards("ion:chief")).toEqual([]);
    changed = [];
    await finish("c2", "storefront", "I didn't update the README: the docs build is broken.");
    await finish("c3", "storefront", "The README is not updated yet.");
    expect(cards("ion:chief")).toEqual([]);
    await finish("c4", "storefront", "I updated the README.");
    await finish("c5", "storefront", "Updated the README again.");
    expect(cards("ion:chief").map((s) => s.card.chatId)).toEqual(["c4"]);
  });

  // Task review, 2026-11-22: a to-do with no telling words ("Do it") matched every finished chat.
  it("a to-do with no telling words matches nothing", async () => {
    todo("you", "Do it");
    await finish("c1", "storefront", "Fixed the cart badge colour.");
    expect(cards("ion:chief")).toEqual([]);
  });

  // Task review, 2026-11-22: an unanswered "Mark done?" card blocked new cards for that to-do forever.
  it("a card left over a week, or from before the to-do was closed and reopened, no longer blocks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
      await finish("c1", "storefront", "I updated the README.");
      vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
      await finish("c2", "storefront", "Updated the README again.");
      expect(cards("ion:chief").map((s) => s.card.chatId)).toEqual(["c1", "c2"]);
      // Closed and reopened by you since c2's card: c3 is offered.
      const path = "you/update-the-readme.md";
      const read = () => (memory.read(path) as { ok: true; file: { header: object; hash: string } }).file;
      const flip = (status: "open" | "done") =>
        memory.write({
          scope: "you",
          slug: "update-the-readme",
          header: { ...read().header, status } as never,
          text: "Update the README",
          expectHash: read().hash,
          by: "you",
        });
      vi.setSystemTime(new Date("2026-11-09T11:00:00Z"));
      flip("done");
      flip("open");
      vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
      await finish("c3", "storefront", "Updated the README for deploys.");
      expect(cards("ion:chief").map((s) => s.card.chatId)).toEqual(["c1", "c2", "c3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Task review, 2026-11-22: Done with no to-dos wired said it was done and closed nothing.
  it("Done without to-dos to close says so", async () => {
    await finish("c1", "storefront", "I updated the README.");
    const bare = new Suggestions({
      ...{ store, db, configFile, changes: async () => 0, addRoutine: () => {}, resume: async () => {} },
    });
    const id = cards("ion:chief")[0]!.card.suggestionId;
    await expect(bare.answer(id, { keep: true })).rejects.toThrow("Can't close to-dos here");
    expect(status("you/update-the-readme.md")).toBe("open");
  });
});
