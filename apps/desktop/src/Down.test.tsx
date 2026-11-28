// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Down } from "./Down.js";

afterEach(cleanup);

// Plan 21 final review (2026-11-28, I4): the packaged app doesn't include ion yet, so it can't start it; it said "Start
// it with: ion daemon start" as if ion were there. A release build says so in one line, with how to get ion.
describe("Down", () => {
  it("the packaged app says it doesn't include ion yet, and how to get it", () => {
    render(<Down onRetry={() => {}} packaged />);
    expect(screen.getByText(/This app doesn't include ion yet/)).toBeTruthy();
    expect(screen.getByText("pnpm install && pnpm build")).toBeTruthy();
  });

  it("elsewhere, how to start it", () => {
    render(<Down onRetry={() => {}} />);
    expect(screen.getByText("ion daemon start")).toBeTruthy();
    expect(screen.queryByText(/doesn't include ion/)).toBeNull();
  });
});
