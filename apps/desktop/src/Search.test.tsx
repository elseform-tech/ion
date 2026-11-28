// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Search } from "./Search.js";
import { SETTINGS_PAGES } from "./settings/pages.js";

afterEach(cleanup);

const chats = [
  {
    ...{ chatId: "c1", title: "Fix checkout rounding", projectId: "shop", branch: null, archived: false },
    ...{ lastRunStatus: "done", lastActivityAt: "2026-11-24T10:00:00Z", preview: null, by: null },
  },
  {
    ...{ chatId: "c2", title: "Old idea", projectId: null, branch: null, archived: true },
    ...{ lastRunStatus: null, lastActivityAt: "2026-11-01T10:00:00Z", preview: null, by: null },
  },
];
const ions = [
  { ionId: "chief", name: "ion", color: null, harness: null, last: null, needs: 0 },
  { ionId: "shop", name: "Shop", color: "#ED712E", harness: "grok-build", last: null, needs: 0 },
];

function client() {
  const call = vi.fn(async (cmd: string) => {
    if (cmd === "chats.list") return chats;
    if (cmd === "ions.list") return ions;
    return { ok: true };
  });
  return { call, subscribe: vi.fn(async () => () => {}) } as unknown as IonClient & { call: typeof call };
}

const openWithKeys = () => fireEvent.keyDown(document, { key: "k", metaKey: true });
const box = () => screen.getByRole("combobox", { name: "Search" }) as HTMLInputElement;
const type = (q: string) => fireEvent.change(box(), { target: { value: q } });

// Plan 21 Task 4 (the user, 2026-11-24: tuck away, never delete; "nothing becomes unreachable"): the lab's ⌘K Search
// reaches every screen, so a page tucked under More is one search away.
describe("Search", () => {
  it("nothing becomes unreachable: every screen and every Settings page is one search away", async () => {
    const go = vi.fn();
    render(<Search client={client()} go={go} />);
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
    openWithKeys();
    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();
    for (const page of SETTINGS_PAGES) {
      type(page.label);
      const option = await screen.findByRole("option", { name: new RegExp(`^${page.label}.*Settings$`) });
      fireEvent.click(option);
      expect(go).toHaveBeenLastCalledWith({ kind: "settings", page: page.id });
      openWithKeys();
    }
    for (const [label, to] of [
      ["New chat", { kind: "new" }],
      ["Chats", { kind: "chats" }],
      ["Ions", { kind: "ions" }],
    ] as const) {
      type(label);
      fireEvent.click(await screen.findByRole("option", { name: label }));
      expect(go).toHaveBeenLastCalledWith(to);
      openWithKeys();
    }
  });

  it("finds a chat and an ion, opens with Enter, and closes with Esc", async () => {
    const go = vi.fn();
    render(<Search client={client()} go={go} />);
    openWithKeys();
    type("round");
    await screen.findByRole("option", { name: /Fix checkout rounding/ });
    // An archived chat isn't offered.
    type("old idea");
    await waitFor(() => expect(screen.queryByRole("option", { name: /Old idea/ })).toBeNull());
    type("round");
    await screen.findByRole("option", { name: /Fix checkout rounding/ });
    // As in the lab, Ask ion comes first; the chat is one down.
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(go).toHaveBeenLastCalledWith({ kind: "chat", chatId: "c1" });
    openWithKeys();
    type("shop");
    const ion = await screen.findByRole("option", { name: /^Shop/ });
    fireEvent.click(ion);
    expect(go).toHaveBeenLastCalledWith({ kind: "ion", ionId: "shop" });
    openWithKeys();
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
  });

  it("free text asks ion", async () => {
    const go = vi.fn();
    const c = client();
    render(<Search client={c} go={go} />);
    openWithKeys();
    type("what changed today?");
    fireEvent.click(await screen.findByRole("option", { name: "Ask ion: “what changed today?”" }));
    expect(c.call).toHaveBeenCalledWith("ion.message", { ionId: "chief", text: "what changed today?" });
    expect(go).toHaveBeenLastCalledWith({ kind: "ion", ionId: "chief" });
  });
});
