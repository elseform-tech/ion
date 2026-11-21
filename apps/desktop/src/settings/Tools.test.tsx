// @vitest-environment jsdom
import { ApiCallError, type IonClient } from "@ion/client/browser";
import { EV, type HarnessInfo, HOOK_EVENTS, type ImportInfo, type ToolsInfo } from "@ion/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFile, openLink } from "../opener.js";
import { Settings } from "./Settings.js";
import { settings } from "./testing.js";

vi.mock("../opener.js", () => ({
  CANT_OPEN: "Couldn't open it",
  openFile: vi.fn(async () => "opened"),
  openLink: vi.fn(async () => {}),
}));

afterEach(() => {
  cleanup();
  vi.mocked(openFile).mockClear();
  vi.mocked(openLink).mockClear();
});

const NAMES = [
  "Before a tool runs",
  "A chat starts",
  "A chat finishes",
  "A chat fails",
  "Something needs you",
  "You answered",
  "A routine ran",
  "A chat is archived",
  "The briefing is posted",
];
const EVENTS = HOOK_EVENTS.map((e, i) => [e, NAMES[i]!] as const);
const FINISHED = HOOK_EVENTS[2];

const agent = (id: string, label: string): HarnessInfo => ({
  id,
  label,
  installed: true,
  signedIn: true,
  models: [],
  defaultModel: null,
});

const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Tools as the daemon reads them: one of each kind of server, a hook on A chat finishes, three skills. */
function info(o: Partial<ToolsInfo> = {}): ToolsInfo {
  return {
    mcpFile: "/home/you/.ion/mcp.json",
    mcp: [
      {
        id: "files",
        name: "files",
        on: true,
        auth: "none",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: [],
        keys: [],
        signedIn: false,
      },
      {
        id: "linear",
        name: "linear",
        on: false,
        new: true,
        auth: "oauth",
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        headers: [],
        keys: [],
        signedIn: false,
        needs: "sign in",
      },
    ],
    leftOut: [],
    hooks: EVENTS.map(([event, name]) => ({
      event,
      name,
      ...(event === "tool.before" ? { builtIn: { name: "Auto-approval" as const } } : {}),
      hooks:
        event === FINISHED
          ? [{ id: "h1", name: "Log", on: true, event, run: "echo done >> /tmp/ion-tour-hooks.log" }]
          : [],
    })),
    skills: [
      {
        id: "~/.claude/skills/release",
        name: "release",
        description: "Release notes from merged pull requests",
        whose: "claude",
        where: "~/.claude/skills/release",
        on: false,
        new: true,
        support: { "claude-code": "ion" },
      },
      {
        id: "~/.codex/skills/a11y",
        name: "a11y",
        description: "Checks changed screens",
        whose: "codex",
        where: "~/.codex/skills/a11y",
        on: false,
        support: { codex: "own" },
      },
    ],
    support: {
      "claude-code": { http: true, stdio: true, skills: true },
      "grok-build": { http: true, stdio: true, skills: false },
    },
    ...o,
  };
}

const NOTHING_TO_IMPORT: ImportInfo = { servers: [], prompts: [], problems: [], skipped: [] };

/** A daemon with Tools: `tools.list` answers `now()` (changed by a test), every change answers it too. */
function toolsClient(now: () => ToolsInfo, answer?: (cmd: string) => Promise<unknown> | undefined) {
  let hear: ((e: { type: string; data: unknown }) => void) | null = null;
  const call = vi.fn(async (cmd: string, _args?: unknown) => {
    const given = answer?.(cmd);
    if (given) return given;
    if (cmd === "tools.importable" || cmd === "tools.dismissImport") return NOTHING_TO_IMPORT;
    if (cmd === "tools.import") return { imported: [], skipped: [] };
    if (cmd === "settings.get") return settings;
    if (cmd === "harnesses.list")
      return [agent("claude-code", "Claude Code"), agent("grok-build", "Grok Build")];
    if (cmd === "tools.signIn") return { url: "https://auth.example/authorize?x=1" };
    if (cmd.startsWith("tools.")) return now();
    return [];
  });
  const subscribe = vi.fn(async (_o: unknown, f: typeof hear) => {
    hear = f;
    return () => {};
  });
  const emit = (type: string, data: unknown) => act(() => hear?.({ type, data }));
  const client = { call, subscribe } as unknown as IonClient;
  return { client, call, emit };
}

