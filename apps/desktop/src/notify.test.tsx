// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { IonEvent } from "@ion/schema";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  granted: false,
  isPermissionGranted: vi.fn(async () => plugin.granted),
  requestPermission: vi.fn(async () => {
    plugin.granted = true;
    return "granted";
  }),
  sendNotification: vi.fn(),
  tap: null as null | ((e: unknown) => void),
  onAction: vi.fn(async (cb: (e: unknown) => void) => {
    plugin.tap = cb;
    return { unregister: vi.fn() };
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => plugin);
const win = vi.hoisted(() => ({ unminimize: vi.fn(async () => {}), setFocus: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

const { useSystemNotifications } = await import("./notify.js");

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  plugin.tap = null;
  plugin.granted = false;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

function daemon() {
  let push: ((e: IonEvent) => void) | null = null;
  const subscribe = vi.fn(async (_q: unknown, cb: (e: IonEvent) => void) => {
    push = cb;
    return () => {};
  });
  const client = { call: vi.fn(), subscribe } as unknown as IonClient;
  const send = (data: object) =>
    push?.({ id: "e1", type: "notify", chatId: "notify", data } as unknown as IonEvent);
  return { client, subscribe, send };
}

function Host({ client, open }: { client: IonClient; open: (chatId: string) => void }) {
  useSystemNotifications(client, open);
  return null;
}

// The user, 2026-11-19: "also build the settings as well… general… notifications, shortcuts…". ion's notify events
// show as system notifications (asking once), and clicking one opens its chat.
describe("system notifications", () => {
  it("a notify event shows a system notification; clicking it opens its chat", async () => {
    const d = daemon();
    const open = vi.fn();
    render(<Host client={d.client} open={open} />);
    await waitFor(() =>
      expect(d.subscribe).toHaveBeenCalledWith({ chatId: "notify", fromNow: true }, expect.anything()),
    );
    d.send({ title: "Shop", body: "Run the migration?", chatId: "c1", kind: "needs" });
    await waitFor(() =>
      expect(plugin.sendNotification).toHaveBeenCalledWith({
        title: "Shop",
        body: "Run the migration?",
        extra: { chatId: "c1" },
      }),
    );
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    d.send({ title: "Shop", body: "Another", kind: "summary" });
    await waitFor(() => expect(plugin.sendNotification).toHaveBeenCalledTimes(2));
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1); // asked once
    plugin.tap?.({ actionId: "tap", inputValue: null, notification: { extra: { chatId: "c1" } } });
    expect(open).toHaveBeenCalledWith("c1");
    // Task review, 2026-11-20: the click also brings the window forward.
    expect(win.unminimize).toHaveBeenCalled();
    await waitFor(() => expect(win.setFocus).toHaveBeenCalled());
  });

  // Task review, 2026-11-20: a "no" (or a failed ask) was cached for good, so turning notifications on later in
  // the system's settings never took. Permission is checked each time; ion asks you once, and again if asking failed.
  it("checks permission each time, asks once, and asks again after a failed ask", async () => {
    const d = daemon();
    render(<Host client={d.client} open={() => {}} />);
    await waitFor(() => expect(d.subscribe).toHaveBeenCalled());
    plugin.requestPermission.mockRejectedValueOnce(new Error("no window"));
    d.send({ title: "Shop", body: "One", chatId: "c1", kind: "needs" });
    await waitFor(() => expect(plugin.requestPermission).toHaveBeenCalledTimes(1));
    plugin.requestPermission.mockResolvedValueOnce("denied");
    d.send({ title: "Shop", body: "Two", chatId: "c1", kind: "needs" });
    await waitFor(() => expect(plugin.requestPermission).toHaveBeenCalledTimes(2));
    d.send({ title: "Shop", body: "Three", chatId: "c1", kind: "needs" });
    await waitFor(() => expect(plugin.isPermissionGranted).toHaveBeenCalledTimes(3));
    expect(plugin.requestPermission).toHaveBeenCalledTimes(2); // you said no: not asked again
    expect(plugin.sendNotification).not.toHaveBeenCalled();
    plugin.granted = true; // turned on in the system's settings
    d.send({ title: "Shop", body: "Four", chatId: "c1", kind: "needs" });
    await waitFor(() => expect(plugin.sendNotification).toHaveBeenCalledTimes(1));
  });

  // Task review, 2026-11-20 (round 2): a second notification while you were being asked was dropped.
  it("keeps every notification that comes while ion asks, and asks once", async () => {
    let answer: (a: string) => void = () => {};
    plugin.requestPermission.mockImplementationOnce(
      () =>
        new Promise((r) => {
          answer = (a) => {
            plugin.granted = a === "granted";
            r(a);
          };
        }),
    );
    const d = daemon();
    render(<Host client={d.client} open={() => {}} />);
    await waitFor(() => expect(d.subscribe).toHaveBeenCalled());
    d.send({ title: "Shop", body: "One", chatId: "c1", kind: "needs" });
    await waitFor(() => expect(plugin.requestPermission).toHaveBeenCalledTimes(1));
    d.send({ title: "Shop", body: "Two", chatId: "c2", kind: "needs" });
    await waitFor(() => expect(plugin.isPermissionGranted).toHaveBeenCalledTimes(2));
    answer("granted");
    await waitFor(() => expect(plugin.sendNotification).toHaveBeenCalledTimes(2));
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when you said no", async () => {
    plugin.requestPermission.mockResolvedValueOnce("denied");
    const d = daemon();
    render(<Host client={d.client} open={() => {}} />);
    await waitFor(() => expect(d.subscribe).toHaveBeenCalled());
    d.send({ title: "Shop", body: "Run it?", chatId: "c1", kind: "needs" });
    await waitFor(() => expect(plugin.requestPermission).toHaveBeenCalled());
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("does nothing outside the app's window (the browser dev app)", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const d = daemon();
    render(<Host client={d.client} open={() => {}} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(d.subscribe).not.toHaveBeenCalled();
    expect(plugin.onAction).not.toHaveBeenCalled();
  });
});
