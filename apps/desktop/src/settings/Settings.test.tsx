// @vitest-environment jsdom
import { ApiCallError, type IonClient } from "@ion/client/browser";
import type { HarnessInfo, IonInfo, ProjectInfo } from "@ion/schema";
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
};
const claude: HarnessInfo = { ...grok, id: "claude-code", label: "Claude Code", signedIn: false, models: [] };
const ions: IonInfo[] = [
  {
    ionId: "chief",
    name: "ion",
    color: null,
    harness: null,
    last: null,
    needs: 0,
    working: false,
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

function client(o: { projects?: ProjectInfo[]; fail?: string[] } = {}) {
  const call = vi.fn(async (cmd: string) => {
    if (o.fail?.includes(cmd)) throw new ApiCallError("invalid", "Fix your config first.");
    if (cmd === "harnesses.list") return [claude, grok];
    if (cmd === "settings.get") return { quick: "grok-build", effort: null };
    if (cmd === "ions.list") return ions;
    if (cmd === "projects.list") return o.projects ?? projects;
    if (cmd === "activity.list") return activity;
    if (cmd === "ion.stats")
      return { runs: 3, succeeded: 2, costUsd: 0.75, perDay: [...Array(29).fill(0), 3] };
    return { ok: true };
  });
  return { call, subscribe: vi.fn(async () => () => {}) } as unknown as IonClient & { call: typeof call };
}

// The user, 2026-11-19: "where are the settings". The lab's Settings: Agents (who's ready, ion's quick model) and
// Ions (each ion's agent, colour, model, effort, folder and rules).
describe("Settings", () => {
  it("lists the agents and whether each is ready, and picks ion's quick model", async () => {
    const c = client();
    render(<Settings client={c} onOpenIon={() => {}} />);
    expect(await screen.findByText("Not signed in")).toBeTruthy();
    expect(screen.getByText("Signed in")).toBeTruthy();
    // An agent (its shape), then one of its models from a menu: a long model list stays one line.
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Grok Build" }).getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.queryByRole("radio", { name: "Claude Code" })).toBeNull(); // not signed in
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "grok-code-fast" } });
    expect(c.call).toHaveBeenCalledWith("settings.update", { quick: "grok-build:grok-code-fast" });
  });

  // The user, 2026-11-19: you choose how hard ion thinks.
  it("picks the effort ion thinks at", async () => {
    const c = client();
    render(<Settings client={c} onOpenIon={() => {}} />);
    const effort = await screen.findByRole("group", { name: "ion's effort" });
    expect(within(effort).getByRole("button", { name: "Default" }).className).toContain("on");
    fireEvent.click(within(effort).getByRole("button", { name: "Low" }));
    expect(c.call).toHaveBeenCalledWith("settings.update", { effort: "low" });
  });

  it("opens an ion's page from the Ions list, with its stats", async () => {
    const c = client();
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Ions" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Shop/ }));
    expect(await screen.findByRole("heading", { name: "Shop" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".statcard")?.textContent).toContain("3runs"));
    expect(document.querySelector(".statcard")?.textContent).toContain("$0.75");
  });

  it("changes a project ion's agent, colour, model, effort, access and sharing", async () => {
    const c = client();
    const onOpenIon = vi.fn();
    render(<Settings client={c} onOpenIon={onOpenIon} />);
    fireEvent.click(screen.getByRole("button", { name: "Ions" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Full access" }));
    patch({ access: "full" });
    fireEvent.click(screen.getByRole("switch", { name: "Share with ion" }));
    patch({ shareWithIon: false });
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(onOpenIon).toHaveBeenCalledWith("shop");
  });

  // Plan 10: an ion's routines, on its Settings page.
  const openShop = async (c: ReturnType<typeof client>) => {
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Ions" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Ions" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Shop/ }));
    await screen.findByRole("heading", { name: "Shop" });
  };

  it("saves the agent it shows with a model picked for a project with none of its own", async () => {
    const c = client({ projects: [{ ...projects[0]!, harness: undefined } as ProjectInfo] });
    await openShop(c);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "grok-code-fast" } });
    expect(c.call).toHaveBeenCalledWith("project.update", {
      projectId: "shop",
      harness: "grok-build",
      model: "grok-code-fast",
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
    const c = client({ fail: ["settings.update"] });
    render(<Settings client={c} onOpenIon={() => {}} />);
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Grok Build" }).getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "grok-code-fast" } });
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
