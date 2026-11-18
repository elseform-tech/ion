// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangesPanel } from "./ChangesPanel.js";

afterEach(cleanup);

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n";

describe("ChangesPanel", () => {
  it("lists each changed file with its counts, and colours added and removed lines", async () => {
    const call = vi.fn(async () => ({ files: [{ path: "a.ts", added: 1, removed: 1, patch }] }));
    const { container } = render(
      <ChangesPanel client={{ call } as unknown as IonClient} chatId="c1" version={0} />,
    );
    expect(await screen.findByText("a.ts")).toBeTruthy();
    expect(container.querySelector(".diff-add")?.textContent).toBe("+new");
    expect(container.querySelector(".diff-del")?.textContent).toBe("-old");
    expect(container.querySelector(".diff-hunk")?.textContent).toBe("@@ -1,2 +1,2 @@");
    expect(call).toHaveBeenCalledWith("chat.diff", { chatId: "c1" });
  });

  it("reads the changes again when the chat changes something, and says when there are none", async () => {
    const call = vi.fn(async () => ({ files: [] }));
    const client = { call } as unknown as IonClient;
    const { rerender } = render(<ChangesPanel client={client} chatId="c1" version={0} />);
    expect(await screen.findByText("No changes yet")).toBeTruthy();
    rerender(<ChangesPanel client={client} chatId="c1" version={1} />);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  });
});
