import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@ion/adapter-kit";
import { loadUserConfig, type UserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { getHarness } from "../adapters/registry.js";
import { envDropOf } from "../tools/env-drop.js";

/**
 * The agent, model and effort a prompt runs on: ion's quick model at the effort you picked (`agent` overrides the
 * agent, on its default model), or the judge at its agent's default effort.
 */
export function startOf(c: UserConfig, which: "judge" | "quick", agent?: string) {
  const spec = agent ?? (which === "quick" ? c.ion.quick : c.access.judge);
  const id = spec.split(":")[0]!;
  const model = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : null;
  const effort = which === "quick" ? (c.ion.quickEffort ?? null) : null;
  return { id, model, effort };
}

/**
 * Runs one prompt on a model from your config: the Auto judge's ("judge", the default), or ion's own quick model
 * ("quick": how ion chief and the project ions think); `agent` ("<harness>[:<model>]") instead, when given. It runs
 * in an empty folder, as a bare session (no tools where the harness allows it; every permission denied), and
 * returns its last message.
 */
export function harnessRunner(
  configFile: string,
  which: "judge" | "quick" = "judge",
): (prompt: string, signal: AbortSignal, agent?: string) => Promise<string> {
  return async (prompt, signal, agent) => {
    const { id, model, effort } = startOf(loadUserConfig(configFile).config, which, agent);
    const h = getHarness(id);
    if (!h) throw new Error(`Unknown harness: ${id}`);
    const dir = mkdtempSync(join(tmpdir(), "ion-judge-"));
    try {
      const session = await h.adapter.start({
        cwd: dir,
        model,
        effort,
        bare: true,
        envDrop: await envDropOf(configFile),
        signal,
        decide: async () => "deny",
      });
      return await lastMessage(session, prompt, signal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Sends the prompt and returns the session's last message; closes the session (also when the judge gives up). */
async function lastMessage(session: Session, prompt: string, signal: AbortSignal): Promise<string> {
  const stop = () => void session.close().catch(() => {});
  if (signal.aborted) stop();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await session.send({ text: prompt });
    let last = "";
    for await (const e of session.events())
      if (e.type === EV.messageCompleted) last = String((e.data as { text: unknown }).text);
    return last;
  } finally {
    await session.close().catch(() => {});
  }
}

/**
 * A quick model's answer to one prompt, or null once `ms` pass, even when the model ignores the abort (tour,
 * 2026-11-21: an agent's question waited forever on one that never answered). Throws what the model throws.
 */
export async function answerWithin(
  run: (prompt: string, signal: AbortSignal) => Promise<string>,
  prompt: string,
  ms: number,
): Promise<string | null> {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((r) => {
    timer = setTimeout(() => {
      abort.abort();
      r(null);
    }, ms);
  });
  try {
    return await Promise.race([run(prompt, abort.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}
