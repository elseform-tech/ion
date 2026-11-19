// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import { type ChatInfo, EV, type IonEvent, type IonInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ions } from "./Ions.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 12));
});

let seq = 0;
const ev = (type: string, data: Record<string, unknown>): IonEvent =>
  ({
    ...{ v: 1, id: `e${++seq}`, chatId: "ion:chief", runId: null, seq },
    ...{ ts: "2026-11-19T10:00:00.000Z", origin: "daemon", type, data },
  }) as IonEvent;

const chief: IonInfo = {
  ...{ ionId: "chief", name: "ion", color: null, harness: null, last: null },
  ...{ needs: 0, working: false, thinking: false, starred: false },
};
const storefront: IonInfo = {
  ...{ ionId: "storefront", name: "storefront", color: "#ED712E", harness: "claude-code", last: null },
  ...{ needs: 0, working: false, thinking: false, starred: false },
};
const since = new Date(2026, 10, 13, 10).toISOString();
const stalledChat: ChatInfo = {
  ...{ chatId: "c1", title: "Tailwind 4 migration", projectId: "storefront", branch: "ion/c1" },
  ...{ archived: false, lastRunStatus: "failed", lastActivityAt: since, preview: null, by: null },
};

const routine = {
  ...{ kind: "routine", suggestionId: "s1", projectId: "storefront", key: "summarize prs" },
  ...{ name: "Summarize PRs", text: "Summarize this week's PRs", when: "fri 17:00" },
  dates: [new Date(2026, 10, 13, 17), new Date(2026, 10, 6, 17), new Date(2026, 9, 30, 17)].map((d) =>
    d.toISOString(),
  ),
};
const stalled = {
  ...{ kind: "stalled", suggestionId: "s2", chatId: "c1", projectId: "storefront" },
  ...{ title: "Tailwind 4 migration", since, files: 3 },
};

function client(events: IonEvent[], chats: ChatInfo[] = [stalledChat]) {
  const call = vi.fn(async (cmd: string) => {
    if (cmd === "ions.list") return [chief, storefront];
    if (cmd === "chats.list") return chats;
    if (cmd === "activity.list") return { paused: false, upcoming: [], today: [], yesterday: [] };
    return cmd === "suggestion.answer" ? { ok: true } : [];
  });
  const subscribe = vi.fn(async (q: { chatId?: string }, fn: (e: IonEvent) => void) => {
    for (const e of events) if (e.chatId === q.chatId) fn(e);
    return () => {};
  });
  return { call, subscribe } as unknown as IonClient & { call: typeof call };
}

const cards = [
  ev(EV.ionSaid, { text: "Make “Summarize PRs” a routine?", card: routine }),
  ev(EV.ionSaid, { text: "Resume “Tailwind 4 migration”?", card: stalled }),
];

// Plan 11: ion chief's suggestion cards, as the lab draws them.
describe("ion chief's suggestions", () => {
  // The user, 2026-11-19: slimmer cards. Two lines: what it asks with your answer beside it; then its evidence,
  // when and where, in small words.
  it("draws a routine card: its question, the days you asked, when and where it would run", async () => {
    const { container } = render(<Ions client={client(cards)} onOpenChat={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll(".sugg")).toHaveLength(2));
    const card = container.querySelector(".sugg")!;
    expect(card.querySelector("b")?.textContent).toBe("Make “Summarize PRs” a routine?");
    expect(card.querySelector(".sh .acts")?.textContent).toContain("Add routine");
    expect([...card.querySelectorAll(".sm2 > *")].map((x) => x.textContent)).toEqual([
      "Fri 13 Nov",
      "Fri 6 Nov",
      "Fri 30 Oct",
      "Fridays 17:00",
      "storefront",
    ]);
    // Its words aren't said twice: the card carries them.
    expect(container.querySelector(".bi")).toBeNull();
  });

  it("draws a stalled card: how long, what changed; its chips open the chat", async () => {
    const onOpenChat = vi.fn();
    const { container } = render(<Ions client={client(cards)} onOpenChat={onOpenChat} />);
    await waitFor(() => expect(container.querySelectorAll(".sugg")).toHaveLength(2));
    const card = container.querySelectorAll(".sugg")[1]!;
    expect(card.querySelector("b")?.textContent).toBe("Resume “Tailwind 4 migration”?");
    expect([...card.querySelectorAll(".sm2 > *")].map((x) => x.textContent)).toEqual([
      "Stalled 6 days",
      "3 files",
      "storefront",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Stalled 6 days" }));
    expect(onOpenChat).toHaveBeenCalledWith("c1");
  });

  it("takes, dismisses or mutes a suggestion, then says what came of it", async () => {
    const c = client(cards);
    const { container } = render(<Ions client={c} onOpenChat={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add routine" }));
    expect(c.call).toHaveBeenCalledWith("suggestion.answer", { suggestionId: "s1", keep: true });
    await waitFor(() => expect(container.querySelector(".sugg .done")?.textContent).toBe("Fridays 17:00"));
    // Its time isn't said twice once it's a routine.
    expect(container.querySelector(".sugg .sm2")?.textContent).not.toContain("Fridays");
    fireEvent.click(screen.getByRole("button", { name: "Fewer like this" }));
    expect(c.call).toHaveBeenCalledWith("suggestion.answer", { suggestionId: "s2", keep: false, mute: true });
    await waitFor(() =>
      expect(container.querySelectorAll(".sugg .done")[1]?.textContent).toBe("Fewer like this"),
    );
  });

  it("shows answers you gave before, and a chat picked up since", async () => {
    const answered = [
      ...cards,
      ev(EV.suggestionAnswered, { suggestionId: "s1", keep: false }),
      ev(EV.suggestionAnswered, { suggestionId: "s2", keep: true }),
    ];
    const { container } = render(<Ions client={client(answered)} onOpenChat={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll(".sugg .done")).toHaveLength(2));
    expect([...container.querySelectorAll(".sugg .done")].map((x) => x.textContent)).toEqual([
      "Not now",
      "Resumed",
    ]);
    cleanup();
    const touched = { ...stalledChat, lastActivityAt: new Date(2026, 10, 19, 9).toISOString() };
    const again = render(<Ions client={client(cards, [touched])} onOpenChat={() => {}} />);
    await waitFor(() => expect(again.container.querySelector(".sugg .done")).not.toBeNull());
    expect(again.container.querySelectorAll(".sugg")[1]?.querySelector(".done")?.textContent).toBe(
      "Picked up",
    );
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("says why it couldn't", async () => {
    const c = client(cards);
    c.call.mockImplementation(async (cmd: string) => {
      if (cmd === "suggestion.answer") throw new Error("Fix your config first");
      if (cmd === "ions.list") return [chief, storefront];
      return cmd === "activity.list" ? { paused: false, upcoming: [], today: [], yesterday: [] } : [];
    });
    render(<Ions client={c} onOpenChat={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add routine" }));
    await screen.findByText("Fix your config first");
    expect(screen.getByRole("button", { name: "Add routine" })).toBeTruthy();
  });
});
