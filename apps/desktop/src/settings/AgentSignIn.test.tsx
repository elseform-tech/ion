// @vitest-environment jsdom
import { ApiCallError, type IonClient } from "@ion/client/browser";
import type { HarnessInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings.js";
import { settings } from "./testing.js";

afterEach(cleanup);

const ASK = "Sign out of Codex? This signs Codex out on this Mac, not just in ion.";

const codex = (more: Partial<HarnessInfo> = {}): HarnessInfo => ({
  ...{ id: "codex", label: "Codex", installed: true, signedIn: true, models: [], defaultModel: null },
  signIn: { command: "codex login", inApp: true, clears: true },
  signOut: { command: "codex logout", inApp: true },
  ...more,
});

/** A daemon with one agent, and how it answers sign-in and sign-out (as the real one: a question first). */
function client(h: HarnessInfo, answers: Record<string, (a: { confirm?: boolean }) => unknown> = {}) {
  const call = vi.fn(async (cmd: string, a: { confirm?: boolean }) => {
    if (answers[cmd]) return answers[cmd](a);
    if (cmd === "harnesses.list") return [h];
    if (cmd === "settings.get" || cmd === "settings.set") return settings;
    if (cmd === "projects.list" || cmd === "ions.list" || cmd === "usage.list") return [];
    return { ok: true };
  });
  return { call, subscribe: vi.fn(async () => () => {}) } as unknown as IonClient & { call: typeof call };
}

describe("Settings → Agents: signing in and out", () => {
  // The user, 2026-11-23: sign out asks first and runs the agent's own logout (it signs the agent out on this Mac).
  it("sign out asks first and runs the agent's own logout", async () => {
    const c = client(codex(), {
      "harness.logout": (a) => {
        if (!a.confirm) throw new ApiCallError("confirm", ASK);
        return { kind: "done", signedIn: false };
      },
    });
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out of Codex" }));
    expect(await screen.findByText(ASK)).toBeTruthy();
    expect(c.call).not.toHaveBeenCalledWith("harness.logout", { id: "codex", confirm: true });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(c.call).toHaveBeenCalledWith("harness.logout", { id: "codex", confirm: true }),
    );
    await waitFor(() => expect(screen.queryByText(ASK)).toBeNull());
  });

  it("a signed-out agent shows Not signed in and Sign in", async () => {
    render(<Settings client={client(codex({ signedIn: false }))} onOpenIon={() => {}} />);
    expect(await screen.findByText("Not signed in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out of Codex" })).toBeNull();
  });

  // The user, 2026-11-23: a login that gives a URL shows it: its page to open, and its code, each copyable.
  it("a login that gives a URL shows it", async () => {
    const page = { url: "https://example.test/device", code: "AB12-CD34" };
    const c = client(codex({ signedIn: false, signingIn: page }));
    render(<Settings client={c} onOpenIon={() => {}} />);
    expect(await screen.findByText("AB12-CD34")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open sign-in page" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(c.call).toHaveBeenCalledWith("harness.cancelLogin", { id: "codex" }));
  });

  // The user, 2026-11-23: an agent without a login shows its command (its login needs a terminal).
  it("an agent without a login shows its command", async () => {
    const opencode = codex({ id: "opencode", label: "opencode", signedIn: false });
    const c = client(opencode, {
      "harness.login": () => ({ kind: "command", command: "opencode auth login" }),
    });
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("opencode auth login")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
});
