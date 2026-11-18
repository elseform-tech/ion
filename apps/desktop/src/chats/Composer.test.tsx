// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { HarnessInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
