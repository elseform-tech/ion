import type { AgentStep, HarnessInfo } from "@ion/schema";

const ready = (h: HarnessInfo) => h.installed && h.signedIn;

/** One agent's first step (Plan 21): ready, else the command that installs it or signs it in. */
export function stepOf(h: HarnessInfo): AgentStep {
  const base = { id: h.id, label: h.label };
  if (ready(h)) return { ...base, state: "ready" };
  if (!h.installed) return { ...base, state: "install", ...(h.install ? { command: h.install } : {}) };
  return {
    ...base,
    state: "signIn",
    ...(h.signIn ? { command: h.signIn.command, ...(h.signIn.inApp ? { inApp: true } : {}) } : {}),
  };
}

/** A step as one plain line: "Install opencode: npm i -g opencode-ai", "Sign in to Grok Build: grok login". */
function lineOf(s: AgentStep): string {
  const what = s.state === "install" ? `Install ${s.label}` : `Sign in to ${s.label}`;
  return s.command ? `${what}: ${s.command}` : what;
}

/** The first agent in your order (`infos` come in it) that isn't ready, as "Set up Grok Build: grok login"; or null. */
export function nextToSetUp(infos: HarnessInfo[]): string | null {
  const h = infos.find((x) => !ready(x));
  if (!h) return null;
  const s = stepOf(h);
  return s.command ? `Set up ${s.label}: ${s.command}` : `Set up ${s.label}`;
}

/**
 * With no agent ready, what to do in one line (Plan 21 audit, 2026-11-23: ion chief said "I couldn't reach my agent;
 * try again" and `ion ask` sent someone with no agent installed to Settings): sign in to the agents you have, else
 * install the first in your order (`infos` come in it). Null when one is ready.
 */
export function noAgentLine(infos: HarnessInfo[]): string | null {
  if (!infos.length || infos.some(ready)) return null;
  const signIn = infos.filter((h) => h.installed).map(stepOf);
  if (signIn.length) return `No agent is signed in. ${signIn.map(lineOf).join("; ")}`;
  return `No agent is installed. ${lineOf(stepOf(infos[0]!))}`;
}
