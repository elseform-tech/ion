// @vitest-environment jsdom
import { ApiCallError, type IonClient } from "@ion/client/browser";
import type { DreamInfo, MemoryChangeInfo, MemoryFileInfo, MemoryInfo } from "@ion/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFile } from "../opener.js";
import { Settings } from "./Settings.js";
import { settings } from "./testing.js";

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
type MemoryClientOpts = {
  text?: string;
  refuse?: string;
  dream?: { tidied: DreamInfo; files: MemoryInfo[] };
};

function memoryClient(o: MemoryClientOpts = {}) {
  const all = [...FILES, ...(o.dream?.files ?? [])];
  const dreamAnswer = (cmd: string) => {
    if (cmd === "memory.tidied") return o.dream?.tidied ?? null;
    if (cmd === "settings.get") return o.dream ? settings : null;
    return [{ id: "grok-build", label: "Grok", installed: true, signedIn: true, models: [] }];
  };
  const answer = async (cmd: string, a: Record<string, unknown>) => {
    if (["memory.tidied", "settings.get", "harnesses.list"].includes(cmd)) return dreamAnswer(cmd);
    if (cmd === "projects.list") return [{ id: "shop", name: "Shop", path: "/p/shop", starred: true }];
    if (cmd === "ions.list")
      return [{ ionId: "chief", name: "ion", color: null, harness: null, last: null, needs: 0 }];
    if (cmd === "memory.list") return a.type === "todo" ? all.filter((f) => f.type === "todo") : all;
    if (cmd === "memory.search")
      return FILES.filter((f) => f.name.toLowerCase().includes(String(a.q).toLowerCase()));
    if (cmd === "memory.folder") return { path: "/d/memory", problems: ["shop/notes.md can't be read"] };
    if (cmd === "memory.read") {
      const m = FILES.find((f) => f.memoryId === a.name)!;
      return read(m, m.memoryId === "you/tabs.md" ? (o.text ?? "Tabs, width 2") : m.text);
    }
    if (cmd === "memory.history") return HISTORY;
    if (cmd === "memory.write" || cmd === "todo.done") return FILES[0];
    return [];
  };
  const call = vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    if (cmd === "memory.write" && o.refuse) throw new ApiCallError("invalid", o.refuse);
    return answer(cmd, a);
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
    // Task review, 2026-11-22: search asks for the scope picked (the daemon keeps its best 20), once typing pauses.
    fireEvent.change(screen.getByLabelText("Search memory"), { target: { value: "sa" } });
    fireEvent.change(screen.getByLabelText("Search memory"), { target: { value: "sam" } });
    expect(c.call.mock.calls.some(([cmd]) => cmd === "memory.search")).toBe(false);
    await waitFor(() => expect(screen.queryByText("Tabs, not spaces")).toBeNull());
    expect(c.call).toHaveBeenCalledWith("memory.search", { q: "sam", scope: "you" });
    expect(c.call.mock.calls.filter(([cmd]) => cmd === "memory.search")).toHaveLength(1);
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
    // Task review, 2026-11-22: a bare switch said nothing of what it shares; an icon named on hover comes before it.
    expect(sw.closest(".msee")?.getAttribute("title")).toBe("Shared with chats");
    expect(sw.closest(".msee")?.querySelector("svg")).not.toBeNull();
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

  // Task 5, 2026-11-22 (tour): a chat's "Suggested for every project" line opens Memory at your files, where Keep is.
  it("opens at your files from a chat's suggestion", async () => {
    render(<Settings client={memoryClient()} onOpenIon={() => {}} at={{ kind: "memory" }} />);
    expect(await screen.findByText("Tabs, not spaces")).toBeTruthy();
    expect(screen.getByRole("button", { name: "To-dos" }).className).not.toBe("on");
  });

  // Task review, 2026-11-22: an image in a memory file is never fetched (it could be a tracker): its words only.
  it("shows an image in a file as its words, never loads it", async () => {
    await openMemory(memoryClient({ text: "Tabs ![a tracker](http://t.example/p.png)" }));
    fireEvent.click(screen.getByText("Tabs, not spaces"));
    expect(await screen.findByText("a tracker")).toBeTruthy();
    expect(document.querySelector(".mtext img")).toBeNull();
  });

  // Task review, 2026-11-22: a Restore refused because the file changed meanwhile left the old text and history up.
  it("reads the file and its history again when Restore is refused", async () => {
    const c = await openMemory(memoryClient({ refuse: "Changed since you read it" }));
    fireEvent.click(screen.getByText("Tabs, not spaces"));
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    const older = (await screen.findByText("You")).closest(".srow") as HTMLElement;
    const reads = () => c.call.mock.calls.filter(([cmd]) => cmd === "memory.read").length;
    const before = reads();
    fireEvent.click(within(older).getByRole("button", { name: "Restore" }));
    expect(await screen.findByText("Changed since you read it")).toBeTruthy();
    await waitFor(() => expect(reads()).toBe(before + 1));
    expect(c.call.mock.calls.filter(([cmd]) => cmd === "memory.history")).toHaveLength(2);
  });
});

// The user, 2026-11-22: "could we also have a 'dream' setting to allow active harness to manage stale information and
// update memory" → ion tidies memory overnight. Settings → Memory turns it on, marks what it changed for a day, and
// brings back a file it forgot.
describe("ion's dream in Memory", () => {
  it("Dream turns on, a file it changed says so for a day, and a file it forgot comes back", async () => {
    const tidied: DreamInfo = {
      ...{ at: ago(5), merged: 0, updated: 1, forgot: 1, moved: 0, notes: [] },
      forgotten: [{ path: "you/old-launch.md", name: "Old launch" }],
    };
    const files = [
      file({ memoryId: "you/node.md", name: "Node version", source: "ion:_dream", writtenAt: ago(5) }),
      file({ memoryId: "you/older.md", name: "Older tidy", source: "ion:_dream", writtenAt: ago(30) }),
    ];
    const c = await openMemory(memoryClient({ dream: { tidied, files } }));
    fireEvent.click(await screen.findByRole("button", { name: "Nightly" }));
    expect(c.call).toHaveBeenCalledWith("settings.set", { patch: { dream: { mode: "nightly" } } });
    expect(within(rowOf("Node version")).getByText("Tidied by ion")).toBeTruthy();
    expect(within(rowOf("Node version")).getByText(/ion \(dream\)/)).toBeTruthy();
    expect(within(rowOf("Older tidy")).queryByText("Tidied by ion")).toBeNull();
    const gone = (await screen.findByText(/Old launch/)).closest(".srow") as HTMLElement;
    fireEvent.click(within(gone).getByRole("button", { name: "Restore" }));
    expect(c.call).toHaveBeenCalledWith("memory.restore", { path: "you/old-launch.md" });
  });
});
