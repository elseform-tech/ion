import type { HarnessInfo } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { noAgentLine, stepOf } from "./agent-steps.js";

const agent = (o: Partial<HarnessInfo> & { id: string; label: string }): HarnessInfo => ({
  installed: false,
  signedIn: false,
  models: [],
  defaultModel: null,
  ...o,
});
const opencode = agent({ id: "opencode", label: "opencode", install: "npm i -g opencode-ai" });
const grok = agent({
  id: "grok-build",
  label: "Grok Build",
  installed: true,
  install: "npm i -g @xai-official/grok",
  signIn: { command: "grok login", inApp: true },
});

// Plan 21 audit, 2026-11-23: with no agent ready, the app's Send stayed grey with no reason, the agent picker said only
// "Not installed", and `ion ask` said "No agent is signed in. See Settings → Agents." to someone with none installed.
// Each agent now carries its one-line fix: its install command, or its sign-in command.
describe("an agent's first step", () => {
  it("an agent that isn't signed in shows its sign-in command", () => {
    expect(stepOf(grok)).toEqual({
      id: "grok-build",
      label: "Grok Build",
      state: "signIn",
      command: "grok login",
      inApp: true,
    });
  });

  it("one that isn't installed shows its install command; a ready one is ready", () => {
    expect(stepOf(opencode)).toEqual({
      id: "opencode",
      label: "opencode",
      state: "install",
      command: "npm i -g opencode-ai",
    });
    expect(stepOf({ ...grok, signedIn: true })).toEqual({
      id: "grok-build",
      label: "Grok Build",
      state: "ready",
    });
  });
});

describe("no agent ready", () => {
  it("says to sign in to the agents you have, with their commands", () => {
    expect(noAgentLine([opencode, grok])).toBe("No agent is signed in. Sign in to Grok Build: grok login");
  });

  it("with none installed, says how to install the first in your order", () => {
    expect(noAgentLine([opencode, { ...grok, installed: false }])).toBe(
      "No agent is installed. Install opencode: npm i -g opencode-ai",
    );
  });

  it("is null when one is ready", () => {
    expect(noAgentLine([opencode, { ...grok, signedIn: true }])).toBeNull();
  });
});
