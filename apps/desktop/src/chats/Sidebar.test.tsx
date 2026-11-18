// @vitest-environment jsdom
import type { ChatInfo, NeedInfo, ProjectInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Sidebar } from "./Sidebar.js";

afterEach(cleanup);

const chat = (chatId: string, projectId: string, o: Partial<ChatInfo> = {}): ChatInfo => ({
  chatId,
  title: chatId,
  projectId,
  branch: `ion/${chatId}`,
  archived: false,
  lastRunStatus: "done",
  lastActivityAt: "2026-11-18T10:00:00.000Z",
  preview: null,
  ...o,
});
const projects: ProjectInfo[] = [
  { id: "storefront", starred: false },
  { id: "payments-api", starred: false },
] as ProjectInfo[];

const side = (chats: ChatInfo[], needs: NeedInfo[] = []) =>
  render(<Sidebar chats={chats} needs={needs} projects={projects} open={null} onOpen={() => {}} />);

// UX tour: your chats told apart by project, each row using its space.
describe("Sidebar", () => {
  it("groups chats by project under All projects, the most recently active first", () => {
    const { container } = side([
      chat("a", "storefront", { lastActivityAt: "2026-11-18T09:00:00.000Z" }),
      chat("b", "payments-api", { lastActivityAt: "2026-11-18T11:00:00.000Z" }),
      chat("c", "storefront", { lastActivityAt: "2026-11-18T10:00:00.000Z" }),
    ]);
    const groups = [...container.querySelectorAll(".grp")].map((g) => ({
      label: g.querySelector(".gl")?.textContent,
      rows: [...g.querySelectorAll(".r .tt")].map((t) => t.textContent),
    }));
    expect(groups).toEqual([
      { label: "payments-api", rows: ["b"] },
      { label: "storefront", rows: ["c", "a"] },
    ]);
  });

  it("shows one list for a picked project", () => {
    const { container } = side([chat("a", "storefront"), chat("b", "payments-api")]);
    fireEvent.click(container.querySelector(".proj")!);
    fireEvent.click(screen.getByRole("button", { name: /^storefront/ }));
    expect([...container.querySelectorAll(".gl")].map((g) => g.textContent)).toEqual(["Chats"]);
    expect([...container.querySelectorAll(".r .tt")].map((t) => t.textContent)).toEqual(["a"]);
  });

  it("shows the start of the agent's last reply under the title", () => {
    const { container } = side([chat("a", "storefront", { preview: "Added notes.md." })]);
    expect(container.querySelector(".r .sub")?.textContent).toBe("Added notes.md.");
  });

  it("marks a chat whose last run failed or was stopped, and leaves your chats without an avatar", () => {
    const { container } = side([
      chat("a", "storefront", { lastRunStatus: "failed" }),
      chat("b", "storefront", { lastRunStatus: "interrupted" }),
      chat("c", "storefront"),
    ]);
    const mark = (title: string) =>
      [...container.querySelectorAll(".r")]
        .find((r) => r.querySelector(".tt")?.textContent === title)
        ?.querySelector(".st")
        ?.getAttribute("aria-label") ?? null;
    expect([mark("a"), mark("b"), mark("c")]).toEqual(["Failed", "Stopped", null]);
    expect(container.querySelector(".r canvas")).toBeNull();
  });
});
