// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { MemoryChangeInfo, MemoryFileInfo, MemoryInfo } from "@ion/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFile } from "../opener.js";
import { Settings } from "./Settings.js";

vi.mock("../opener.js", () => ({
  CANT_OPEN: "Couldn't open it",
  openFile: vi.fn(async () => "opened"),
  openLink: vi.fn(async () => {}),
}));

// Wednesday 18 November 2026, noon (UTC: the app's "when" is by UTC days; a due day is today's date here).
const NOW = new Date(Date.UTC(2026, 10, 18, 12, 0));
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(openFile).mockClear();
});

const file = (o: Partial<MemoryInfo> & Pick<MemoryInfo, "memoryId" | "name">): MemoryInfo => ({
  scope: "you",
  description: o.name,
  type: "fact",
  see: "ions",
  text: o.name,
  source: "you",
  writtenAt: ago(2),
  ...o,
});

const FILES: MemoryInfo[] = [
  file({
    memoryId: "you/tabs.md",
    name: "Tabs, not spaces",
    type: "preference",
    see: "chats",
    source: "c1",
    sourceTitle: "Docs pass",
  }),
  file({ memoryId: "you/sam.md", name: "Sam", type: "person", source: "ion:chief", writtenAt: ago(30) }),
  file({
    memoryId: "you/short.md",
    name: "Short replies",
    type: "preference",
    see: "chats",
    suggested: "shop",
    source: "c2",
  }),
  file({
    memoryId: "projects/shop/deploy.md",
    scope: "project:shop",
    name: "Deploy",
    type: "reference",
    see: "chats",
  }),
  file({
    memoryId: "you/passport.md",
    name: "Renew the passport",
    type: "todo",
    status: "open",
    due: "2026-11-18",
  }),
  file({
    memoryId: "you/visa.md",
    name: "Send the visa form",
    type: "todo",
    status: "open",
    due: "2026-11-20",
  }),
  file({
    memoryId: "you/tax.md",
    name: "File the tax return",
    type: "todo",
    status: "open",
    due: "2026-11-10",
  }),
  file({ memoryId: "you/dentist.md", name: "Book the dentist", type: "todo", status: "done" }),
];

const read = (m: MemoryInfo, text = m.text): MemoryFileInfo => ({
  path: m.memoryId,
  scope: m.scope,
  name: m.name,
  description: m.description,
  type: m.type,
  see: m.see,
  text,
  hash: `h-${text.length}`,
});

const HISTORY: MemoryChangeInfo[] = [
  { at: ago(2), kind: "written", source: "c1", sourceTitle: "Docs pass", text: "Tabs, width 2" },
  { at: ago(48), kind: "written", source: "you", text: "Tabs" },
];

/** A daemon with memory: each call answers from FILES; `memory.search` finds by name. */
function memoryClient() {
  const call = vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    if (cmd === "projects.list") return [{ id: "shop", name: "Shop", path: "/p/shop", starred: true }];
    if (cmd === "ions.list")
      return [{ ionId: "chief", name: "ion", color: null, harness: null, last: null, needs: 0 }];
    if (cmd === "settings.get") return null;
    if (cmd === "memory.list") return a.type === "todo" ? FILES.filter((f) => f.type === "todo") : FILES;
    if (cmd === "memory.search")
      return FILES.filter((f) => f.name.toLowerCase().includes(String(a.q).toLowerCase()));
    if (cmd === "memory.folder") return { path: "/d/memory", problems: ["shop/notes.md can't be read"] };
    if (cmd === "memory.read") {
      const m = FILES.find((f) => f.memoryId === a.name)!;
      return read(m, m.memoryId === "you/tabs.md" ? "Tabs, width 2" : m.text);
    }
    if (cmd === "memory.history") return HISTORY;
    if (cmd === "memory.write" || cmd === "todo.done") return FILES[0];
    return [];
  });
  return { call, subscribe: vi.fn(async () => () => {}) } as unknown as IonClient & { call: typeof call };
}

