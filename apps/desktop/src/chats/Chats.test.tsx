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
  it("opens a plain chat (in default) with the side panel closed but its toggle there, a project chat with it open", async () => {
    const both = client([chat("p", "default"), chat("c", "storefront")], ["p", "c"]);
    const { container, rerender } = render(<Chats client={both} openId="p" setOpenId={() => {}} />);
    await screen.findAllByText("p");
    expect(container.querySelector(".split.solo")).not.toBeNull();
    expect(container.querySelector(".tools")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(container.querySelector(".tools")).not.toBeNull();
    rerender(<Chats client={both} openId="c" setOpenId={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tools")).not.toBeNull());
  });
  // UX tour: an empty side panel was 400 px of nothing; it opens when the chat has changed something.
  it("keeps a project chat's panel closed until it has changes", async () => {
    const c = client([chat("c", "storefront")]);
    const { container } = render(<Chats client={c} openId="c" setOpenId={() => {}} />);
    await screen.findAllByText("c");
    await waitFor(() => expect(c.call).toHaveBeenCalledWith("chat.diff", { chatId: "c" }));
    expect(container.querySelector(".tools")).toBeNull();
    expect(screen.getByRole("button", { name: "Show changes" })).toBeTruthy();
  });
});
