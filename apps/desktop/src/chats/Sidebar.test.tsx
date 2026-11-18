// @vitest-environment jsdom
import type { ChatInfo, NeedInfo, ProjectInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const acts = () => ({ onNewProject: vi.fn(), onRename: vi.fn(), onArchive: vi.fn() });
const side = (chats: ChatInfo[], needs: NeedInfo[] = [], a = acts()) =>
  render(<Sidebar chats={chats} needs={needs} projects={projects} open={null} onOpen={() => {}} {...a} />);

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
    fireEvent.click(container.querySelector(".pml button:nth-child(2)")!);
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
  // The user, 2026-11-18: no spinners; a running chat's title shimmers.
  it("shows a running chat's title shimmering, with no spinner", () => {
    const { container } = side([chat("a", "storefront", { lastRunStatus: "running" })]);
    expect(container.querySelector(".spin")).toBeNull();
    expect(container.querySelector(".r .tt.now")?.textContent).toBe("a");
  });

  // The user, 2026-11-18: 20–50 projects: groups fold, and show 5 chats until you ask for more.
  it("shows a project's 5 most recent chats, then the rest on asking", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      chat(`c${i}`, "storefront", { lastActivityAt: `2026-11-18T1${i}:00:00.000Z` }),
    );
    const { container } = side(many);
    expect(container.querySelectorAll(".r .tt")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "2 more" }));
    expect(container.querySelectorAll(".r .tt")).toHaveLength(7);
  });

  it("folds a project's group", () => {
    const { container } = side([chat("a", "storefront"), chat("b", "payments-api")]);
    fireEvent.click(screen.getByRole("button", { name: "storefront" }));
    expect([...container.querySelectorAll(".r .tt")].map((t) => t.textContent)).toEqual(["b"]);
    fireEvent.click(screen.getByRole("button", { name: "storefront" }));
    expect(container.querySelectorAll(".r .tt")).toHaveLength(2);
  });

  // The user, 2026-11-18: add a project, rename or archive a chat, from the sidebar.
  it("makes a new project from the project menu", () => {
    const a = acts();
    const { container } = side([], [], a);
    fireEvent.click(container.querySelector(".proj")!);
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const box = screen.getByLabelText("Project name");
    fireEvent.change(box, { target: { value: "billing" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(a.onNewProject).toHaveBeenCalledWith("billing");
  });

  it("renames or archives a chat from its menu", () => {
    const a = acts();
    side([chat("a", "storefront")], [], a);
    fireEvent.click(screen.getByRole("button", { name: "More for a" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const box = screen.getByLabelText("Chat name") as HTMLInputElement;
    expect(box.value).toBe("a");
    fireEvent.change(box, { target: { value: "Checkout" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(a.onRename).toHaveBeenCalledWith("a", "Checkout");
    fireEvent.click(screen.getByRole("button", { name: "More for a" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(a.onArchive).toHaveBeenCalledWith("a");
  });
});
