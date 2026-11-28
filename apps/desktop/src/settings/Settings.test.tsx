// @vitest-environment jsdom
import { ApiCallError, type IonClient } from "@ion/client/browser";
import type { AgentUsage, HarnessInfo, IonInfo, ProjectInfo, SettingsInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings.js";

afterEach(cleanup);

const grok: HarnessInfo = {
  id: "grok-build",
  label: "Grok Build",
  installed: true,
  signedIn: true,
  models: [
    { id: "grok-code", label: "grok-code" },
    { id: "grok-code-fast", label: "grok-code-fast" },
  ],
  defaultModel: "grok-code",
  ownTools: true,
  ownHooks: true,
  ownTrust: true,
  judgeMisses: 4,
};
const claude: HarnessInfo = {
  id: "claude-code",
  label: "Claude Code",
  installed: true,
  signedIn: false,
  models: [],
  defaultModel: "grok-code",
  notSandboxed: true,
  ownRules: 3,
};
const ions: IonInfo[] = [
  {
    ionId: "chief",
    name: "ion",
    color: null,
    harness: null,
    last: null,
    needs: 0,
    working: false,
    thinking: false,
    starred: false,
  },
  {
    ionId: "shop",
    name: "Shop",
    color: "#ED712E",
    harness: "grok-build",
    last: null,
    needs: 0,
    working: false,
    thinking: false,
    starred: false,
  },
];
const projects = [
  {
    id: "shop",
    name: "Shop",
    path: "/p/shop",
    starred: false,
    harness: "grok-build",
    routines: [{ id: "deps", name: "Deps", when: "mon 09:00", text: "Update the deps.", on: true }],
  },
] as ProjectInfo[];

const activity = {
  paused: false,
  upcoming: [
    {
      projectId: "shop",
      routineId: "deps",
      name: "Deps",
      when: "mon 09:00",
      ion: "Shop",
      next: new Date(2030, 0, 7, 9, 0).toISOString(),
      effort: null,
      on: true,
      skipped: false,
    },
  ],
  today: [],
  yesterday: [],
};

function client(
  o: {
    projects?: ProjectInfo[];
    fail?: string[];
    problem?: string;
    own?: Record<string, boolean>;
    usage?: AgentUsage[] | (() => AgentUsage[]);
    settings?: Partial<SettingsInfo>;
  } = {},
) {
  const call = vi.fn(async (cmd: string) => {
    if (o.fail?.includes(cmd)) throw new ApiCallError("invalid", "Fix your config first.");
    if (cmd === "harnesses.list") return [claude, grok];
    if (cmd === "usage.list") return typeof o.usage === "function" ? o.usage() : (o.usage ?? []);
    if (cmd === "settings.get")
      return {
        quick: "grok-build",
        effort: null,
        problem: o.problem,
        ownTools: o.own ?? { "claude-code": true, "grok-build": true },
        ...o.settings,
      };
    if (cmd === "ions.list") return ions;
    if (cmd === "projects.list") return o.projects ?? projects;
    if (cmd === "activity.list") return activity;
    if (cmd === "ion.stats")
      return { runs: 3, succeeded: 2, costUsd: 0.75, perDay: [...Array(29).fill(0), 3] };
    return { ok: true };
  });
  return { call, subscribe: vi.fn(async () => () => {}) } as unknown as IonClient & { call: typeof call };
}

/** Opens Agents' More (Plan 21 Task 4: each agent's switches wait under it). */
const agentsMore = async () => fireEvent.click(await screen.findByRole("button", { name: "More" }));

// The user, 2026-11-19: "where are the settings". The lab's Settings: Agents (who's ready, ion's quick model) and
// Ions (each ion's agent, colour, model, effort, folder and rules).
describe("Settings", () => {
  // Final review, 2026-11-20: a config that didn't load left Settings on defaults without a word.
  it("says at the top when your config doesn't load", async () => {
    const problem = "config.toml: resources.max_runs must be a number";
    render(<Settings client={client({ problem })} onOpenIon={() => {}} />);
    const line = await screen.findByText(problem);
    expect(line.className).toContain("perr");
    cleanup();
    render(<Settings client={client()} onOpenIon={() => {}} />);
    await screen.findByText("Signed in");
    expect(document.querySelector(".spage > .perr")).toBeNull();
  });

  it("lists the agents and whether each is ready", async () => {
    render(<Settings client={client()} onOpenIon={() => {}} />);
    expect(await screen.findByText("Not signed in")).toBeTruthy();
    expect(screen.getByText("Signed in")).toBeTruthy();
    // The user, 2026-11-23: ion's own model is picked on its page (Ions → ion), not here; the judge stays.
    expect(screen.queryByRole("radiogroup", { name: "Quick" })).toBeNull();
  });

  // The user, 2026-11-21: "Only ion's, plus Import". Grok has no switch for its own servers, hooks and plugins, so
  // with "Use its own tools" off Settings says it also loads its own; the others load only ion's.
  it("says which agent also loads its own servers and hooks", async () => {
    render(
      <Settings
        client={client({ own: { "claude-code": false, "grok-build": false } })}
        onOpenIon={() => {}}
      />,
    );
    const rows = await screen.findAllByText(/^(Claude Code|Grok Build)$/);
    expect(rows).toHaveLength(2);
    expect(screen.getAllByText("Also loads its own")).toHaveLength(1);
    const own = screen.getByText("Also loads its own");
    expect(own.closest(".hrow")?.textContent).toContain("Grok Build");
  });

  // The user, 2026-11-21: agents bring their own servers, skills and plugins by default; each has "Use its own tools".
  // Hooks stay ion's: an agent whose own hooks can't be turned off says so.
  it("Use its own tools off brings back ion's tools only (the switch in Agents)", async () => {
    const c = client();
    render(<Settings client={c} onOpenIon={() => {}} />);
    await agentsMore();
    const sw = await screen.findByRole("switch", { name: "Grok Build: use its own tools" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Its own hooks run too").closest(".hrow")?.textContent).toContain("Grok Build");
    expect(screen.queryByText("Also loads its own")).toBeNull();
    fireEvent.click(sw);
    expect(c.call).toHaveBeenCalledWith("settings.set", { patch: { ownTools: { "grok-build": false } } });
    // Task review, 2026-11-21 (ruled line): an agent that trusts a project's tools by its own list says so.
    expect(screen.getByText("Uses its own trust for project tools").closest(".hrow")?.textContent).toContain(
      "Grok Build",
    );
  });

  // The user, 2026-11-21 (Plan 18 Task 12): on a computer without a sandbox, an agent's chats run without one, and
  // Settings → Agents says so; a sandboxed one says nothing. (Plan 18 Task 14): an agent's own allow and deny rules
  // count as your decisions; it says it uses them, with how many. Final review, 2026-11-22: Grok's judge timed out in
  // every live chat and nothing said so; it says how often an agent's judge didn't answer this week (only when it
  // didn't at all).
  it.each([
    ["Not sandboxed", "Claude Code"],
    ["Uses its own allow/deny rules (3)", "Claude Code"],
    ["Judge didn't answer 4 times this week", "Grok Build"],
  ])("says %s for that agent only", async (line, agent) => {
    render(<Settings client={client()} onOpenIon={() => {}} />);
    await screen.findByText("Not signed in");
    const lines = screen.getAllByText(line);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.closest(".hrow")?.textContent).toContain(agent);
  });

  // The user, 2026-11-21: Settings → Agents shows each ready agent's usage in one quiet line, where the lab has its
  // meter: its window ("62% of 5 h · resets 14:20") with a bar, "limited until 16:00", or "No usage info".
  describe("an agent's usage line", () => {
    const none = { tokens: 0, costUsd: 0 };
    const grokUsage = (u: Partial<AgentUsage>): AgentUsage[] => [
      {
        harness: "grok-build",
        label: "Grok Build",
        billing: "subscription",
        today: none,
        week: none,
        windows: [],
        limitedUntil: null,
        ...u,
      },
    ];
    const meterOf = async (usage: AgentUsage[]) => {
      render(<Settings client={client({ usage })} onOpenIon={() => {}} />);
      await agentsMore();
      await screen.findByRole("switch", { name: "Grok Build: use its own tools" });
      const row = screen.getByRole("switch", { name: "Grok Build: use its own tools" }).closest(".hrow")!;
      return waitFor(() => {
        const m = row.querySelector(".meter");
        expect(m?.textContent).toBeTruthy();
        return m as HTMLElement;
      });
    };

    it("a Codex window snapshot is stored and shown", async () => {
      const resetsAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const m = await meterOf(grokUsage({ windows: [{ name: "5 h", usedPercent: 62, resetsAt }] }));
      expect(m.textContent).toMatch(/^62% of 5 h · resets /);
      expect(m.querySelector(".tr i")?.getAttribute("style")).toContain("62%");
    });

    it("a limit error marks the agent limited until its reset", async () => {
      const limitedUntil = new Date(Date.now() + 60 * 60_000).toISOString();
      const m = await meterOf(grokUsage({ limitedUntil }));
      expect(m.textContent).toMatch(/^limited until /);
      expect(m.className).toContain("hi");
    });

    it("a missing gauge shows No usage info", async () => {
      const m = await meterOf(grokUsage({}));
      expect(m.textContent).toBe("No usage info");
      expect(m.querySelector(".tr")).toBeNull();
    });

    it("billing comes from the sign-in", async () => {
      const m = await meterOf(grokUsage({ billing: "free" }));
      expect(m.textContent).toBe("Free");
    });

    // Review, 2026-11-22: Settings read usage only with the agents list, so a limit hit while it was open didn't show.
    it("a limit hit while Settings is open shows at once", async () => {
      let usage = grokUsage({});
      let heard: ((e: { type: string; data: Record<string, unknown> }) => void) | undefined;
      const c = client({ usage: () => usage });
      (c.subscribe as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async (_q: unknown, fn: typeof heard) => {
          heard = fn;
          return () => {};
        },
      );
      render(<Settings client={c} onOpenIon={() => {}} />);
      await agentsMore();
      const row = (await screen.findByRole("switch", { name: "Grok Build: use its own tools" })).closest(
        ".hrow",
      )!;
      await waitFor(() => expect(row.querySelector(".meter")?.textContent).toBe("No usage info"));
      usage = grokUsage({ limitedUntil: new Date(Date.now() + 3600_000).toISOString() });
      heard?.({ type: "error", data: { code: "usage_limit", limit: {}, harness: "grok-build" } });
      await waitFor(() => expect(row.querySelector(".meter")?.textContent).toMatch(/^limited until /));
    });
  });

  // The user, 2026-11-19: you choose how hard ion thinks.
  it("picks the effort ion thinks at", async () => {
    const c = client();
    render(<Settings client={c} onOpenIon={() => {}} />);
    const effort = await screen.findByRole("group", { name: "Ions' effort" });
    expect(within(effort).getByRole("button", { name: "Auto" }).className).toContain("on");
    fireEvent.click(within(effort).getByRole("button", { name: "Low" }));
    expect(c.call).toHaveBeenCalledWith("settings.set", { patch: { effort: "low" } });
  });

  it("opens an ion's page from the Ions list, with its stats", async () => {
    const c = client();
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ions" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Shop/ }));
    expect(await screen.findByRole("heading", { name: "Shop" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".statcard")?.textContent).toContain("3runs"));
    expect(document.querySelector(".statcard")?.textContent).toContain("$0.75");
  });

  it("changes a project ion's agent, colour, model, effort and sharing", async () => {
    const c = client();
    const onOpenIon = vi.fn();
    render(<Settings client={c} onOpenIon={onOpenIon} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ions" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Shop/ }));
    await screen.findByRole("heading", { name: "Shop" });
    const patch = (p: object) =>
      expect(c.call).toHaveBeenCalledWith("project.update", { projectId: "shop", ...p });
    fireEvent.click(screen.getByRole("radio", { name: "Blue" }));
    patch({ color: "#3C82F6" });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "grok-code-fast" } });
    patch({ model: "grok-code-fast" });
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    patch({ effort: "high" });
    fireEvent.click(screen.getByRole("switch", { name: "Share with ion" }));
    patch({ shareWithIon: false });
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(onOpenIon).toHaveBeenCalledWith("shop");
  });

  // Task review, 2026-11-21: a project's Full access was still a switch on its ion's page, though the user ruled
  // (2026-11-20) that Auto-approval is switched only with the composer's access icon, never in Settings.
  it("the ion page has no Access row", async () => {
    render(<Settings client={client()} onOpenIon={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ions" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Shop/ }));
    await screen.findByText("Share with ion");
    expect(screen.queryByText("Access")).toBeNull();
    expect(screen.queryByRole("button", { name: "Full access" })).toBeNull();
  });

  // Plan 10: an ion's routines, on its Settings page.
  const openShop = async (c: ReturnType<typeof client>) => {
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ions" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Shop/ }));
  };

  it("lists an ion's routines, turns one off, changes its effort and removes it", async () => {
    const c = client();
    await openShop(c);
    expect(await screen.findByText("Deps")).toBeTruthy();
    expect(screen.getByText("Mondays 9:00")).toBeTruthy();
    expect(screen.getByText("Update the deps.")).toBeTruthy();
    await screen.findByText("Next: Jan 7 9:00");
    const routine = (p: object) =>
      expect(c.call).toHaveBeenCalledWith("routine.update", { projectId: "shop", routineId: "deps", ...p });
    fireEvent.click(screen.getByRole("switch", { name: "Deps" }));
    routine({ on: false });
    fireEvent.click(screen.getByRole("button", { name: "Effort: Default" }));
    routine({ effort: "low" });
    fireEvent.click(screen.getByRole("button", { name: "Remove Deps" }));
    expect(c.call).toHaveBeenCalledWith("routine.remove", { projectId: "shop", routineId: "deps" });
  });

  it("adds a routine: a name, when (picked, not typed), and what to do", async () => {
    const c = client();
    await openShop(c);
    fireEvent.click(await screen.findByRole("button", { name: "Add routine" }));
    const add = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Morning check" } });
    fireEvent.click(screen.getByRole("button", { name: "Weekdays" }));
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "08:30" } });
    fireEvent.change(screen.getByLabelText("What to do"), { target: { value: "Run the tests." } });
    fireEvent.click(add);
    expect(c.call).toHaveBeenCalledWith("routine.add", {
      projectId: "shop",
      name: "Morning check",
      when: "weekdays 08:30",
      text: "Run the tests.",
    });
    // Weekly picks a day; every few hours picks how many.
    fireEvent.click(await screen.findByRole("button", { name: "Add routine" }));
    const fill = () => {
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
      fireEvent.change(screen.getByLabelText("What to do"), { target: { value: "y" } });
    };
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    fireEvent.click(screen.getByRole("button", { name: "Fri" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(c.call).toHaveBeenCalledWith("routine.add", expect.objectContaining({ when: "fri 09:00" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add routine" }));
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Hourly" }));
    fireEvent.change(screen.getByLabelText("Every"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(c.call).toHaveBeenCalledWith("routine.add", expect.objectContaining({ when: "every 6h" }));
  });
});

// Review, 2026-11-19: Settings' controls failed with no sign; what Settings showed wasn't what it saved.
describe("Settings, reviewed", () => {
  const openShop = async (c: ReturnType<typeof client>) => {
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ions" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Shop/ }));
    await screen.findByRole("heading", { name: "Shop" });
  };

  // The user, 2026-11-24: a project's own agent, model and effort, under More, are for the chats its ion starts.
  it("sets the agent and model its ion's chats run on, under More, and goes back to the default", async () => {
    const c = client({ projects: [{ ...projects[0]!, harness: undefined } as ProjectInfo] });
    await openShop(c);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const runsOn = within(screen.getByRole("radiogroup", { name: "Its chats run on" }));
    expect(runsOn.getByRole("radio", { name: "Default" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(runsOn.getByRole("radio", { name: "Grok Build" }));
    expect(c.call).toHaveBeenCalledWith("project.update", {
      projectId: "shop",
      harness: "grok-build",
      model: null,
    });
    fireEvent.click(runsOn.getByRole("radio", { name: "Default" }));
    expect(c.call).toHaveBeenCalledWith("project.update", {
      projectId: "shop",
      harness: null,
      model: null,
      effort: null,
    });
  });

  it("says why a change to an ion didn't save, until one does", async () => {
    const fail = ["project.update"];
    const c = client({ fail });
    await openShop(c);
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    expect(await screen.findByText("Fix your config first.")).toBeTruthy();
    fail.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Low" }));
    await waitFor(() => expect(screen.queryByText("Fix your config first.")).toBeNull());
  });

  it("says why a routine change didn't save", async () => {
    const c = client({ fail: ["routine.update"] });
    await openShop(c);
    fireEvent.click(await screen.findByRole("switch", { name: "Deps" }));
    expect(await screen.findByText("Fix your config first.")).toBeTruthy();
  });

  it("says why ion's model didn't change", async () => {
    const c = client({ fail: ["settings.set"] });
    render(<Settings client={c} onOpenIon={() => {}} />);
    const brain = within(await screen.findByRole("radiogroup", { name: "Ions think with" }));
    fireEvent.click(await brain.findByRole("radio", { name: "Grok Build" }));
    expect(await screen.findByText("Fix your config first.")).toBeTruthy();
  });

  it("shows a routine that's off as Off, its effort plainly, and refuses an empty time", async () => {
    const off = { ...projects[0]!, routines: [{ ...projects[0]!.routines![0]!, on: false }] } as ProjectInfo;
    const c = client({ projects: [off] });
    await openShop(c);
    expect(await screen.findByText("Off")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Effort: Default" }).getAttribute("title")).toBe("Effort");
    fireEvent.click(screen.getByRole("button", { name: "Add routine" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("What to do"), { target: { value: "y" } });
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("Pick a time")).toBeTruthy();
    expect(c.call).not.toHaveBeenCalledWith("routine.add", expect.anything());
  });

  // Plan 14 (2026-11-19): a project's profile (what it is, for its ion and ion chief) is yours to set in Settings;
  // what its ion suggests only counts once you accept it.
  it("shows and saves a project's profile, and refuses one over 300 characters", async () => {
    const c = client({ projects: [{ ...projects[0]!, profile: "The\u0007 shop." } as ProjectInfo] });
    await openShop(c);
    const box = screen.getByLabelText("Profile") as HTMLTextAreaElement;
    expect(box.value).toBe("The shop.");
    fireEvent.change(box, { target: { value: "The storefront." } });
    fireEvent.blur(box);
    expect(c.call).toHaveBeenCalledWith("project.update", { projectId: "shop", profile: "The storefront." });
    fireEvent.change(box, { target: { value: "x".repeat(301) } });
    fireEvent.blur(box);
    expect(await screen.findByText("Keep it under 300 characters")).toBeTruthy();
    expect(c.call).not.toHaveBeenCalledWith("project.update", {
      projectId: "shop",
      profile: "x".repeat(301),
    });
    fireEvent.change(box, { target: { value: " " } });
    fireEvent.blur(box);
    expect(c.call).toHaveBeenCalledWith("project.update", { projectId: "shop", profile: null });
  });

  it("accepts or dismisses the profile its ion suggested", async () => {
    const c = client({
      projects: [{ ...projects[0]!, profileSuggestion: "A\u001b shop for socks." } as ProjectInfo],
    });
    await openShop(c);
    expect(screen.getByText("A shop for socks.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(c.call).toHaveBeenCalledWith("project.update", {
      projectId: "shop",
      profile: "A shop for socks.",
      profileSuggestion: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(c.call).toHaveBeenCalledWith("project.update", { projectId: "shop", profileSuggestion: null });
  });
});

// Plan 21 Task 4 (the user, 2026-11-22: "everything else stays out of the way until it's needed"; 2026-11-24: tuck
// away, never delete). Task 1 counted a real ion's events: routines, suggestions, decisions and Dream never used, memory
// once. Settings shows General, Agents and Memory first; Ions, Tools, Notifications and Shortcuts sit under one More
// until used, and each page's advanced parts (the agents' own-tools and avoid switches, Check as judge, Prefer in this
// order, Tidy memory, an ion's routines and its chats' agent) sit under that page's More until used.
describe("advanced things appear when they matter", () => {
  const fresh: ProjectInfo[] = [{ id: "shop", name: "Shop", path: "/p/shop", starred: false }];
  const notifications = {
    briefing: { on: true, at: "08:30" },
    quiet: { on: true, from: "22:00", to: "08:00" },
    projects: { shop: "needs" as const },
  };
  const noTools = { mcpFile: "/m.json", mcp: [], leftOut: [], hooks: [], skills: [], support: {}, own: {} };
  /** A newcomer's ion, with `o` changing what's been used. */
  function newcomer(
    o: { projects?: ProjectInfo[]; settings?: Partial<SettingsInfo>; tools?: object; tidied?: object } = {},
  ) {
    const dream = { mode: "off" as const, agent: null };
    const memory = { on: true, projects: {} };
    const c = client({
      projects: o.projects ?? fresh,
      settings: { notifications, dream, memory, ...o.settings },
    });
    const answer = c.call.getMockImplementation()!;
    const more: Record<string, unknown> = {
      "tools.list": { ...noTools, ...o.tools },
      "memory.tidied": o.tidied ?? null,
    };
    more["memory.list"] = [];
    c.call.mockImplementation(((cmd: string) =>
      cmd in more ? Promise.resolve(more[cmd]) : answer(cmd)) as never);
    return c;
  }
  const navNames = () =>
    within(screen.getByRole("navigation", { name: "Settings" }))
      .getAllByRole("button")
      .map((b) => b.textContent);

  it("advanced sections stay tucked away until used", async () => {
    render(<Settings client={newcomer()} onOpenIon={() => {}} />);
    await screen.findByText("Signed in");
    await waitFor(() => expect(navNames()).toEqual(["General", "Agents", "Memory", "More"]));
    // Agents: each agent's switches, Check as judge and Prefer in this order wait under the page's More.
    expect(screen.queryByRole("switch", { name: "Grok Build: use its own tools" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Grok Build: avoid unless I ask" })).toBeNull();
    expect(screen.queryByText("Its own hooks run too")).toBeNull();
    expect(screen.queryByText("Prefer in this order")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("switch", { name: "Grok Build: use its own tools" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Grok Build: avoid unless I ask" })).toBeTruthy();
    expect(screen.getByText("Prefer in this order")).toBeTruthy();
    // The rest of Settings opens from its own More, and stays open while you're on one of them.
    fireEvent.click(screen.getByRole("button", { name: "More settings" }));
    expect(navNames()).toEqual([
      "General",
      "Agents",
      "Memory",
      "More",
      "Ions",
      "Tools",
      "Notifications",
      "Shortcuts",
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Ions" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Shop/ }));
    await screen.findByRole("heading", { name: "Shop" });
    expect(navNames()).toContain("Ions");
    // An ion's page: no Routines until it has one (More shows them, with Add routine).
    expect(screen.queryByRole("heading", { name: "Routines" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("heading", { name: "Routines" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add routine" })).toBeTruthy();
    // Memory: Tidy memory waits under More while it's off and has never tidied.
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    await screen.findByRole("switch", { name: "Remember" });
    expect(screen.queryByRole("group", { name: "Tidy memory" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("group", { name: "Tidy memory" })).toBeTruthy();
  });

  it("a used section stays shown", async () => {
    const used = newcomer({
      projects: [{ ...fresh[0]!, routines: projects[0]!.routines }],
      settings: {
        notifications: { ...notifications, quiet: { on: false, from: "22:00", to: "08:00" } },
        ownTools: { "claude-code": true, "grok-build": false },
        avoid: { "claude-code": true },
        prefer: ["grok-build", "claude-code"],
        dream: { mode: "nightly", agent: null },
      },
      tools: { mcp: [{ name: "github" }] },
    });
    render(<Settings client={used} onOpenIon={() => {}} />);
    await waitFor(() =>
      expect(navNames()).toEqual(["General", "Agents", "Memory", "Ions", "Tools", "Notifications", "More"]),
    );
    // What you changed shows without More: that switch, and your order.
    expect(screen.getByRole("switch", { name: "Grok Build: use its own tools" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Claude Code: avoid unless I ask" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Grok Build: avoid unless I ask" })).toBeNull();
    expect(screen.getByText("Prefer in this order")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Ions" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Shop/ }));
    expect(await screen.findByRole("heading", { name: "Routines" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(await screen.findByRole("group", { name: "Tidy memory" })).toBeTruthy();
    // Tidied once (it's off now): it stays shown too.
    cleanup();
    render(
      <Settings
        client={newcomer({
          tidied: {
            at: new Date().toISOString(),
            merged: 1,
            updated: 0,
            forgot: 0,
            moved: 0,
            notes: [],
            forgotten: [],
          },
        })}
        onOpenIon={() => {}}
        at={{ kind: "memory" }}
      />,
    );
    expect(await screen.findByRole("group", { name: "Tidy memory" })).toBeTruthy();
  });
});
