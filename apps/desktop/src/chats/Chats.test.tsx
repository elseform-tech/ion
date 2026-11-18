// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { ChatInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chats } from "./Chats.js";

afterEach(cleanup);

const chat = (chatId: string, projectId: string): ChatInfo => ({
  chatId,
  title: chatId,
  projectId,
  branch: `ion/${chatId}`,
  archived: false,
  lastRunStatus: "done",
  lastActivityAt: "2026-11-18T10:00:00.000Z",
  preview: null,
});
const changed = { files: [{ path: "a.ts", added: 1, removed: 0, patch: "@@ -0,0 +1 @@\n+x\n" }] };
/** ion's answers: these chats, and changes only in chats named in `withChanges`. */
const reply =
  (chats: ChatInfo[], withChanges: string[] = []) =>
  async (cmd: string, a?: { chatId?: string }) => {
    if (cmd === "chats.list") return chats;
    if (cmd !== "chat.diff") return [];
    return withChanges.includes(a?.chatId ?? "") ? changed : { files: [] };
  };

const client = (chats: ChatInfo[], withChanges: string[] = []) =>
  ({
    call: vi.fn(reply(chats, withChanges)),
    subscribe: vi.fn(async () => () => {}),
  }) as unknown as IonClient;

// Plan 08: the lab's new chat and plain chat.
describe("Chats", () => {
  it("opens a new chat as the lab's .empty: its heading and the big message box", () => {
    const { container } = render(<Chats client={client([])} openId={null} setOpenId={() => {}} />);
    expect(container.querySelector(".empty h3")?.textContent).toBe("What are we working on?");
    expect(container.querySelector(".empty .cbox.big")).not.toBeNull();
  });

  // Security review: a plain chat can still change files, so its panel is closed, not gone.
  // The user, 2026-11-18: the side panel starts closed, even when a chat has changes; once you open it, it stays
  // open as you switch chats.
  it("keeps the side panel closed until you open it, then open across chats", async () => {
    const c = client([chat("a", "storefront"), chat("b", "storefront")], ["a", "b"]);
    const { container, rerender } = render(<Chats client={c} openId="a" setOpenId={() => {}} />);
    await screen.findAllByText("a");
    await waitFor(() => expect(c.call).toHaveBeenCalledWith("chat.diff", { chatId: "a" }));
    expect(container.querySelector(".tools")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    await waitFor(() => expect(container.querySelector(".tools")).not.toBeNull());
    rerender(<Chats client={c} openId="b" setOpenId={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tools")).not.toBeNull());
  });

  it("makes a project, renames and archives chats through ion", async () => {
    const c = client([chat("a", "storefront")]);
    const { container } = render(<Chats client={c} openId={null} setOpenId={() => {}} />);
    await screen.findAllByText("a");
    fireEvent.click(container.querySelector(".proj")!);
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const box = screen.getByLabelText("Project name");
    fireEvent.change(box, { target: { value: "billing" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(c.call).toHaveBeenCalledWith("project.create", { name: "billing" });
    fireEvent.click(screen.getByRole("button", { name: "More for a" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(c.call).toHaveBeenCalledWith("chat.archive", { chatId: "a" });
  });
  // UX tour: a new chat showed nothing while ion made it; your message and a starting word show at once.
  it("shows your message at once in a new chat while ion makes it", async () => {
    const c = client([]);
    const fake = {
      id: "fake",
      label: "Fake",
      installed: true,
      signedIn: true,
      models: [],
      defaultModel: null,
    };
    vi.mocked(c.call).mockImplementation(async (cmd: string) => {
      if (cmd === "harnesses.list") return [fake];
      if (cmd === "ask") return new Promise(() => {});
      return [];
    });
    const { container } = render(<Chats client={c} openId={null} setOpenId={() => {}} />);
    await waitFor(() => expect(container.querySelector(".bpill")?.textContent).toBe("Fake"));
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "Fix the totals" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(container.querySelector(".msgs .u")?.textContent).toBe("Fix the totals");
    expect(container.querySelector(".msgs .pending")).not.toBeNull();
  });
});