const open = async (c: { client: IonClient }, tab?: "Hooks" | "Skills") => {
  render(<Settings client={c.client} onOpenIon={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Tools" }));
  await screen.findByRole("button", { name: "Connections" });
  if (tab) fireEvent.click(screen.getByRole("button", { name: tab }));
};

const findRow = async (name: string) =>
  (await screen.findByText(name, { selector: ".tname" })).closest(".trow") as HTMLElement;
const row = (name: string) => screen.getByText(name, { selector: ".tname" }).closest(".trow") as HTMLElement;

// The user, 2026-11-20: "connections, adding new mcp required us to follow industry standard… oauth, api-key or some
// kind of login"; "it is better to import custom mcp through a config file rather than on app, but there should be a
// way to access the config file". Connections lists mcp.json, opens it, and signs in; there's no Add form.
describe("Settings → Tools → Connections", () => {
  it("lists servers from the file, opens the file, and shows a broken file plainly", async () => {
    let now = info({ mcpProblem: "mcp.json: line 3 isn't valid JSON" });
    const c = toolsClient(() => now);
    await open(c);
    expect(await screen.findByText("files", { selector: ".tname" })).toBeTruthy();
    expect(within(row("files")).getByText(/npx -y @modelcontextprotocol/)).toBeTruthy();
    expect(within(row("linear")).getByText("mcp.linear.app")).toBeTruthy();
    expect(within(row("linear")).queryByText(/\/mcp/)).toBeNull();
    expect(within(row("linear")).getByText("New")).toBeTruthy();
    expect(screen.getByText("mcp.json: line 3 isn't valid JSON")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Add/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open config file" }));
    expect(openFile).toHaveBeenCalledWith("/home/you/.ion/mcp.json");
    fireEvent.click(within(row("files")).getByRole("switch", { name: "files" }));
    expect(c.call).toHaveBeenCalledWith("tools.setOn", { kind: "mcp", id: "files", on: false });
    // You saved mcp.json in your editor and came back: the list is read again.
    now = info({ mcp: [{ ...info().mcp[0]!, id: "gh", name: "gh" }] });
    fireEvent.focus(window);
    expect(await screen.findByText("gh", { selector: ".tname" })).toBeTruthy();
    expect(screen.queryByText("mcp.json: line 3 isn't valid JSON")).toBeNull();
  });

  it("an OAuth server shows Sign in, then signed in", async () => {
    let now = info();
    const c = toolsClient(() => now);
    await open(c);
    await screen.findByText("linear", { selector: ".tname" });
    fireEvent.click(within(row("linear")).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(openLink).toHaveBeenCalledWith("https://auth.example/authorize?x=1"));
    expect(c.call).toHaveBeenCalledWith("tools.signIn", { id: "linear" });
    const linear = { ...info().mcp[1]!, signedIn: true, on: true } as ToolsInfo["mcp"][number];
    delete linear.needs;
    delete linear.new;
    now = info({ mcp: [info().mcp[0]!, linear] });
    c.emit(EV.toolSignedIn, { id: "linear" });
    await waitFor(() => expect(within(row("linear")).queryByRole("button", { name: "Sign in" })).toBeNull());
    now = info({ mcp: [info().mcp[0]!, { ...linear, needs: "sign in again" }] });
    c.emit(EV.toolNeedsSignIn, { id: "linear" });
    expect(await within(row("linear")).findByRole("button", { name: "Sign in again" })).toBeTruthy();
  });

  it("Add key is masked and never shown again", async () => {
    const keyed = {
      ...info().mcp[1]!,
      id: "search",
      name: "search",
      auth: "apiKey",
      url: "https://search.example/mcp",
      keys: ["TOUR_KEY"],
      missing: ["TOUR_KEY"],
      needs: "key",
    } as ToolsInfo["mcp"][number];
    let now = info({ mcp: [keyed] });
    const c = toolsClient(() => now);
    await open(c);
    await screen.findByText("search", { selector: ".tname" });
    fireEvent.click(within(row("search")).getByRole("button", { name: "Add key" }));
    const box = screen.getByLabelText("TOUR_KEY") as HTMLInputElement;
    expect(box.type).toBe("password");
    fireEvent.change(box, { target: { value: "sk-secret-1" } });
    const k = { ...keyed, needs: undefined, missing: undefined };
    now = info({ mcp: [k as ToolsInfo["mcp"][number]] });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(c.call).toHaveBeenCalledWith("tools.setKey", {
      id: "search",
      name: "TOUR_KEY",
      key: "sk-secret-1",
    });
    await waitFor(() => expect(screen.queryByLabelText("TOUR_KEY")).toBeNull());
    expect(document.body.innerHTML).not.toContain("sk-secret-1");
    expect(within(row("search")).queryByRole("button", { name: "Add key" })).toBeNull();
  });

  // Task review, 2026-11-21 (automated review): the window could open any http page on this computer. Sign-in pages
  // open only over https; a local (http) one shows its address with Copy instead.
  it("a local sign-in page shows its address with Copy, and isn't opened", async () => {
    const local = "http://127.0.0.1:4719/authorize?x=1";
    const c = toolsClient(info, (cmd) =>
      cmd === "tools.signIn" ? Promise.resolve({ url: local }) : undefined,
    );
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    await open(c);
    fireEvent.click(within(await findRow("linear")).getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(local)).toBeTruthy();
    expect(openLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(local);
  });

  // Task review, 2026-11-21: opening the file (or a sign-in page) failed without a word.
  it("says Couldn't open it when the file or page won't open", async () => {
    vi.mocked(openFile).mockResolvedValueOnce("failed");
    vi.mocked(openLink).mockRejectedValueOnce(new Error("no"));
    await open(toolsClient(info));
    fireEvent.click(await screen.findByRole("button", { name: "Open config file" }));
    expect(await screen.findByText("Couldn't open it")).toBeTruthy();
    fireEvent.click(within(row("linear")).getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(within(row("linear").parentElement!).getAllByText("Couldn't open it")).toBeTruthy(),
    );
  });

  // Task review, 2026-11-21: a refused key cleared what you typed, and Enter with no client ID cleared the secret.
  it("keeps what you typed until it's saved", async () => {
    const keyed = { ...info().mcp[1]!, id: "search", name: "search", missing: ["TOUR_KEY"], needs: "key" };
    const c = toolsClient(
      () => info({ mcp: [keyed as ToolsInfo["mcp"][number]] }),
      (cmd) =>
        cmd === "tools.setKey"
          ? Promise.reject(new ApiCallError("invalid", "That key is too long"))
          : undefined,
    );
    await open(c);
    fireEvent.click(within(await findRow("search")).getByRole("button", { name: "Add key" }));
    const box = screen.getByLabelText("TOUR_KEY") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "sk-too-long" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("That key is too long")).toBeTruthy();
    expect((screen.getByLabelText("TOUR_KEY") as HTMLInputElement).value).toBe("sk-too-long");
  });

  it("Enter with no client ID keeps the secret", async () => {
    const c = toolsClient(info, (cmd) =>
      cmd === "tools.signIn"
        ? Promise.reject(
            new ApiCallError("invalid", "This server needs a client ID. Register ion with http://x"),
          )
        : undefined,
    );
    await open(c);
    fireEvent.click(within(await findRow("linear")).getByRole("button", { name: "Sign in" }));
    const secret = (await screen.findByLabelText("Client secret")) as HTMLInputElement;
    fireEvent.change(secret, { target: { value: "s3cret" } });
    fireEvent.keyDown(secret, { key: "Enter" });
    expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe("s3cret");
  });
});

// The user, 2026-11-20: "it should be hooks, showing all available events regardless if we have hooks, and of course,
// auto-approval hook should be listed as built-in, so it cannot be removed"; "hooks do not need a test button".
describe("Settings → Tools → Hooks", () => {
  it("lists every event, and Auto-approval has no switch or remove", async () => {
    await open(
      toolsClient(() => info()),
      "Hooks",
    );
    for (const [, name] of EVENTS) expect(await screen.findByText(name)).toBeTruthy();
    // Tour, 2026-11-21: "Tools" was said twice (the nav and a heading), unlike Shortcuts.
    expect(screen.queryByRole("heading", { name: "Tools" })).toBeNull();
    const auto = row("Auto-approval");
    expect(within(auto).getByText("Built in")).toBeTruthy();
    expect(within(auto).queryByRole("switch")).toBeNull();
    expect(within(auto).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /test/i })).toBeNull();
  });

  it("a hook shows its last result", async () => {
    const hook = info().hooks[2]!.hooks[0]!;
    const three = [
      { ...hook, id: "a", name: "Ran", last: { ok: true, at: ago(2 * MINUTE), code: 0, tail: "" } },
      { ...hook, id: "b", name: "Broke", last: { ok: false, at: ago(MINUTE), code: 1, tail: "no" } },
      { ...hook, id: "c", name: "Slow", last: { ok: false, at: ago(MINUTE), code: null, tail: "" } },
    ];
    const hooks = info().hooks.map((g) => (g.event === FINISHED ? { ...g, hooks: three } : g));
    await open(
      toolsClient(() => info({ hooks })),
      "Hooks",
    );
    expect(await within(row("Ran")).findByText("Ran 2m ago")).toBeTruthy();
    expect(within(row("Broke")).getByText("Failed: exit 1")).toBeTruthy();
    // Tour, 2026-11-21: the last result sat in the 20px agents' column; it's with the switch.
    expect(within(row("Ran")).getByText("Ran 2m ago").closest(".acts2")).toBeTruthy();
    expect(within(row("Slow")).getByText("Took too long")).toBeTruthy();
    expect(within(row("Ran")).getByText("echo done >> /tmp/ion-tour-hooks.log")).toBeTruthy();
  });

  it("adds and removes a hook, and turns one off", async () => {
    const c = toolsClient(() => info());
    await open(c, "Hooks");
    fireEvent.click(await screen.findByRole("button", { name: "Add to A chat fails" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Page me" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "say failed" } });
    fireEvent.keyDown(screen.getByLabelText("Command"), { key: "Enter" });
    expect(c.call).toHaveBeenCalledWith("tools.addHook", {
      name: "Page me",
      event: HOOK_EVENTS[3],
      run: "say failed",
    });
    await waitFor(() => expect(screen.queryByLabelText("Command")).toBeNull());
    fireEvent.click(within(row("Log")).getByRole("switch", { name: "Log" }));
    expect(c.call).toHaveBeenCalledWith("tools.setOn", { kind: "hook", id: "h1", on: false });
    const more = within(row("Log")).getByRole("button", { name: "More for Log" });
    expect(more.getAttribute("title")).toBe("More");
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(c.call).toHaveBeenCalledWith("tools.removeHook", { id: "h1" });
  });
});

// The plan (2026-11-20): Skills are the skills your agents already have; ion passes Claude Code's (on or off), the
// other agents read their own folders.
describe("Settings → Tools → Skills", () => {
  it("skills: Claude Code's have switches, others say Uses its own", async () => {
    const c = toolsClient(() => info());
    await open(c, "Skills");
    expect(await screen.findByText("Release notes from merged pull requests")).toBeTruthy();
    expect(within(row("release")).getByText("New")).toBeTruthy();
    fireEvent.click(within(row("release")).getByRole("switch", { name: "release" }));
    expect(c.call).toHaveBeenCalledWith("tools.setOn", {
      kind: "skill",
      id: "~/.claude/skills/release",
      on: true,
    });
    // Tour, 2026-11-21: Skills named agents in words ("Claude Code") where Connections shows faces. Each ready
    // agent's face now, its name on hover, crossed out where it doesn't use the skill; no word chip.
    const faces = (n: string) =>
      [...row(n).querySelectorAll(".hsup > span")].map((e) => [e.getAttribute("title"), e.className]);
    expect(faces("release")).toEqual([
      ["Claude Code: works", ""],
      ["Grok Build: not supported", "no"],
    ]);
    expect(faces("a11y")).toEqual([
      ["Claude Code: not supported", "no"],
      ["Grok Build: not supported", "no"],
    ]);
    expect(within(row("release")).queryByText("Claude Code")).toBeNull();
    expect(within(row("a11y")).queryByText("Codex")).toBeNull();
    expect(within(row("a11y")).getByText("Uses its own")).toBeTruthy();
    // Tour, 2026-11-21: a long description is clamped to two lines; the whole of it shows on hover.
    const d = screen.getByText("Release notes from merged pull requests");
    expect(d.getAttribute("title")).toBe("Release notes from merged pull requests");
    expect(within(row("a11y")).queryByRole("switch")).toBeNull();
  });
});

// Task 5 review, 2026-11-21: with the keychain locked, ion can't check what you turned on, so everything read
// "Changed" as if its files had changed. It reads Can't check instead.
describe("Settings → Tools with a locked keychain", () => {
  it("a locked keychain reads Can't check, not Changed", async () => {
    const base = info();
    const server = { ...base.mcp[0]!, on: false };
    const hooks = base.hooks.map((g) =>
      g.event === FINISHED ? { ...g, hooks: [{ ...g.hooks[0]!, on: false, changed: true as const }] } : g,
    );
    const skills = [{ ...base.skills[0]!, new: undefined, changed: true as const }];
    const now = info({ keychainProblem: "ion can't read your keychain", mcp: [server], hooks, skills });
    await open(toolsClient(() => now));
    expect(await within(row("files")).findByText("Can't check")).toBeTruthy();
    expect(screen.getByText("ion can't read your keychain")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hooks" }));
    expect(await within(row("Log")).findByText("Can't check")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(await within(row("release")).findByText("Can't check")).toBeTruthy();
    expect(screen.queryByText("Changed")).toBeNull();
  });
});

// The user, 2026-11-21: agents add MCP servers, skills and hooks with ion's commands, "just not auto on"; a row an
// agent added says where it came from and which chat added it.
describe("Settings → Tools: what a chat's agent added", () => {
  const added = () =>
    info({
      mcp: [
        {
          ...(info().mcp[1] as Extract<ToolsInfo["mcp"][number], { transport: "http" }>),
          id: "github",
          name: "github",
          url: "https://api.githubcopilot.com/mcp/",
          origin: {
            // Task review, 2026-11-21: a registry id opens the server's repo, not the registry's JSON.
            source: "io.github.github/github-mcp-server",
            link: "https://github.com/github/github-mcp-server",
            by: "agent",
            chatId: "c7",
            chatTitle: "Add GitHub tools",
            at: ago(MINUTE),
          },
        },
        { ...info().mcp[0]!, origin: { by: "agent", chatId: "c8", at: ago(MINUTE) } },
      ],
    });

  it("an agent-added row shows its source and chat", async () => {
    const c = toolsClient(added);
    await open(c);
    const gh = await findRow("github");
    expect(within(gh).getByText("New")).toBeTruthy();
    expect(within(gh).getByText("Add GitHub tools")).toBeTruthy();
    fireEvent.click(within(gh).getByRole("button", { name: "Source" }));
    expect(openLink).toHaveBeenCalledWith("https://github.com/github/github-mcp-server");
    expect(within(row("files")).getByText("Unknown source")).toBeTruthy();
    expect(within(row("files")).getByText("A chat")).toBeTruthy();
    // A row you added yourself, with no source, says nothing about where it came from.
    expect(within(row("files")).queryByRole("button", { name: "Source" })).toBeNull();
  });

  it("a chat's link opens Settings → Tools at its row", async () => {
    const c = toolsClient(added);
    render(<Settings client={c.client} onOpenIon={() => {}} toolsAt={{ kind: "mcp", name: "github" }} />);
    const gh = await findRow("github");
    expect(gh.className).toBe("trow at");
    expect(row("files").className).toBe("trow");
  });
});

// The user, 2026-11-21: "Only ion's, plus Import"; "yes, add both prompts to Task 9". Import sits beside Open config
// file; the first time, one line per agent says how many servers it has; later, what's new in one. Either can be
// dismissed until something new appears. Security review, 2026-11-21: before anything comes in, each server's command
// (or host) and the keys it needs are shown; one from a project's own file comes in only on its own.
describe("Settings → Tools: Import", () => {
  const server = (agent: string, from: string, name: string, fresh = true) => ({
    ...{ agent, from, name, transport: "stdio" as const, line: `${name}-mcp serve`, keys: [] as string[] },
    ...(fresh ? { new: true as const } : {}),
  });
  const first: ImportInfo = {
    servers: [
      { ...server("claude-code", "Claude Code", "github"), keys: ["GITHUB_TOKEN"] },
      server("claude-code", "Claude Code", "notes"),
      server("claude-code", "Claude Code", "shopdb"),
      { ...server("claude-code", "Claude Code", "repotool"), repo: { project: "shop", file: ".mcp.json" } },
    ],
    prompts: [
      { agent: "claude-code", from: "Claude Code", names: ["github", "notes", "shopdb"], first: true },
    ],
    problems: ["ion couldn't read ~/.grok/config.toml"],
    skipped: [],
  };
  const later: ImportInfo = {
    servers: [
      server("claude-code", "Claude Code", "notes", false),
      server("claude-code", "Claude Code", "github"),
    ],
    prompts: [{ agent: "claude-code", from: "Claude Code", names: ["github"], first: false }],
    problems: [],
    skipped: [],
  };
  const withImports = (i: ImportInfo) =>
    toolsClient(info, (cmd) => (cmd === "tools.importable" ? Promise.resolve(i) : undefined));
  const lineOf = async (text: string) => (await screen.findByText(text)).closest(".srow") as HTMLElement;
  const toolbar = () => within(document.querySelector(".tabs2") as HTMLElement);

  it("the first time, Tools says how many servers each agent has, with Import", async () => {
    const c = withImports(first);
    await open(c);
    const line = await lineOf("3 servers in Claude Code");
    expect(screen.getByText("ion couldn't read ~/.grok/config.toml")).toBeTruthy();
    fireEvent.click(within(line).getByRole("button", { name: "Import" }));
    // Shown first: what each runs and the keys it needs. Nothing is imported yet.
    const gh = await findRow("github");
    expect(within(gh).getByText("github-mcp serve")).toBeTruthy();
    expect(within(gh).getByText("GITHUB_TOKEN")).toBeTruthy();
    expect(screen.queryByText("repotool", { selector: ".tname" })).toBeNull();
    expect(c.call).not.toHaveBeenCalledWith("tools.import", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Import these" }));
    await waitFor(() =>
      expect(c.call).toHaveBeenCalledWith("tools.import", { names: ["github", "notes", "shopdb"] }),
    );
    await waitFor(() => expect(c.call).toHaveBeenCalledWith("tools.list", {}));
  });

  it("a server added to an agent's config later shows as New in that agent", async () => {
    const c = withImports(later);
    await open(c);
    const line = await lineOf("New in Claude Code: github");
    fireEvent.click(within(line).getByRole("button", { name: "Import" }));
    await findRow("github");
    expect(screen.queryByText("notes", { selector: ".tname" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Import these" }));
    await waitFor(() => expect(c.call).toHaveBeenCalledWith("tools.import", { names: ["github"] }));
  });

  it("a dismissed prompt stays hidden until something new appears", async () => {
    const c = withImports(first);
    await open(c);
    const line = await lineOf("3 servers in Claude Code");
    fireEvent.click(within(line).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(c.call).toHaveBeenCalledWith("tools.dismissImport", { agent: "claude-code" }));
  });

  it("Import beside Open config file shows every server; a repo's one says its file and comes in on its own", async () => {
    const c = withImports(first);
    await open(c);
    await lineOf("3 servers in Claude Code");
    fireEvent.click(toolbar().getByRole("button", { name: "Import" }));
    const repo = await findRow("repotool");
    expect(within(repo).getByText("From shop's .mcp.json")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import these" }));
    await waitFor(() =>
      expect(c.call).toHaveBeenCalledWith("tools.import", { names: ["github", "notes", "shopdb"] }),
    );
    fireEvent.click(toolbar().getByRole("button", { name: "Import" }));
    fireEvent.click(within(await findRow("repotool")).getByRole("button", { name: "Import repotool" }));
    await waitFor(() =>
      expect(c.call).toHaveBeenCalledWith("tools.import", { names: ["repotool"], repo: "shop:.mcp.json" }),
    );
    cleanup();
    await open(toolsClient(info));
    expect(
      ((await screen.findByRole("button", { name: "Nothing to import" })) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  // Tour, 2026-11-21: three agents with servers made three boxed lines. More than one agent: one line naming them.
  it("more than one agent with servers: one line naming them, one Import, one dismiss", async () => {
    const many: ImportInfo = {
      servers: [
        server("claude-code", "Claude Code", "github"),
        server("codex", "Codex", "notes"),
        server("codex", "Codex", "shopdb"),
        server("grok-build", "Grok Build", "docs"),
      ],
      prompts: [
        { agent: "claude-code", from: "Claude Code", names: ["github"], first: true },
        { agent: "codex", from: "Codex", names: ["notes", "shopdb"], first: true },
        { agent: "grok-build", from: "Grok Build", names: ["docs"], first: false },
      ],
      problems: [],
      skipped: [],
    };
    const c = withImports(many);
    await open(c);
    const text = "4 servers in Claude Code, Codex and Grok Build";
    const line = await lineOf(text);
    expect(document.querySelectorAll(".srow.imp")).toHaveLength(1);
    fireEvent.click(within(line).getByRole("button", { name: "Import" }));
    await findRow("docs");
    fireEvent.click(screen.getByRole("button", { name: "Import these" }));
    await waitFor(() =>
      expect(c.call).toHaveBeenCalledWith("tools.import", { names: ["github", "notes", "shopdb", "docs"] }),
    );
    fireEvent.click(within(await lineOf(text)).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(c.call).toHaveBeenCalledWith("tools.dismissImport", {}));
  });

  // Task review, 2026-11-21: servers that can't come in, and an import or dismiss that fails, were never shown.
  it("shows what can't come in, and why an import or dismiss failed", async () => {
    const skipped = {
      ...first,
      skipped: [{ agent: "claude-code", name: "docs", why: "ion connects over HTTP, not SSE" }],
    };
    const c = toolsClient(info, (cmd) => {
      if (cmd === "tools.importable") return Promise.resolve(skipped);
      if (cmd === "tools.import")
        return Promise.resolve({
          imported: [],
          skipped: [{ name: "github", why: "github is already in mcp.json" }],
        });
      if (cmd === "tools.dismissImport")
        return Promise.reject(new ApiCallError("invalid", "ion couldn't save that"));
      return undefined;
    });
    await open(c);
    await lineOf("3 servers in Claude Code");
    fireEvent.click(toolbar().getByRole("button", { name: "Import" }));
    const docs = await findRow("docs");
    expect(within(docs).getByText("ion connects over HTTP, not SSE")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import these" }));
    expect(await screen.findByText("github: github is already in mcp.json")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("ion couldn't save that")).toBeTruthy();
  });
});
