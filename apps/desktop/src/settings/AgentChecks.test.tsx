// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { AgentChecksInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChecks } from "./AgentChecks.js";

afterEach(cleanup);

const BASE: AgentChecksInfo = {
  nightly: false,
  running: false,
  window: "22:00–08:00",
  agents: [
    { agent: "opencode", label: "opencode", included: true, why: null, picked: false, cost: "Free" },
    {
      ...{ agent: "grok-build", label: "Grok Build", included: false, why: "Only if you pick it" },
      ...{ picked: false, cost: "A little of your plan" },
    },
    {
      agent: "codex",
      label: "Codex",
      included: false,
      why: "Avoided",
      picked: false,
      cost: "A little of your plan",
    },
  ],
  last: [],
};

function client(info: AgentChecksInfo) {
  const call = vi.fn(async (cmd: string) => (cmd.startsWith("agents.check") ? info : []));
  return { call, subscribe: vi.fn(async () => () => {}) } as unknown as IonClient & { call: typeof call };
}

// Plan 21 Task 5 (the user, 2026-11-28): one quiet line "Check the agents each night", off until you turn it on; on,
// each agent with what a night costs it (one that isn't free only if you pick it); the result in a line per agent
// that opens the details.
describe("Settings → Agents: Check the agents each night", () => {
  it("is off by default and turns on with one switch", async () => {
    const c = client(BASE);
    render(<AgentChecks client={c} />);
    const sw = await screen.findByRole("switch", { name: "Check the agents each night" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("Grok Build")).toBeNull();
    fireEvent.click(sw);
    expect(c.call).toHaveBeenCalledWith("agents.checks", { nightly: true });
  });

  it("on: each agent and its cost, a pick for one that isn't free, and why one is left out", async () => {
    const c = client({ ...BASE, nightly: true });
    render(<AgentChecks client={c} />);
    expect(await screen.findByText("opencode · Free")).toBeTruthy();
    expect(screen.getByText("Codex · Avoided")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Grok Build: check each night" }));
    expect(c.call).toHaveBeenCalledWith("agents.checks", { pick: { "grok-build": true } });
    expect(screen.getByText("Grok Build · A little of your plan")).toBeTruthy();
  });

  it("says the last checks in a line per agent that failed, which opens what failed", async () => {
    const at = new Date(Date.now() - 3600_000).toISOString();
    const c = client({
      ...BASE,
      nightly: true,
      last: [
        { agent: "opencode", label: "opencode", at, checks: [{ name: "Starts", ok: true }] },
        {
          ...{ agent: "grok-build", label: "Grok Build", at },
          checks: [
            { name: "Starts", ok: true },
            { name: "Answers", ok: false, note: "Said nothing" },
            { name: "Gate", ok: false },
          ],
        },
      ],
    });
    render(<AgentChecks client={c} />);
    const line = await screen.findByRole("button", { name: "Grok Build: 2 checks failed" });
    expect(screen.queryByText("Said nothing")).toBeNull();
    fireEvent.click(line);
    await waitFor(() => expect(screen.getByText("Answers · Said nothing")).toBeTruthy());
  });

  it("checks now on request", async () => {
    const c = client({ ...BASE, nightly: true });
    render(<AgentChecks client={c} />);
    fireEvent.click(await screen.findByRole("button", { name: "Check now" }));
    expect(c.call).toHaveBeenCalledWith("agents.check", {});
  });
});