async function openMemory(c = memoryClient()) {
  render(<Settings client={c} onOpenIon={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Memory" }));
  await screen.findByText("Tabs, not spaces");
  return c;
}

const rowOf = (name: string) => screen.getByText(name).closest(".trow") as HTMLElement;

// The user, 2026-11-21: "can we repurpose memory into multiple memory files that ions or plain chat can read, of
// course, project scope". Settings → Memory: yours, then each project's, with search.
describe("Settings → Memory", () => {
  it("Memory lists by scope and searches", async () => {
    const c = await openMemory();
    expect(screen.getByText("Sam")).toBeTruthy();
    expect(screen.queryByText("Deploy")).toBeNull();
    // The broken file's line, and the folder.
    expect(screen.getByText("shop/notes.md can't be read").className).toContain("perr");
    fireEvent.click(screen.getByRole("button", { name: "Open memory folder" }));
    expect(openFile).toHaveBeenCalledWith("/d/memory");
    // A project's files.
    fireEvent.click(screen.getByRole("button", { name: "Shop" }));
    expect(screen.getByText("Deploy")).toBeTruthy();
    expect(screen.queryByText("Sam")).toBeNull();
    // Search: the index's best matches, in the scope picked.
    fireEvent.click(screen.getByRole("button", { name: "You" }));
    fireEvent.change(screen.getByLabelText("Search memory"), { target: { value: "sam" } });
    await waitFor(() => expect(screen.queryByText("Tabs, not spaces")).toBeNull());
    expect(c.call).toHaveBeenCalledWith("memory.search", { q: "sam" });
    expect(screen.getByText("Sam")).toBeTruthy();
  });

  it("a row shows who changed it and when", async () => {
    await openMemory();
    expect(rowOf("Tabs, not spaces").textContent).toContain("Docs pass · 2h");
    // Tour, 2026-11-22: ion chief's name is "ion"; a row said "ion · now", read as ion itself.
    expect(rowOf("Sam").textContent).toContain("ion chief · Tue");
    expect(within(rowOf("Sam")).getByTitle("Person")).toBeTruthy();
  });

  it("Shared with chats changes see, only on your files; Keep keeps a suggestion", async () => {
    const c = await openMemory();
    const sw = within(rowOf("Sam")).getByRole("switch", { name: "Shared with chats" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(() =>
      expect(c.call).toHaveBeenCalledWith("memory.write", {
        path: "you/sam.md",
        see: "chats",
        expect: "h-3",
      }),
    );
    // A suggestion has Keep, not the switch.
    const short = rowOf("Short replies");
    expect(within(short).getByText("Suggested")).toBeTruthy();
    expect(within(short).queryByRole("switch")).toBeNull();
    fireEvent.click(within(short).getByRole("button", { name: "Keep" }));
    expect(c.call).toHaveBeenCalledWith("memory.keep", { path: "you/short.md" });
    // Tour, 2026-11-22: a to-do had the switch too (the lab has none: to-dos are in their own tab).
    expect(within(rowOf("Renew the passport")).queryByRole("switch")).toBeNull();
    // A project's file has no switch.
    fireEvent.click(screen.getByRole("button", { name: "Shop" }));
    expect(within(rowOf("Deploy")).queryByRole("switch")).toBeNull();
  });

  it("History restores an older text", async () => {
    const c = await openMemory();
    fireEvent.click(screen.getByText("Tabs, not spaces"));
    expect(await screen.findByText("Tabs, width 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(openFile).toHaveBeenCalledWith("/d/memory/you/tabs.md");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const older = (await screen.findByText("You")).closest(".srow") as HTMLElement;
    expect(older.textContent).toContain("Mon");
    expect(screen.getByText("Docs pass").closest(".srow")?.querySelector("button")).toBeNull();
    fireEvent.click(within(older).getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(c.call).toHaveBeenCalledWith("memory.write", {
        path: "you/tabs.md",
        text: "Tabs",
        expect: "h-13",
      }),
    );
    // Forget asks inline first.
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(screen.getByText("Forget “Tabs, not spaces”?")).toBeTruthy();
    const ask = screen.getByText("Forget “Tabs, not spaces”?").closest(".srow") as HTMLElement;
    await act(async () => fireEvent.click(within(ask).getByRole("button", { name: "Forget" })));
    expect(c.call).toHaveBeenCalledWith("memory.forget", { memoryId: "you/tabs.md" });
  });

  it("to-dos show due dates and close", async () => {
    const c = await openMemory();
    fireEvent.click(screen.getByRole("button", { name: "To-dos" }));
    await screen.findByText("Renew the passport");
    const names = [...document.querySelectorAll(".trow .tname")].map((n) => n.textContent);
    expect(names).toEqual(["File the tax return", "Renew the passport", "Send the visa form"]);
    expect(rowOf("File the tax return").textContent).toContain("Overdue");
    expect(rowOf("Renew the passport").textContent).toContain("Due today");
    expect(rowOf("Send the visa form").textContent).toContain("Due Friday");
    // Done ones are folded.
    expect(screen.queryByText("Book the dentist")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Done · 1/ }));
    expect(screen.getByText("Book the dentist")).toBeTruthy();
    fireEvent.click(within(rowOf("Renew the passport")).getByRole("button", { name: "Done" }));
    expect(c.call).toHaveBeenCalledWith("todo.done", { name: "you/passport.md" });
  });

  // ion chief's count and a chat's "Added to your to-dos" open Settings at the to-dos.
  it("opens at the to-dos from a link", async () => {
    render(<Settings client={memoryClient()} onOpenIon={() => {}} at={{ kind: "todos" }} />);
    expect(await screen.findByText("Renew the passport")).toBeTruthy();
    expect(screen.getByRole("button", { name: "To-dos" }).className).toBe("on");
  });
});
