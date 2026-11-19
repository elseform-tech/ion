// @vitest-environment jsdom
import { ApiCallError, type IonClient } from "@ion/client/browser";
import type { ActivityInfo, IonInfo, RecentRun, UpcomingRun } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextLine } from "./Activity.js";
import { Ions } from "./Ions.js";

afterEach(cleanup);

const ion = (ionId: string, name: string): IonInfo => ({
  ionId,
  name,
  color: ionId === "chief" ? null : "#ED712E",
  harness: null,
  last: null,
  needs: 0,
  working: false,
  thinking: false,
  starred: false,
});
const ions = [ion("chief", "ion"), ion("storefront", "storefront"), ion("docs", "docs")];

/** Today at this time (local). */
const today = (h: number, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const up = (o: Partial<UpcomingRun>): UpcomingRun => ({
  projectId: "storefront",
  routineId: "check",
  name: "Morning check",
  when: "daily 23:59",
  ion: "storefront",
  next: today(23, 59),
  effort: "medium",
  on: true,
  skipped: false,
  ...o,
});

const ran = (o: Partial<RecentRun>): RecentRun => ({
  runId: "r1",
  chatId: "t1",
  title: "Morning check",
  projectId: "storefront",
  ion: "storefront",
  routine: "Morning check",
  status: "done",
  costUsd: 0.21,
  at: today(0, 5),
  ...o,
});

function client(a: ActivityInfo) {
  const call = vi.fn(async (cmd: string) => {
    if (cmd === "ions.list") return ions;
    if (cmd === "activity.list") return a;
    if (cmd === "routine.run") return { chatId: "t9" };
    if (["routine.update", "routines.pause"].includes(cmd)) return { ok: true };
    return [];
  });
  const subscribe = vi.fn(async () => () => {});
  return { call, subscribe } as unknown as IonClient & { call: typeof call };
}

const activity = (o: Partial<ActivityInfo> = {}): ActivityInfo => ({
  paused: false,
  upcoming: [
    up({}),
    up({ projectId: "docs", routineId: "deps", name: "Deps", ion: "docs", on: false, next: null }),
  ],
  today: [
    ran({}),
    ran({
      runId: "r2",
      chatId: "t2",
      title: "Fix the cart",
      routine: null,
      status: "running",
      costUsd: null,
    }),
  ],
  yesterday: [ran({ runId: "r3", chatId: "t3", title: "Old one", status: "failed" })],
  ...o,
});

// Plan 10: Activity, as the lab's: a row atop the Ions panel, and its page.
describe("nextLine", () => {
  it("says what runs next, or that nothing is scheduled, or that all are paused", () => {
    expect(nextLine(activity())).toBe("Next: storefront · 23:59");
    expect(nextLine(activity({ upcoming: [] }))).toBe("No routines scheduled");
    expect(nextLine(activity({ paused: true }))).toBe("All routines paused");
  });
});

describe("Activity", () => {
  const open = async (a = activity()) => {
    const c = client(a);
    const onOpenChat = vi.fn();
    const r = render(<Ions client={c} onOpenChat={onOpenChat} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Activity/ }));
    await screen.findByText("Upcoming");
    return { c, onOpenChat, ...r };
  };

  it("sits atop the Ions panel with what runs next", async () => {
    render(<Ions client={client(activity())} onOpenChat={() => {}} />);
    expect(await screen.findByText("Next: storefront · 23:59")).toBeTruthy();
  });

  it("lists what's next, with run now, skip and pause on each", async () => {
    const { c, container } = await open();
    const rows = container.querySelectorAll(".arow");
    expect(rows[0]?.textContent).toContain("Morning check");
    expect(rows[0]?.textContent).toContain("storefront · Medium");
    expect(rows[0]?.querySelector(".when")?.textContent).toBe("23:59");
    expect(rows[1]?.classList.contains("off")).toBe(true);
    expect(rows[1]?.querySelector(".when")?.textContent).toBe("Paused");
    const routine = { projectId: "storefront", routineId: "check" };
    fireEvent.click(screen.getAllByRole("button", { name: "Run now" })[0]!);
    expect(c.call).toHaveBeenCalledWith("routine.run", routine);
    fireEvent.click(screen.getAllByRole("button", { name: "Skip next run" })[0]!);
    expect(c.call).toHaveBeenCalledWith("routine.update", { ...routine, skip: true });
    fireEvent.click(screen.getAllByRole("button", { name: "Pause" })[0]!);
    expect(c.call).toHaveBeenCalledWith("routine.update", { ...routine, on: false });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(c.call).toHaveBeenCalledWith("routine.update", { projectId: "docs", routineId: "deps", on: true });
  });

  it("lists today's and yesterday's runs; one opens its chat", async () => {
    const { onOpenChat, container } = await open();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Yesterday")).toBeTruthy();
    const done = screen.getByRole("button", { name: /^Morning check/ });
    expect(done.querySelector(".cost")?.textContent).toBe("$0.21");
    expect(done.querySelector('.out [title="Done"]')).not.toBeNull();
    // Running shimmers; no spinner.
    expect(container.querySelector(".out .now")?.textContent).toBe("Running");
    expect(container.querySelector(".spin")).toBeNull();
    fireEvent.click(done);
    expect(onOpenChat).toHaveBeenCalledWith("t1");
  });

  it("pauses all, and says so", async () => {
    const { c } = await open();
    fireEvent.click(screen.getByRole("switch", { name: "Pause all" }));
    expect(c.call).toHaveBeenCalledWith("routines.pause", { paused: true });
    cleanup();
    const p = await open(activity({ paused: true }));
    expect(await screen.findByText("All routines are paused.")).toBeTruthy();
    for (const b of screen.getAllByRole("button", { name: "Run now" }))
      expect((b as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Resume all" }));
    await waitFor(() => expect(p.c.call).toHaveBeenCalledWith("routines.pause", { paused: false }));
  });

  // Review, 2026-11-19: run now, skip, pause and pause all failed with no sign.
  it("says why a routine didn't run or pause, until one works", async () => {
    const { c } = await open();
    const fail = (cmd: string) =>
      c.call.mockImplementationOnce(async (x: string) => {
        if (x === cmd) throw new ApiCallError("invalid", "Unknown routine: check");
        return [];
      });
    fail("routine.run");
    fireEvent.click(screen.getAllByRole("button", { name: "Run now" })[0]!);
    expect(await screen.findByText("Unknown routine: check")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Skip next run" })[0]!);
    await waitFor(() => expect(screen.queryByText("Unknown routine: check")).toBeNull());
    fail("routines.pause");
    fireEvent.click(screen.getByRole("switch", { name: "Pause all" }));
    expect(await screen.findByText("Unknown routine: check")).toBeTruthy();
  });

  it("says when there are no routines", async () => {
    await open(activity({ upcoming: [], today: [], yesterday: [] }));
    expect(screen.getByText("No routines yet")).toBeTruthy();
  });
});
