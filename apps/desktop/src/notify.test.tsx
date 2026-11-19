// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { IonEvent } from "@ion/schema";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  granted: false,
  isPermissionGranted: vi.fn(async () => plugin.granted),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
  tap: null as null | ((e: unknown) => void),
  onAction: vi.fn(async (cb: (e: unknown) => void) => {
    plugin.tap = cb;
    return { unregister: vi.fn() };
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => plugin);

const { useSystemNotifications } = await import("./notify.js");

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  plugin.tap = null;
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
