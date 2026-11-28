// @vitest-environment jsdom
import { ApiCallError, type IonClient } from "@ion/client/browser";
import type { ChatInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Search } from "./Search.js";
import { SETTINGS_PAGES } from "./settings/pages.js";

afterEach(cleanup);

const chats: ChatInfo[] = [
  {
    ...{ chatId: "c1", title: "Fix checkout rounding", projectId: "shop", branch: null, archived: false },
    ...{ lastRunStatus: "done", lastActivityAt: "2026-11-24T10:00:00Z", preview: null, by: null },
  },
  {
    ...{ chatId: "c2", title: "Old idea", projectId: null, branch: null, archived: true },
    ...{ lastRunStatus: null, lastActivityAt: "2026-11-01T10:00:00Z", preview: null, by: null },
  },
];
chats.push({
  ...{ chatId: "c3", title: "Scratch idea", projectId: "default", branch: null, archived: false },
  ...{ lastRunStatus: null, lastActivityAt: "2026-11-02T10:00:00Z", preview: null, by: null },
});
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
    await waitFor(() => expect(go).toHaveBeenLastCalledWith({ kind: "ion", ionId: "chief" }));
  });

  // Plan 21 final review (2026-11-28, M9): asking ion from Search failed in silence (Search closed, nothing said). It
  // stays open with the words and says why.
  it("says why asking ion failed, and keeps your words", async () => {
    const go = vi.fn();
    const c = client();
    c.call.mockImplementation(async (cmd: string) => {
      if (cmd === "ion.message") throw new ApiCallError("invalid", "No agent is installed");
      return cmd === "chats.list" ? chats : [];
    });
    render(<Search client={c} go={go} />);
    openWithKeys();
    type("qwxz");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(await screen.findByText("No agent is installed")).toBeTruthy();
    expect(box().value).toBe("qwxz");
    expect(go).not.toHaveBeenCalled();
  });

  // Review of Plan 21 Task 4 (2026-11-28): Enter on "round" asked ion instead of opening the chat that matched. Enter
  // opens the first match; Ask ion is the last row, and Enter asks only when nothing else matches (or ⌘↵).
  it("Enter opens the first match; ion is asked only when nothing matches, or with ⌘↵", async () => {
    const go = vi.fn();
    const c = client();
    render(<Search client={c} go={go} />);
    openWithKeys();
    type("round");
    await screen.findByRole("option", { name: /Fix checkout rounding/ });
    const options = screen.getAllByRole("option");
    expect(options.at(-1)?.textContent).toBe("Ask ion: “round”⌘↵");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(go).toHaveBeenLastCalledWith({ kind: "chat", chatId: "c1" });
    expect(c.call).not.toHaveBeenCalledWith("ion.message", expect.anything());
    openWithKeys();
    type("round");
    await screen.findByRole("option", { name: /Fix checkout rounding/ });
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(c.call).toHaveBeenLastCalledWith("ion.message", { ionId: "chief", text: "round" });
    // It closes once ion has your message.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    openWithKeys();
    type("qwxz");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(c.call).toHaveBeenLastCalledWith("ion.message", { ionId: "chief", text: "qwxz" });
  });

  // Plan 21 Task 6 tour (2026-11-28): "dream", "judge" and "night" found nothing, though Dream, Check as judge and
  // Prefer in this order wait under a page's More and the nightly check sits on Agents. Each is one search away, and
  // opens its page with More open.
  it("finds a setting tucked inside a page, and opens its page with More open", async () => {
    const go = vi.fn();
    render(<Search client={client()} go={go} />);
    for (const [q, name, to] of [
      ["dream", /^Dream.*Memory$/, { kind: "settings", page: "memory", more: true }],
      ["judge", /^Check as judge.*Agents$/, { kind: "settings", page: "agents", more: true }],
      ["order", /^Prefer in this order.*Agents$/, { kind: "settings", page: "agents", more: true }],
      ["night", /^Check the agents each night.*Agents$/, { kind: "settings", page: "agents" }],
    ] as const) {
      openWithKeys();
      type(q);
      fireEvent.click(await screen.findByRole("option", { name }));
      expect(go).toHaveBeenLastCalledWith(to);
    }
  });

  // Review: "settings" found no page; "no project" found none of default's chats (they show as No project).
  it("finds by the quiet part too: Settings pages, and No project's chats", async () => {
    render(<Search client={client()} go={vi.fn()} />);
    openWithKeys();
    type("settings");
    await screen.findByRole("option", { name: /^Shortcuts.*Settings$/ });
    type("no project");
    expect(await screen.findByRole("option", { name: /Scratch idea.*No project/ })).toBeTruthy();
  });

  // Review: Esc that closed Search also counted toward a chat's double-Esc Stop, ⌘B hid the sidebar behind it, an
  // IME's Enter picked a row, and Tab left the dialog.
  it("keeps its keys to itself while open", async () => {
    const go = vi.fn();
    const heard: string[] = [];
    const listen = (e: KeyboardEvent) => heard.push(e.key);
    document.addEventListener("keydown", listen);
    try {
      render(<Search client={client()} go={go} />);
      openWithKeys();
      heard.length = 0;
      type("round");
      await screen.findByRole("option", { name: /Fix checkout rounding/ });
      fireEvent.keyDown(box(), { key: "b", metaKey: true });
      fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
      expect(go).not.toHaveBeenCalled();
      for (const o of screen.getAllByRole("option")) expect(o.tabIndex).toBe(-1);
      expect(fireEvent.keyDown(box(), { key: "Tab" })).toBe(false);
      fireEvent.keyDown(box(), { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
      expect(heard).toEqual([]);
    } finally {
      document.removeEventListener("keydown", listen);
    }
  });

  // Re-review (2026-11-28): ⌘↵ picked the last row whatever it was; with an empty box that was an action.
  it("⌘↵ asks ion only from its row, and does nothing without one", async () => {
    const go = vi.fn();
    const c = client();
    render(<Search client={c} go={go} />);
    openWithKeys();
    await screen.findByRole("option", { name: /Fix checkout rounding/ });
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(go).not.toHaveBeenCalled();
    expect(c.call).not.toHaveBeenCalledWith("ion.message", expect.anything());
    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();
  });
});
