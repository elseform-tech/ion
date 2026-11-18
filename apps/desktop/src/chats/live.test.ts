// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { ChatInfo, IonEvent, NeedInfo } from "@ion/schema";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { groupChats, relTime, useLive } from "./live.js";

const chat = (
  chatId: string,
  lastRunStatus: string | null = "done",
  archived = false,
  o: { at?: string; projectId?: string } = {},
): ChatInfo => ({
  chatId,
  title: chatId,
  projectId: o.projectId ?? "app",
  branch: null,
  archived,
  lastRunStatus,
  lastActivityAt: o.at ?? null,
});
const need = (chatId: string): NeedInfo => ({
  needId: `n-${chatId}`,
  chatId,
  runId: "r",
  projectId: "app",
  kind: "ask",
  summary: `Question in ${chatId}`,
  detail: null,
  raisedAt: "2026-11-18T10:00:00.000Z",
});

// Plan 08: the sidebar as the design lab: newest activity first, short times, one project at a time.
describe("sidebar order, times and projects", () => {
  it("sorts by last activity, newest first", () => {
    const g = groupChats(
      [
        chat("old", "done", false, { at: "2026-11-10T10:00:00Z" }),
        chat("new", "done", false, { at: "2026-11-18T10:00:00Z" }),
      ],
      [],
    );
    expect(g.chats.map((x) => x.chatId)).toEqual(["new", "old"]);
  });

  it("shows times the way the lab does", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(relTime("2026-11-18T11:59:40Z", now)).toBe("now");
    expect(relTime("2026-11-18T11:20:00Z", now)).toBe("40m");
    expect(relTime("2026-11-18T09:00:00Z", now)).toBe("3h");
    expect(relTime("2026-11-17T09:00:00Z", now)).toBe("Tue");
    expect(relTime("2026-11-01T09:00:00Z", now)).toBe("1 Nov");
    expect(relTime(null, now)).toBe("");
  });

  it("shows one project's chats when one is picked", () => {
    const g = groupChats([chat("a"), chat("b", "done", false, { projectId: "other" })], [], "other");
    expect(g.chats.map((x) => x.chatId)).toEqual(["b"]);
  });
});

describe("groupChats", () => {
  it("puts Needs you first, then Running, then the rest newest first; archived chats are hidden", () => {
    const chats = [chat("a"), chat("b", "running"), chat("c"), chat("d", "queued"), chat("e", "done", true)];
    const g = groupChats(chats, [need("c")]);
    expect(g.needsYou.map((x) => [x.need.summary, x.chat.chatId])).toEqual([["Question in c", "c"]]);
    expect(g.running.map((x) => x.chatId)).toEqual(["d", "b"]);
    expect(g.chats.map((x) => x.chatId)).toEqual(["a"]);
  });
});

/** A client whose lists the test changes and whose live events it sends. */
function fakeClient() {
  const lists = { chats: [chat("a")], needs: [] as NeedInfo[] };
  let push: (e: IonEvent) => void = () => {};
  const call = vi.fn(async (cmd: string) => {
    if (cmd === "chats.list") return lists.chats;
    if (cmd === "needs.list") return lists.needs;
    return [];
  });
  const client = {
    call,
    subscribe: vi.fn(async (_q: unknown, fn: (e: IonEvent) => void) => {
      push = fn;
      return () => {};
    }),
    close: () => {},
    onClose: () => {},
  } as unknown as IonClient;
  const send = (type: string, chatId = "a") =>
    act(() =>
      push({
        v: 1,
        id: type,
        chatId,
        runId: "r",
        seq: 1,
        ts: "",
        origin: "daemon",
        type,
        data: {},
      } as IonEvent),
    );
  return { client, lists, send, call };
}

// Review Focus 5: a run starting or a question in a chat that isn't open still moves it in the sidebar.
describe("useLive", () => {
  it("re-reads chats and needs when runs start and end and questions come and go", async () => {
    const f = fakeClient();
    const { result } = renderHook(() => useLive(f.client));
    await waitFor(() => expect(result.current.chats.map((x) => x.lastRunStatus)).toEqual(["done"]));
    // Live events only, never ion's whole history.
    expect(f.client.subscribe).toHaveBeenCalledWith({ fromNow: true }, expect.any(Function));
    f.lists.chats = [chat("a", "running")];
    await f.send("run.started");
    await waitFor(() => expect(result.current.chats.map((x) => x.lastRunStatus)).toEqual(["running"]));
    f.lists.needs = [need("a")];
    await f.send("need.raised");
    await waitFor(() => expect(result.current.needs).toHaveLength(1));
    f.lists.needs = [];
    f.lists.chats = [chat("a", "done")];
    await f.send("need.resolved");
    await waitFor(() => expect(result.current.chats.map((x) => x.lastRunStatus)).toEqual(["done"]));
    expect(result.current.needs).toEqual([]);
  });
});
