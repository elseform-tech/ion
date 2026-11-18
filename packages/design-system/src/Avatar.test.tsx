// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Avatar } from "./Avatar.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Final review I8: the avatars share one animation loop; avatars mounting together never start a second one.
describe("Avatar", () => {
  it("starts one animation loop for several avatars mounting at once", () => {
    const raf = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("Path2D", class {});
    act(() => {
      render(
        <>
          <Avatar harness="claude-code" />
          <Avatar harness="grok-build" />
          <Avatar harness="opencode" />
        </>,
      );
    });
    expect(raf).toHaveBeenCalledTimes(1);
  });
});
