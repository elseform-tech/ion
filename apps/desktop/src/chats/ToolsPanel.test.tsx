// @vitest-environment jsdom
import { ApiCallError, type IonClient } from "@ion/client/browser";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolsPanel as ChangesPanel } from "./ToolsPanel.js";

afterEach(cleanup);

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n";

describe("ChangesPanel", () => {
  it("lists each changed file with its counts, and colours added and removed lines", async () => {
    const call = vi.fn(async () => ({ files: [{ path: "a.ts", added: 1, removed: 1, patch }] }));
    const { container } = render(
      <ChangesPanel client={{ call } as unknown as IonClient} chatId="c1" version={0} />,
    );
    expect(await screen.findByText("a.ts")).toBeTruthy();
    expect(container.querySelector(".tools .code .ln.add")?.textContent).toBe("2+new");
    expect(container.querySelector(".ln.del")?.textContent).toBe("2−old");
    expect(container.querySelector(".ln.h")?.textContent).toBe("@@ -1,2 +1,2 @@");
    expect(container.querySelector(".fh")?.textContent).toBe("a.ts+1−1");
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

  // Final review I3: a burst of edits is one read once things settle, not one per edit.
  it("reads once after a burst of changes settles", async () => {
    const call = vi.fn(async () => ({ files: [] }));
    const client = { call } as unknown as IonClient;
    const { rerender } = render(<ChangesPanel client={client} chatId="c1" version={0} />);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    for (let v = 1; v <= 20; v++) rerender(<ChangesPanel client={client} chatId="c1" version={v} />);
    await new Promise((r) => setTimeout(r, 700));
    expect(call).toHaveBeenCalledTimes(2);
  });

  // Final review M7: a diff ion couldn't read says so; it isn't "no changes".
  it("shows ion's error instead of 'No changes yet'", async () => {
    const call = vi.fn(async () => {
      throw new ApiCallError("invalid", "Couldn't read the chat's changes");
    });
    render(<ChangesPanel client={{ call } as unknown as IonClient} chatId="c1" version={0} />);
    expect(await screen.findByText("Couldn't read the chat's changes")).toBeTruthy();
  });

  it("says when some files aren't shown", async () => {
    const call = vi.fn(async () => ({ files: [], omitted: 3 }));
    render(<ChangesPanel client={{ call } as unknown as IonClient} chatId="c1" version={0} />);
    expect(await screen.findByText("3 more files not shown")).toBeTruthy();
  });
  // Plan 08: the lab's Files tab: the changed files by folder, each with its mark.
  it("shows the changed files by folder in the Files tab, added ones marked A", async () => {
    const added = "diff --git a/src/b.ts b/src/b.ts\nnew file mode 100644\n@@ -0,0 +1 @@\n+x\n";
    const call = vi.fn(async () => ({
      files: [
        { path: "src/a.ts", added: 1, removed: 1, patch },
        { path: "src/b.ts", added: 1, removed: 0, patch: added },
      ],
    }));
    const { container } = render(
      <ChangesPanel client={{ call } as unknown as IonClient} chatId="c1" version={0} />,
    );
    await screen.findByText("src/a.ts");
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    const rows = [...container.querySelectorAll(".tree > div")].map((d) => d.textContent);
    expect(rows).toEqual(["Changed files", "src", "a.tsM", "b.tsA"]);
    expect(container.querySelector(".code")).toBeNull();
  });
});
