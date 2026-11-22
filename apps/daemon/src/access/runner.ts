import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxKind, Session } from "@ion/adapter-kit";
import { loadUserConfig, type UserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { getHarness } from "../adapters/registry.js";
import { machineSandbox, runSandbox } from "../runs/sandbox.js";
import { envDropOf } from "../tools/env-drop.js";

/** Where ion's own agent processes (the judge, ion's quick model, sign-in and model checks) work: in its data folder. */
export const scratchOf = (dataDir: string): string => join(dataDir, "scratch");

/** A fresh folder for one of ion's own agent processes, in ion's data folder (denied to every run). */
export function scratchFolder(dataDir: string, prefix: string): string {
  mkdirSync(scratchOf(dataDir), { recursive: true, mode: 0o700 });
  return realpathSync(mkdtempSync(join(scratchOf(dataDir), prefix)));
}

/**
 * Removes the folders ion's judge and agent checks left in the temp folder before they moved into ion's data folder
 * (final review, 2026-11-22): `ion-probe-*` and `ion-judge-*` folders only, nothing else there.
 */
export function sweepTmp(tmp: string = tmpdir()): void {
  try {
    for (const e of readdirSync(tmp, { withFileTypes: true }))
      if (e.isDirectory() && /^ion-(probe|judge)-/.test(e.name))
        rmSync(join(tmp, e.name), { recursive: true, force: true });
  } catch {
    // a temp folder ion can't list: nothing of ion's to remove
  }
}

/** Where the runner's config is, where it works, and how this computer sandboxes (default: as it can). */
export type RunnerOpts = { configFile: string; dataDir: string; sandbox?: SandboxKind };

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
 * in an empty folder in ion's data folder, as a bare session (no tools where the harness allows it; every permission
 * denied), in a run's sandbox (final review, 2026-11-22: ion's folders denied, agents' configs read-only), and
 * returns its last message.
 */
export function harnessRunner(
  o: RunnerOpts,
  which: "judge" | "quick" = "judge",
): (prompt: string, signal: AbortSignal, agent?: string) => Promise<string> {
  return async (prompt, signal, agent) => {
    const { id, model, effort } = startOf(loadUserConfig(o.configFile).config, which, agent);
    const h = getHarness(id);
    if (!h) throw new Error(`Unknown harness: ${id}`);
    const dir = scratchFolder(o.dataDir, "ion-judge-");
    const sandbox = runSandbox(o.sandbox ?? machineSandbox(), { ...o, cwd: dir, harness: id });
    try {
      const session = await h.adapter.start({
        cwd: dir,
        model,
        effort,
        bare: true,
        envDrop: await envDropOf(o.configFile),
        ...(sandbox ? { sandbox } : {}),
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
