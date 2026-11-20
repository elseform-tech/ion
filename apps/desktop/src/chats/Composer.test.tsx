// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { HarnessInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";

afterEach(cleanup);

const fake: HarnessInfo = {
  id: "fake",
  label: "Fake",
  installed: true,
  signedIn: true,
  models: [],
  defaultModel: null,
};
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
const out: HarnessInfo = { ...fake, id: "claude-code", label: "Claude Code", signedIn: false };

const compose = (harnesses: HarnessInfo[], call = vi.fn(async () => ({ chatId: "c1", runId: "r1" }))) => ({
  call,
  ...render(
    <Composer
      client={{ call } as unknown as IonClient}
      harnesses={harnesses}
      to={{ projectId: null }}
      running={null}
      onSent={() => {}}
    />,
  ),
});
const pill = () => screen.getByRole("button", { name: /Harness, model and effort/ });

describe("Composer", () => {
  // Final review M6: before the agents are known, nothing is sent (it would go to Claude Code and use its quota).
  it("can't send until the agents are loaded", () => {
    const call = vi.fn();
    render(
      <Composer
        client={{ call } as unknown as IonClient}
        harnesses={[]}
        to={{ projectId: null }}
        running={null}
        onSent={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    expect(call).not.toHaveBeenCalled();
  });

  // Final review M5: Enter twice before ion answers sends once.
  it("sends once however fast you press Enter", async () => {
    let done: (v: unknown) => void = () => {};
    const call = vi.fn(() => new Promise((r) => (done = r)));
    render(
      <Composer
        client={{ call } as unknown as IonClient}
        harnesses={[fake]}
        to={{ projectId: null }}
        running={null}
        onSent={() => {}}
      />,
    );
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("ask", { text: "hi", harness: "fake" });
    done({ chatId: "c1", runId: "r1" });
  });
  // Plan 08: the lab's brain pill: agent · model · effort.
  // UX tour: fewer words: the pill names the agent and model; effort is its bars (named for screen readers).
  it("reads agent · model on its pill, with effort as bars", () => {
    const { container } = compose([grok]);
    const p = container.querySelector(".cbox .bpill")!;
    expect(p.textContent).toBe("Grok Build·grok-code");
    expect(p.querySelector(".ebars")).not.toBeNull();
    expect(p.getAttribute("aria-label")).toBe(
      "Harness, model and effort: Grok Build · grok-code · Default effort",
    );
  });

  it("leaves out a model that only repeats the agent's name, and shimmers while agents load", () => {
    const { container, rerender } = compose([
      { ...fake, models: [{ id: "fake", label: "Fake" }], defaultModel: "fake" },
    ]);
    expect(container.querySelector(".bpill")?.textContent).toBe("Fake");
    rerender(
      <Composer
        client={{ call: vi.fn() } as unknown as IonClient}
        harnesses={[]}
        to={{ projectId: null }}
        running={null}
        onSent={() => {}}
      />,
    );
    expect(container.querySelector(".spin")).toBeNull();
    expect(container.querySelector(".bpill .now")?.textContent).toBe("Agents");
  });

  it("shows access as an icon, named on hover and picked from a list", () => {
    const { container } = compose([fake]);
    const pick = screen.getByLabelText("Access") as HTMLSelectElement;
    expect(pick.closest(".pill")?.getAttribute("title")).toBe("Project's access");
    expect(pick.closest(".pill")?.querySelector("svg")).not.toBeNull();
    fireEvent.change(pick, { target: { value: "full" } });
    expect(container.querySelector(".pill.full")?.getAttribute("title")).toBe("Full access");
  });

  it("sends what you pick in the brain popover", async () => {
    const { call } = compose([fake, grok]);
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole("button", { name: /^Grok Build/ }));
    fireEvent.click(screen.getByRole("button", { name: /^grok-code-fast/ }));
    fireEvent.click(screen.getByRole("button", { name: /^High/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".bpop")).toBeNull();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("ask", {
        text: "hi",
        harness: "grok-build",
        model: "grok-code-fast",
        effort: "high",
      }),
    );
  });

  // Review Focus 3: an agent that isn't signed in can't be picked, and nothing sends to it.
  it("shows a signed-out agent as a disabled row, and Send stays off with no agent ready", () => {
    compose([out]);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pill());
    const row = screen.getByRole("button", { name: /^Claude Code/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain("Not signed in");
  });

  it("cycles effort with ⌘.", () => {
    const { container } = compose([fake]);
    const effort = () => container.querySelector(".bpill")?.getAttribute("aria-label")?.split(" · ").at(-1);
    fireEvent.keyDown(document, { key: ".", metaKey: true });
    expect(effort()).toBe("Low effort");
    fireEvent.keyDown(document, { key: ".", metaKey: true });
    expect(effort()).toBe("Medium effort");
  });
  // Final review I6: you sign in to an agent after the app opened; opening the popover reads who's ready again.
  it("reads the agents again when the brain popover opens", () => {
    const onBrainOpen = vi.fn();
    render(
      <Composer
        client={{ call: vi.fn() } as unknown as IonClient}
        harnesses={[fake]}
        to={{ projectId: null }}
        running={null}
        onBrainOpen={onBrainOpen}
        onSent={() => {}}
      />,
    );
    fireEvent.click(pill());
    expect(onBrainOpen).toHaveBeenCalledTimes(1);
  });
  // The user, 2026-11-18: opencode's long model list. Each model is its name with its provider under it; a long
  // list can be searched.
  it("shows a long model list by name with its provider, and finds a model", () => {
    const many: HarnessInfo = {
      ...fake,
      id: "opencode",
      label: "opencode",
      models: Array.from({ length: 20 }, (_, i) => ({ id: `p/m${i}`, label: `OpenCode/Model ${i}` })),
      defaultModel: null,
    };
    compose([many]);
    fireEvent.click(pill());
    const row = screen.getByRole("button", { name: /^Model 3OpenCode/ });
    expect(row.querySelector("small")?.textContent).toBe("OpenCode");
    fireEvent.change(screen.getByLabelText("Find a model"), { target: { value: "model 1" } });
    const names = [...document.querySelectorAll(".bp-models .bp-row .g")].map(
      (g) => g.firstChild?.textContent,
    );
    expect(names).toEqual(["Model 1", ...Array.from({ length: 10 }, (_, i) => `Model ${10 + i}`)]);
  });

  it("has no find field for a short model list", () => {
    compose([grok]);
    fireEvent.click(pill());
    expect(screen.queryByLabelText("Find a model")).toBeNull();
  });
  // The user, 2026-11-18: while an agent's question waits, it's answered in its panel, not the message box.
  it("locks the message box while a question waits", () => {
    const { call } = { call: vi.fn() };
    render(
      <Composer
        client={{ call } as unknown as IonClient}
        harnesses={[fake]}
        to={{ chatId: "c1" }}
        running={null}
        locked
        onSent={() => {}}
      />,
    );
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // UX tour: a message took seconds to leave the box; it leaves at once, and comes back if ion says no.
  it("clears the box as soon as you send, and puts your words back if ion refuses", async () => {
    let fail: (e: unknown) => void = () => {};
    const call = vi.fn(() => new Promise((_r, j) => (fail = j)));
    compose([fake], call as never);
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("");
    fail(new Error("no"));
    await waitFor(() => expect(box.value).toBe("hi"));
  });
  // The user, 2026-11-19: "I changed the model in a working thread and it didn't persist." The pill starts from the
  // chat's own brain, and a pick for a chat is kept when its composer is drawn again.
  it("starts from the chat's own model, and keeps a chat's pick when drawn again", async () => {
    const call = vi.fn(async () => ({ chatId: "c9", runId: "r2" }));
    const box = (key: string) => (
      <Composer
        key={key}
        client={{ call } as unknown as IonClient}
        harnesses={[fake, grok]}
        to={{ chatId: "c9" }}
        running={null}
        harness="grok-build"
        current={{ model: "grok-code", effort: "high" }}
        onSent={() => {}}
      />
    );
    const { rerender } = render(box("a"));
    expect(pill().getAttribute("aria-label")).toContain("High");
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole("button", { name: /^grok-code-fast/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    rerender(box("b"));
    expect(pill().getAttribute("aria-label")).toContain("grok-code-fast");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go on" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("ask", {
        text: "go on",
        chatId: "c9",
        harness: "grok-build",
        model: "grok-code-fast",
        effort: "high",
      }),
    );
  });

  // The user, 2026-11-19: only a ready agent is a default. A chat on an agent that's since signed out goes on with
  // the first ready one (on that agent's own model), instead of a Send that never turns on.
  it("goes on with a ready agent when the chat's own isn't ready", async () => {
    const call = vi.fn(async () => ({ chatId: "c9", runId: "r2" }));
    render(
      <Composer
        client={{ call } as unknown as IonClient}
        harnesses={[out, grok]}
        to={{ chatId: "c10" }}
        running={null}
        harness="claude-code"
        current={{ model: "opus", effort: "" }}
        onSent={() => {}}
      />,
    );
    expect(pill().getAttribute("aria-label")).toContain("Grok Build");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go on" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("ask", { text: "go on", chatId: "c10", harness: "grok-build" }),
    );
  });

  // The user, 2026-11-19: no way to stop with the keyboard. Esc twice, quickly, stops the chat's run.
  it("stops the run on a double Esc, never on one", () => {
    const call = vi.fn(async () => ({ ok: true }));
    render(
      <Composer
        client={{ call } as unknown as IonClient}
        harnesses={[grok]}
        to={{ chatId: "c11" }}
        running="r9"
        onSent={() => {}}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(call).not.toHaveBeenCalledWith("run.interrupt", { runId: "r9" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(call).toHaveBeenCalledWith("run.interrupt", { runId: "r9" });
  });
});
