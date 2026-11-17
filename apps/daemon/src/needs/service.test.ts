import { EV } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { UserError } from "../api/errors.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { NeedsService } from "./service.js";

let db: Db;
let store: EventStore;
let needs: NeedsService;
const base = {
  chatId: "c1",
  runId: "r1",
  kind: "command",
  summary: "Run pnpm test",
  dedupeKey: "fake:Bash:pnpm test",
};

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  store.append({
    chatId: "c1",
    runId: null,
    origin: "daemon",
    type: EV.chatCreated,
    data: { title: "t", projectId: "app" },
  });
  needs = new NeedsService(store, db);
});

describe("NeedsService", () => {
  it("raises a need and resolves the waiter with your answer", async () => {
    const answer = needs.raise({ ...base, requestId: "q1" });
    const [open] = needs.open();
    expect(open).toMatchObject({ chatId: "c1", runId: "r1", summary: "Run pnpm test", projectId: "app" });
    needs.resolve(open!.needId, "allow", "you");
    expect(await answer).toBe("allow");
    expect(needs.open()).toEqual([]);
    const types = store.read({ runId: "r1" }).map((e) => e.type);
    expect(types).toEqual(["need.raised", "need.resolved"]);
  });

  // Review Focus 2: one answer per need.
  it("refuses a second answer to the same need", async () => {
    const answer = needs.raise({ ...base, requestId: "q1" });
    const id = needs.open()[0]!.needId;
    needs.resolve(id, "deny", "you");
    expect(() => needs.resolve(id, "allow", "you")).toThrow(new UserError("That's already answered"));
    expect(await answer).toBe("deny");
  });

  it("refuses an unknown need", () => {
    expect(() => needs.resolve("nope", "allow", "you")).toThrow(new UserError("Unknown need: nope"));
  });

  it("merges a duplicate request in the same chat into the open need", async () => {
    const a = needs.raise({ ...base, requestId: "q1" });
    const b = needs.raise({ ...base, requestId: "q2" });
    expect(needs.open()).toHaveLength(1);
    needs.resolve(needs.open()[0]!.needId, "allow", "you");
    expect(await Promise.all([a, b])).toEqual(["allow", "allow"]);
  });

  // Review Focus 1: a run that stopped can't be resumed by answering its need.
  it("supersedes a stopped run's open needs, and their waiters get deny", async () => {
    const answer = needs.raise({ ...base, requestId: "q1" });
    needs.supersedeRun("r1");
    expect(await answer).toBe("deny");
    expect(store.read({ runId: "r1" }).at(-1)).toMatchObject({
      type: "need.resolved",
      data: { decision: "superseded", by: "daemon" },
    });
    expect(needs.open()).toEqual([]);
  });
});
