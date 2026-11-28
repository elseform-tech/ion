// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffortKey } from "../chats/BrainPopover.js";
import { onEnter, type Queue, useDoubleEsc } from "../chats/Queue.js";
import { useSidebar } from "../Frame.js";
import { useSearchKey } from "../Search.js";
import { HOTKEYS, hit } from "../hotkeys.js";
import { Settings } from "./Settings.js";
import { openPage, settingsClient } from "./testing.js";

afterEach(cleanup);

/** Every hotkey a handler asked about. */
const asked = vi.hoisted(() => new Set<string>());
vi.mock("../hotkeys.js", async (original) => {
  const m = await original<typeof import("../hotkeys.js")>();
  return {
    ...m,
    hit: (id: Parameters<typeof m.hit>[0], e: Parameters<typeof m.hit>[1]) => (asked.add(id), m.hit(id, e)),
  };
});

const press = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...mods,
});

// The user, 2026-11-19: "also build the settings as well… general… notifications, shortcuts…". The page and the
// handlers read one table (hotkeys.ts), so the page lists exactly what the app does.
describe("Settings → Shortcuts", () => {
  it("lists every hotkey the app handles", async () => {
    render(<Settings client={settingsClient()} onOpenIon={() => {}} />);
    await openPage("Shortcuts");
    expect(HOTKEYS.length).toBeGreaterThan(0);
    for (const k of HOTKEYS) {
      const row = (await screen.findByText(k.name)).closest(".srow");
      expect([...(row?.querySelectorAll("kbd") ?? [])].map((b) => b.textContent)).toEqual(k.keys);
    }
  });

  it("matches the keys the handlers act on", () => {
    expect(hit("sidebar", press("b", { metaKey: true }))).toBe(true);
    expect(hit("sidebar", press("B", { ctrlKey: true }))).toBe(true);
    expect(hit("sidebar", press("b"))).toBe(false);
    expect(hit("effort", press(".", { metaKey: true }))).toBe(true);
    expect(hit("send", press("Enter"))).toBe(true);
    expect(hit("send", press("Enter", { shiftKey: true }))).toBe(false);
    expect(hit("now", press("Enter", { metaKey: true }))).toBe(true);
    expect(hit("now", press("Enter"))).toBe(false);
    expect(hit("newline", press("Enter", { shiftKey: true }))).toBe(true);
    expect(hit("stop", press("Escape"))).toBe(true);
  });

  // Task review, 2026-11-20: "Send" and "New line" were listed but no handler read them. Every row listed is one a
  // handler asks about.
  it("lists only hotkeys a handler reads", () => {
    asked.clear();
    renderHook(() => useSidebar());
    fireEvent.keyDown(document, { key: "b", metaKey: true });
    renderHook(() =>
      useSearchKey(
        () => {},
        () => {},
      ),
    );
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    renderHook(() => useEffortKey({ harness: "fake", model: "", effort: "low" }, () => {}));
    fireEvent.keyDown(document, { key: ".", metaKey: true });
    renderHook(() => useDoubleEsc("r1", () => {}));
    fireEvent.keyDown(document, { key: "Escape" });
    const send = vi.fn();
    const add = vi.fn(async () => true);
    const box = (working: boolean) => ({
      q: { add } as unknown as Queue,
      working,
      text: "hi",
      setText: () => {},
      send,
      brain: () => ({}),
    });
    const key = (k: { key: string; metaKey?: boolean; shiftKey?: boolean }) => {
      const e = {
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        ...k,
        nativeEvent: { isComposing: false, keyCode: 13 },
        preventDefault: vi.fn(),
      };
      return e as unknown as KeyboardEvent<HTMLTextAreaElement> & {
        preventDefault: ReturnType<typeof vi.fn>;
      };
    };
    onEnter(box(false))(key({ key: "Enter" }));
    expect(send).toHaveBeenCalledTimes(1);
    onEnter(box(true))(key({ key: "Enter" }));
    expect(add).toHaveBeenLastCalledWith("hi", {}, false);
    onEnter(box(true))(key({ key: "Enter", metaKey: true }));
    expect(add).toHaveBeenLastCalledWith("hi", {}, true);
    const newline = key({ key: "Enter", shiftKey: true });
    onEnter(box(false))(newline);
    expect(newline.preventDefault).not.toHaveBeenCalled(); // the box makes the new line
    expect([...asked].sort()).toEqual(HOTKEYS.map((k) => k.id).sort());
  });
});
