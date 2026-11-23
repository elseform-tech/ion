// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { ChatInfo, HarnessInfo, ProjectInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chats } from "../chats/Chats.js";
import { Composer } from "../chats/Composer.js";
import { AgentSteps } from "./AgentSteps.js";
import { PickFolder } from "./PickFolder.js";

afterEach(cleanup);

const agent = (o: Partial<HarnessInfo> & { id: string; label: string }): HarnessInfo => ({
  installed: false,
  signedIn: false,
  models: [],
  defaultModel: null,
  ...o,
});
const opencode = agent({ id: "opencode", label: "opencode", install: "npm i -g opencode-ai" });
const grok = agent({
  id: "grok-build",
  label: "Grok Build",
  installed: true,
  install: "npm i -g @xai-official/grok",
  signIn: { command: "grok login", inApp: true },
});
const ready = { ...grok, signedIn: true };

const chat = (chatId: string, projectId: string, at: string): ChatInfo => ({
  chatId,
  title: chatId,
  projectId,
  branch: `ion/${chatId}`,
  archived: false,
  lastRunStatus: "done",
  lastActivityAt: at,
  preview: null,
  by: null,
});

/** ion: a first run or not, these agents, projects and chats; every other call answers nothing. */
function ion(o: {
  firstRun: boolean;
  harnesses?: HarnessInfo[];
  projects?: ProjectInfo[];
  chats?: ChatInfo[];
}) {
  const call = vi.fn(async (cmd: string, _a?: unknown): Promise<unknown> => {
    if (cmd === "start.status")
      return {
        agents: [],
        projects: o.projects?.length ?? 0,
        chats: o.chats?.length ?? 0,
        firstRun: o.firstRun,
      };
    if (cmd === "harnesses.list") return o.harnesses ?? [ready];
    if (cmd === "projects.list") return o.projects ?? [];
    if (cmd === "chats.list") return o.chats ?? [];
    if (cmd === "settings.get") return {};
    return [];
  });
  return { call, subscribe: vi.fn(async () => () => {}) } as unknown as IonClient & { call: typeof call };
}

// Plan 21 (the user, 2026-11-22: "if that makes the product even easier to use even for beginners"). Plan 21 audit,
// 2026-11-23: a brand-new ion opened on an empty chat box in ion's empty `default` project, with no sign of which
// agents were ready and no way to add your own folder from the app.
describe("the first run", () => {
  it("first run shows only with no projects and no chats", async () => {
    render(<Chats client={ion({ firstRun: true })} openId={null} setOpenId={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Start here" })).toBeTruthy();
    expect(screen.getByText("Your agents")).toBeTruthy();
    expect(screen.getAllByText("Pick a folder").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Message")).toBeTruthy();
    // Three first messages; one fills the box.
    fireEvent.click(screen.getByRole("button", { name: "What does this project do?" }));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(
      "What does this project do?",
    );
    // The tour, 2026-11-23: focus stayed on the picked message, so Enter picked it again instead of sending.
    expect(document.activeElement).toBe(screen.getByLabelText("Message"));
  });

  it("an existing user never sees it", async () => {
    const c = ion({ firstRun: false, chats: [chat("a", "default", "2026-11-18T10:00:00.000Z")] });
    render(<Chats client={c} openId={null} setOpenId={() => {}} />);
    await waitFor(() => expect(c.call).toHaveBeenCalledWith("start.status", {}));
    expect(screen.queryByRole("heading", { name: "Start here" })).toBeNull();
    expect(screen.getByRole("heading", { name: "What are we working on?" })).toBeTruthy();
  });
});

// Plan 21 audit, 2026-11-23: with no agent ready, Send stayed grey with no reason, and the agent picker said only "Not
// installed", with no way to install one.
describe("your agents on the first run", () => {
  it("an agent that isn't signed in shows its sign-in command", () => {
    const c = ion({ firstRun: true });
    render(<AgentSteps client={c} harnesses={[opencode, grok]} onCheck={() => {}} />);
    expect(screen.getByText("grok login")).toBeTruthy();
    expect(screen.getByText("Sign in:")).toBeTruthy();
    // ion can run Grok's own sign-in (Plan 20/#35): its button, beside the command to copy.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText("npm i -g opencode-ai")).toBeTruthy();
    expect(screen.getByText("Install:")).toBeTruthy();
  });

  // The tour, 2026-11-23: while a fresh ion read its agents (30 s for opencode), "Your agents" was an empty box.
  it("says it's checking while the agents are read, never an empty box", () => {
    const { container } = render(
      <AgentSteps client={ion({ firstRun: true })} harnesses={[]} onCheck={() => {}} />,
    );
    expect(screen.getByText("Checking your agents")).toBeTruthy();
    expect(container.querySelector(".fagents")).toBeNull();
  });

  it("Check again reads every agent again now", async () => {
    const onCheck = vi.fn();
    render(<AgentSteps client={ion({ firstRun: true })} harnesses={[opencode]} onCheck={onCheck} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onCheck).toHaveBeenCalled();
  });

  it("no ready agent: the message box waits with what to do", () => {
    const c = ion({ firstRun: false });
    render(
      <Composer
        client={c}
        harnesses={[opencode, grok]}
        to={{ projectId: null }}
        running={null}
        onSent={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("No agent is ready")).toBeTruthy();
    expect(screen.getByText("npm i -g opencode-ai")).toBeTruthy();
    expect(screen.getByText("grok login")).toBeTruthy();
  });
});

// Plan 21 audit, 2026-11-23: the app couldn't add your own folder, and new chats went to ion's empty `default`.
describe("your folder", () => {
  it("picking a non-git folder sets up git and says so", async () => {
    const c = ion({ firstRun: true });
    c.call.mockImplementation(async (cmd: string) =>
      cmd === "projects.add"
        ? { id: "tip-calc", path: "/Users/me/tip-calc", starred: false, gitSetUp: true }
        : [],
    );
    const onAdded = vi.fn();
    render(<PickFolder add={(path) => c.call("projects.add", { path }) as never} onAdded={onAdded} />);
    const box = screen.getByRole("textbox", { name: "Folder" });
    fireEvent.change(box, { target: { value: "/Users/me/tip-calc" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("Set up git here: your files are its first commit")).toBeTruthy();
    expect(c.call).toHaveBeenCalledWith("projects.add", { path: "/Users/me/tip-calc" });
    expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: "tip-calc" }));
  });

  // Plan 21 audit, 2026-11-23: with a real project, a new chat still went to ion's empty `default`, and the first
  // answer was "This project does not do anything yet".
  it("a new chat goes in the project you used last, not default", async () => {
    const projects = [
      { id: "default", path: "/p/default", starred: false },
      { id: "shop", path: "/p/shop", starred: false },
      { id: "site", path: "/p/site", starred: false },
    ];
    const chats = [
      chat("a", "shop", "2026-11-18T10:00:00.000Z"),
      chat("b", "site", "2026-11-19T10:00:00.000Z"),
    ];
    render(<Chats client={ion({ firstRun: false, projects, chats })} openId={null} setOpenId={() => {}} />);
    await waitFor(() =>
      expect((screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement).value).toBe("site"),
    );
  });
});
