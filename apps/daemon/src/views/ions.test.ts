import type { NewEvent } from "@ion/schema";
import type { ProjectInfo } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "./index.js";
import { ionsView } from "./ions.js";

let db: Db;
let store: EventStore;
const d = (e: Omit<NewEvent, "origin">): NewEvent => ({ origin: "daemon", ...e });
const projects = (ids: string[]): ProjectInfo[] =>
  ids.map((id) => ({ id, path: `/p/${id}`, starred: false }));

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
});

const chat = (chatId: string, projectId: string, by?: "ion") =>
  store.append(
    d({
      chatId,
      runId: null,
      type: "chat.created",
      data: { title: chatId, projectId, ...(by ? { by } : {}) },
    }),
  );
const ask = (chatId: string, needId: string) =>
  store.append(
    d({
      chatId,
      runId: "r1",
      type: "need.raised",
      data: { needId, requestId: needId, kind: "ask", summary: "Q?", detail: null, dedupeKey: needId },
    }),
  );

// Plan 09: one ion per project, and ion chief over them; `default` has none.
describe("ions view", () => {
  it("lists ion chief first, then one ion per project, never default, with colours in the lab's order", () => {
    const list = ionsView.list(db, projects(["storefront", "default", "payments-api"]));
    expect(list.map((x) => [x.ionId, x.name, x.color])).toEqual([
      ["chief", "ion", null],
      ["storefront", "storefront", "#ED712E"],
      ["payments-api", "payments-api", "#5BC67A"],
    ]);
  });

  // Real run: ion chief's line was blank in the list after it routed (its card says it, its words were empty).
  it("gives a routing line its card's gist", () => {
    const card = {
      kind: "threads",
      threads: [
        { chatId: "a", projectId: "storefront" },
        { chatId: "b", projectId: "x" },
      ],
    };
    store.append(d({ chatId: "ion:chief", runId: null, type: "ion.said", data: { text: "", card } }));
    expect(ionsView.list(db, projects(["storefront"]))[0]!.last).toBe("Asked 2 projects.");
  });

  // Plan 11: suggestions are optional; ion chief's tile keeps what it last told you.
  it("keeps ion chief's last line when it makes a suggestion", () => {
    store.append(d({ chatId: "ion:chief", runId: null, type: "ion.said", data: { text: "Morning." } }));
    const card = {
      ...{ kind: "stalled", suggestionId: "s1", chatId: "c1", projectId: "storefront", title: "T" },
      ...{ since: "2026-11-13T10:00:00.000Z", files: 2 },
    };
    store.append(
      d({ chatId: "ion:chief", runId: null, type: "ion.said", data: { text: "Resume “T”?", card } }),
    );
    expect(ionsView.list(db, projects(["storefront"]))[0]!.last).toBe("Morning.");
  });

  // The user, 2026-11-19: ions showed a plain orb, not the lab's agent shapes. With no agent set for the project,
  // its ion wears the agent its latest chat ran on (the one ion's threads would use).
  it("draws an ion on its project's latest agent when the project names none", () => {
    store.append(
      d({ chatId: "c1", runId: null, type: "chat.created", data: { title: "a", projectId: "storefront" } }),
    );
    store.append(
      d({
        chatId: "c1",
        runId: "r1",
        type: "run.started",
        data: { harness: "grok-build", model: "m", effort: null, authMethod: null, sessionId: "s1" },
      }),
    );
    expect(ionsView.list(db, projects(["storefront", "payments-api"]))[1]!.harness).toBe("grok-build");
    expect(ionsView.list(db, projects(["storefront", "payments-api"]))[2]!.harness).toBeNull();
  });

  it("keeps each ion's last line", () => {
    store.append(d({ chatId: "ion:storefront", runId: null, type: "ion.said", data: { text: "On it." } }));
    expect(ionsView.list(db, projects(["storefront"]))[1]!.last).toBe("On it.");
  });

  it("counts the needs of an ion's threads, never your own chats'", () => {
    chat("t1", "storefront", "ion");
    chat("c1", "storefront");
    ask("t1", "n1");
    ask("c1", "n2");
    const [chief, sf] = ionsView.list(db, projects(["storefront"]));
    expect(sf!.needs).toBe(1);
    expect(chief!.needs).toBe(1);
  });

  it("is working while one of its threads runs", () => {
    chat("t1", "storefront", "ion");
    store.append(d({ chatId: "t1", runId: "r1", type: "run.queued", data: {} }));
    expect(ionsView.list(db, projects(["storefront"]))[1]!.working).toBe(true);
  });
});
