// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { ChatInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
const reply = (chats: ChatInfo[]) => async (cmd: string) => {
  if (cmd === "chats.list") return chats;
  return cmd === "chat.diff" ? { files: [] } : [];
};

const client = (chats: ChatInfo[]) =>
  ({
    call: vi.fn(reply(chats)),
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
    const both = client([chat("p", "default"), chat("c", "storefront")]);
    const { container, rerender } = render(<Chats client={both} openId="p" setOpenId={() => {}} />);
    await screen.findAllByText("p");
    expect(container.querySelector(".split.solo")).not.toBeNull();
    expect(container.querySelector(".tools")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(container.querySelector(".tools")).not.toBeNull();
    rerender(<Chats client={both} openId="c" setOpenId={() => {}} />);
    expect(container.querySelector(".tools")).not.toBeNull();
  });
});
