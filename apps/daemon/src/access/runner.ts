import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@ion/adapter-kit";
import { loadUserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { getHarness } from "../adapters/registry.js";

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
    const c = loadUserConfig(configFile).config;
    const spec = agent ?? (which === "quick" ? c.ion.quick : c.access.judge);
    const [id, model] = [spec.split(":")[0]!, spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : null];
    const h = getHarness(id);
    if (!h) throw new Error(`Unknown harness: ${id}`);
    const dir = mkdtempSync(join(tmpdir(), "ion-judge-"));
    try {
      const session = await h.adapter.start({
        cwd: dir,
        model,
        effort: null,
        bare: true,
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
