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
  it("reads agent · model · effort on its pill", () => {
    const { container } = compose([grok]);
    expect(container.querySelector(".cbox .bpill")?.textContent).toBe("Grok Build·grok-code·Default");
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
    const effort = () => container.querySelector(".bpill")?.textContent?.split("·").at(-1);
    fireEvent.keyDown(document, { key: ".", metaKey: true });
    expect(effort()).toBe("Low");
    fireEvent.keyDown(document, { key: ".", metaKey: true });
    expect(effort()).toBe("Medium");
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
});
