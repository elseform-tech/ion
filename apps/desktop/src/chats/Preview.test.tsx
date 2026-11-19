// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Preview, Tasks } from "./Preview.js";
import { ToolsPanel } from "./ToolsPanel.js";

afterEach(cleanup);

const patch = "@@ -0,0 +1 @@\n+hi\n";
function client(files: Record<string, unknown> = {}) {
  const call = vi.fn(async (cmd: string, a: { path?: string }) => {
    if (cmd === "chat.tasks")
      return [{ pid: 4242, command: "node vite --port 3000", elapsed: "02:15", ports: [3000], where: "/wt" }];
    if (cmd === "chat.file")
      return files[a.path ?? ""] ?? { path: a.path, kind: "text", text: "# Notes\n", size: 8 };
    return { ok: true };
  });
  return { call } as unknown as IonClient & { call: typeof call };
}

// The user, 2026-11-18: a preview box on the right of the chat for the workspace: files, artifacts, background
// tasks with their PIDs, the diff.
describe("the preview", () => {
  it("lists what's running in the chat's worktree, with PID and port, and stops one", async () => {
    const c = client();
    render(<Tasks client={c} chatId="c1" />);
    expect(await screen.findByText("node vite --port 3000")).toBeTruthy();
    expect(screen.getByText("PID 4242")).toBeTruthy();
    expect(screen.getByText(":3000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop 4242" }));
    expect(c.call).toHaveBeenCalledWith("task.stop", { chatId: "c1", pid: 4242 });
  });

  it("shows text as code, HTML in a locked frame, and an image", async () => {
    const c = client({
      "page.html": { path: "page.html", kind: "html", text: "<h1>Hi</h1>", size: 11 },
      "dot.png": { path: "dot.png", kind: "image", dataUrl: "data:image/png;base64,AA==", size: 1 },
    });
    const { rerender, container } = render(<Preview client={c} chatId="c1" path="notes.md" />);
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe("# Notes\n"));
    rerender(<Preview client={c} chatId="c1" path="page.html" />);
    await waitFor(() => expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(""));
    rerender(<Preview client={c} chatId="c1" path="dot.png" />);
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA=="),
    );
  });

  it("opens a changed file in the preview from the Files tab", async () => {
    const c = client();
    const diff = { files: [{ path: "notes.md", added: 1, removed: 0, patch }] };
    const { container } = render(<ToolsPanel diff={diff} error={null} client={c} chatId="c1" />);
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: /notes\.md/ }));
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe("# Notes\n"));
  });
});

// Review, 2026-11-19: the preview never read the file again, and it could open on a file the chat deleted.
describe("the preview, kept current", () => {
  const gone = {
    path: "gone.md",
    added: 0,
    removed: 1,
    patch: "deleted file mode 100644\n@@ -1 +0,0 @@\n-x\n",
  };
  const notes = { path: "notes.md", added: 1, removed: 0, patch };
  const reads = (c: ReturnType<typeof client>, path: string) =>
    c.call.mock.calls.filter(([cmd, a]) => cmd === "chat.file" && a.path === path).length;

  it("reads the file again when the chat's changes move", async () => {
    const c = client();
    const { rerender } = render(<Preview client={c} chatId="c1" path="notes.md" version={1} />);
    await waitFor(() => expect(reads(c, "notes.md")).toBe(1));
    rerender(<Preview client={c} chatId="c1" path="notes.md" version={2} />);
    await waitFor(() => expect(reads(c, "notes.md")).toBe(2));
  });

  it("opens on a file that's still there, and says when a picked one was deleted", async () => {
    const c = client();
    const diff = { files: [gone, notes] };
    const { container } = render(<ToolsPanel diff={diff} error={null} client={c} chatId="c1" version={1} />);
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe("# Notes\n"));
    expect(reads(c, "gone.md")).toBe(0);
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: /gone\.md/ }));
    expect(await screen.findByText("Deleted")).toBeTruthy();
    expect(reads(c, "gone.md")).toBe(0);
  });
});
