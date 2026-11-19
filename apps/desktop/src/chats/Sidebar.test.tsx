// @vitest-environment jsdom
import type { ChatInfo, IonInfo, NeedInfo, ProjectInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  by: null,
  ...o,
});
const projects: ProjectInfo[] = [
  { id: "storefront", starred: false },
  { id: "payments-api", starred: false },
] as ProjectInfo[];

const acts = () => ({
  onNewProject: vi.fn(async (name: string) => name),
  onRename: vi.fn(),
  onArchive: vi.fn(),
  onStar: vi.fn(),
  onRenameProject: vi.fn(),
  onRemoveProject: vi.fn(),
});
const ions: IonInfo[] = [
  {
    ionId: "storefront",
    name: "storefront",
    color: "#ED712E",
    harness: "fake",
    last: null,
    needs: 0,
    working: false,
    thinking: false,
    starred: false,
  },
];
const side = (chats: ChatInfo[], needs: NeedInfo[] = [], a = acts()) =>
  render(
    <Sidebar
      chats={chats}
      needs={needs}
      projects={projects}
      ions={ions}
      open={null}
      onOpen={() => {}}
      {...a}
    />,
  );

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
  // Plan 09: a thread ion started shows its project's ion in the first slot; yours stay empty.
  it("shows the project's ion beside a thread ion started", () => {
    const { container } = side([chat("t1", "storefront", { by: "ion" }), chat("c1", "storefront")]);
    const row = (title: string) =>
      [...container.querySelectorAll(".r")].find((r) => r.querySelector(".tt")?.textContent === title);
    expect(row("t1")?.querySelector("canvas")).not.toBeNull();
    expect(row("c1")?.querySelector("canvas")).toBeNull();
  });
  // The user, 2026-11-18: the sidebar keeps open the projects you watch (starred); the rest start folded.
  it("keeps starred projects open and first, folds the rest, and stars from the group", () => {
    const a = acts();
    const starred = [
      { id: "storefront", starred: false },
      { id: "payments-api", starred: true },
    ] as ProjectInfo[];
    const { container } = render(
      <Sidebar
        chats={[
          chat("a", "storefront"),
          chat("b", "payments-api", { lastActivityAt: "2026-11-18T09:00:00.000Z" }),
        ]}
        needs={[]}
        projects={starred}
        ions={ions}
        open={null}
        onOpen={() => {}}
        {...a}
      />,
    );
    const groups = [...container.querySelectorAll(".grp")];
    expect(groups.map((g) => g.querySelector(".gfold")?.textContent)).toEqual(["payments-api", "storefront"]);
    expect(groups.map((g) => g.querySelectorAll(".rw").length)).toEqual([1, 0]);
    fireEvent.click(screen.getByRole("button", { name: "Star storefront" }));
    expect(a.onStar).toHaveBeenCalledWith("storefront", true);
    fireEvent.click(screen.getByRole("button", { name: "Unstar payments-api" }));
    expect(a.onStar).toHaveBeenCalledWith("payments-api", false);
  });

  // With nothing starred, nothing is folded: a new user sees their chats.
  it("folds nothing while no project is starred", () => {
    const { container } = side([chat("a", "storefront"), chat("b", "payments-api")]);
    expect([...container.querySelectorAll(".grp")].map((g) => g.querySelectorAll(".rw").length)).toEqual([
      1, 1,
    ]);
  });
  // The user, 2026-11-19: rename and remove a project from its group; a renamed project shows its name.
  it("renames a project from its group, and shows the new name", () => {
    const a = acts();
    const named = [{ id: "storefront", starred: false, name: "Shop" }] as ProjectInfo[];
    const { container } = render(
      <Sidebar
        chats={[chat("a", "storefront")]}
        needs={[]}
        projects={named}
        ions={ions}
        open={null}
        onOpen={() => {}}
        {...a}
      />,
    );
    expect(container.querySelector(".grp .gfold")?.textContent).toBe("Shop");
    fireEvent.click(screen.getByRole("button", { name: "More for Shop" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const box = screen.getByLabelText("Project name");
    fireEvent.change(box, { target: { value: "Storefront" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(a.onRenameProject).toHaveBeenCalledWith("storefront", "Storefront");
  });

  it("removes a project only after you confirm", () => {
    const a = acts();
    side([chat("a", "storefront")], [], a);
    fireEvent.click(screen.getByRole("button", { name: "More for storefront" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(a.onRemoveProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove storefront" }));
    expect(a.onRemoveProject).toHaveBeenCalledWith("storefront");
  });

  it("has no menu for default", () => {
    side([chat("a", "default")]);
    expect(screen.queryByRole("button", { name: "More for default" })).toBeNull();
  });
  // The user, 2026-11-19: "create project is not working": a refusal showed nowhere, and a new project (no chats
  // yet) showed nowhere either. Now the refusal shows under the box, and a new project opens with a new chat.
  it("shows why a new project was refused, and opens one that was made", async () => {
    const a = acts();
    a.onNewProject
      .mockRejectedValueOnce(new Error("A project named shop already exists"))
      .mockResolvedValueOnce("shop");
    const onOpen = vi.fn();
    const { container } = render(
      <Sidebar chats={[]} needs={[]} projects={projects} ions={ions} open={null} onOpen={onOpen} {...a} />,
    );
    fireEvent.click(container.querySelector(".shead .proj")!);
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const box = screen.getByLabelText("Project name");
    fireEvent.change(box, { target: { value: "Shop" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("A project named shop already exists")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Project name"), { key: "Enter" });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(null));
    expect(container.querySelector(".shead .projLbl")?.textContent).toBe("shop");
  });
});
