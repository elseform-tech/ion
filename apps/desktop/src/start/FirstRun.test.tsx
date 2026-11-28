// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import { ApiCallError } from "@ion/client/browser";
import type { AgentStep, ChatInfo, HarnessInfo, ProjectInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chats } from "../chats/Chats.js";
import { Composer } from "../chats/Composer.js";
import { AgentSteps } from "./AgentSteps.js";
import { FirstAnswer } from "./FirstAnswer.js";
import { AddFolder, PickFolder } from "./PickFolder.js";

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
  steps?: AgentStep[];
  harnesses?: HarnessInfo[];
  projects?: ProjectInfo[];
  chats?: ChatInfo[];
}) {
  const call = vi.fn(async (cmd: string, _a?: unknown): Promise<unknown> => {
    if (cmd === "start.status")
      return {
        agents: o.steps ?? [],
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
  // Review of Plan 21 Task 2, 2026-11-23: the app worked out each agent's step itself (a copy of the daemon's); the
  // rows come from start.status now.
  it("an agent that isn't signed in shows its sign-in command", async () => {
    const steps: AgentStep[] = [
      { id: "opencode", label: "opencode", state: "install", command: "npm i -g opencode-ai" },
      { id: "grok-build", label: "Grok Build", state: "signIn", command: "grok login", inApp: true },
    ];
    const c = ion({ firstRun: true, steps });
    const bare = [{ ...opencode, install: undefined }, grok] as HarnessInfo[];
    render(<AgentSteps client={c} harnesses={bare} />);
    expect(await screen.findByText("grok login")).toBeTruthy();
    expect(screen.getByText("Sign in:")).toBeTruthy();
    // ion can run Grok's own sign-in (Plan 20/#35): its button, beside the command to copy.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText("npm i -g opencode-ai")).toBeTruthy();
    expect(screen.getByText("Install:")).toBeTruthy();
  });

  // The tour, 2026-11-23: while a fresh ion read its agents (30 s for opencode), "Your agents" was an empty box.
  it("says it's checking while the agents are read, never an empty box", () => {
    const { container } = render(<AgentSteps client={ion({ firstRun: true })} harnesses={[]} />);
    expect(screen.getByText("Checking your agents")).toBeTruthy();
    expect(container.querySelector(".fagents")).toBeNull();
  });

  it("Check again reads every agent again now", async () => {
    const c = ion({ firstRun: true });
    const onReload = vi.fn();
    render(<AgentSteps client={c} harnesses={[opencode]} onReload={onReload} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(c.call).toHaveBeenCalledWith("start.status", { fresh: true }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it("no ready agent: the message box waits with what to do", async () => {
    const c = ion({
      firstRun: false,
      steps: [
        { id: "opencode", label: "opencode", state: "install", command: "npm i -g opencode-ai" },
        { id: "grok-build", label: "Grok Build", state: "signIn", command: "grok login", inApp: true },
      ],
    });
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
    expect(await screen.findByText("npm i -g opencode-ai")).toBeTruthy();
    expect(screen.getByText("grok login")).toBeTruthy();
  });
});

// Plan 21 audit, 2026-11-23: the app couldn't add your own folder, and new chats went to ion's empty `default`.
describe("your folder", () => {
  // Review of Plan 21 Task 2, 2026-11-23 (a security scan, HIGH): git was set up without asking. ion asks first, says
  // it's working while it does, and says how many files went in and that some were left out. Plan 21 Task 6 tour
  // (2026-11-28): once done, "Set up git here: …" read like the question again; it says it's done ("Git set up: …").
  it("picking a non-git folder sets up git and says so, once you say yes", async () => {
    let done: (v: unknown) => void = () => {};
    const add = vi.fn((_path: string, confirm?: boolean) =>
      confirm
        ? new Promise((r) => {
            done = r;
          })
        : Promise.reject(new ApiCallError("confirm", "Set up git here? ion makes a first commit of 2 files")),
    );
    const onAdded = vi.fn();
    render(<PickFolder add={add as never} onAdded={onAdded} />);
    const box = screen.getByRole("textbox", { name: "Folder" });
    fireEvent.change(box, { target: { value: "/Users/me/tip-calc" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("Set up git here? ion makes a first commit of 2 files")).toBeTruthy();
    expect(onAdded).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Set up git" }));
    expect(await screen.findByText("Setting up git…")).toBeTruthy();
    expect(add).toHaveBeenLastCalledWith("/Users/me/tip-calc", true);
    done({ id: "tip-calc", path: "/Users/me/tip-calc", starred: false, gitSetUp: { files: 2, left: 1 } });
    expect(
      await screen.findByText(
        "Git set up: 2 files in its first commit, 1 left out (secrets, dependencies, build output, big files)",
      ),
    ).toBeTruthy();
    expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: "tip-calc" }));
  });

  // The tour, review of Plan 21 Task 2, 2026-11-23: in the project menu, the git-setup line never showed: the path box
  // came back in its place.
  it("the project menu's Add folder says what it set up", async () => {
    const add = vi.fn((_p: string, confirm?: boolean) =>
      confirm
        ? Promise.resolve({ id: "big", path: "/b", starred: false, gitSetUp: { files: 1, left: 2 } })
        : Promise.reject(new ApiCallError("confirm", "Set up git here? ion makes a first commit of 1 file")),
    );
    render(<AddFolder add={add as never} onAdded={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    const box = screen.getByRole("textbox", { name: "Folder" });
    fireEvent.change(box, { target: { value: "/b" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Set up git" }));
    expect(
      await screen.findByText(
        "Git set up: 1 file in its first commit, 2 left out (secrets, dependencies, build output, big files)",
      ),
    ).toBeTruthy();
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

// Review of Plan 21 Task 2, 2026-11-23: the "ion keeps notes" line showed on every visit to your only chat, and to
// people upgrading with one chat. It shows once, after a first run's first answer.
describe("after the first answer", () => {
  it("the memory line shows once: it goes when you leave the chat", async () => {
    const onSeen = vi.fn();
    const { unmount } = render(<FirstAnswer client={ion({ firstRun: false })} onSeen={onSeen} />);
    expect(await screen.findByText("ion keeps notes as you work")).toBeTruthy();
    expect(onSeen).not.toHaveBeenCalled();
    unmount();
    expect(onSeen).toHaveBeenCalledTimes(1);
  });

  it("an existing user with one chat never sees it", async () => {
    const chats = [chat("a", "shop", "2026-11-18T10:00:00.000Z")];
    const projects = [{ id: "shop", path: "/p/shop", starred: false }];
    render(<Chats client={ion({ firstRun: false, chats, projects })} openId="a" setOpenId={() => {}} />);
    await screen.findAllByText("a");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("ion keeps notes as you work")).toBeNull();
  });
});
