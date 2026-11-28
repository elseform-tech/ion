import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../api/commands.js";
import { handlers } from "../api/commands.js";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { Confirms } from "./confirms.js";

// Security scan of PR #36, 2026-11-24: a confirm is yours only. Its id can't be guessed (16 random bytes), and a chat's
// agent (a run's key) is refused by suggestion.answer itself, whatever the id.
describe("a one-click confirm", () => {
  it("has an id that can't be guessed", () => {
    const store = new EventStore(openDb(":memory:"), allViews);
    const c = new Confirms({ store, say: () => {} });
    const id = c.ask("shop", { question: "Save?", yes: "Save", act: async () => "Saved." });
    expect(id).toMatch(/^k[0-9a-f]{32}$/);
  });

  it("refuses a chat's agent", async () => {
    const answer = vi.fn();
    const run = {
      caller: { kind: "run", projectId: "p", chatId: "c", runId: "r" },
      ions: { confirms: { owns: () => true, answer } },
    } as unknown as Ctx;
    await expect(
      Promise.resolve().then(() => handlers["suggestion.answer"]({ suggestionId: "k1", keep: true }, run)),
    ).rejects.toThrow("A chat's agent can't do that");
    expect(answer).not.toHaveBeenCalled();
  });
});
