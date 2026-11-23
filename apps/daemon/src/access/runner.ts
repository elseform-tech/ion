import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, SandboxKind, Session, StartOpts } from "@ion/adapter-kit";
import type { EffortLevel } from "@ion/schema";
import { loadUserConfig, type UserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { getHarness, placeProbes } from "../adapters/registry.js";
import { ownAgentSandbox, runSandbox } from "../runs/sandbox.js";
import { envDropOf } from "../tools/env-drop.js";
import { brainEffort } from "../ions/brain.js";

/** Where ion's own agent processes (the judge, ion's quick model, sign-in and model checks) work: in its data folder. */
const scratchOf = (dataDir: string): string => join(dataDir, "scratch");

/**
 * Removes the folders ion's judge and agent checks left in the temp folder before they moved into ion's data folder
 * (final review, 2026-11-22): `ion-probe-*` and `ion-judge-*` folders only, nothing else there.
 */
export function sweepTmp(tmp: string = tmpdir()): void {
  // Only folders untouched for an hour: one in use (another ion, a test) stays (pnpm check, 2026-11-22).
  const before = Date.now() - 3600_000;
  try {
    for (const e of readdirSync(tmp, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^ion-(probe|judge)-/.test(e.name)) continue;
      const at = statSync(join(tmp, e.name), { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
      if (at < before) rmSync(join(tmp, e.name), { recursive: true, force: true });
    }
  } catch {
    // a temp folder ion can't list: nothing of ion's to remove
  }
}

/** Where the runner's config is, where it works, and how this computer sandboxes (default: as it can). */
export type RunnerOpts = {
  configFile: string;
  dataDir: string;
  sandbox?: SandboxKind;
  /** Hears each event of a session with its agent's id (the daemon keeps its usage and limits: views/usage.ts). */
  record?: (harness: string, e: AdapterEvent, startedAt: string) => void;
  /**
   * The agent to run on when your config names none ("": a fresh ion follows your agent order; Plan 21 audit,
   * 2026-11-23: it was Claude Code), as "<agent>[:<model>]"; undefined when none is ready.
   */
  firstOwn?: (which: Which) => Promise<string | undefined>;
};

/**
 * Which of ion's own models a prompt runs on: the Auto judge, ion's quick model (low-decision work, your order when
 * none is set), or ion's brain at Medium at most (judgement work: answering from your decisions; PR #36 re-review).
 */
export type Which = "judge" | "quick" | "brain";

/**
 * The agent, model and effort a prompt runs on: ion's quick model at the effort you picked (`agent` overrides the
 * agent, on its default model), or the judge at its agent's default effort.
 */
export function startOf(c: UserConfig, which: Which, agent?: string) {
  const spec = agent ?? (which === "judge" ? c.access.judge : c.ion.quick) ?? "";
  const id = spec.split(":")[0]!;
  const model = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : null;
  return { id, model, effort: effortOf(c, which) };
}

/** The judge at its agent's own effort; ion's brain at Medium at most; the quick model at yours. */
function effortOf(c: UserConfig, which: Which): EffortLevel | null {
  if (which === "judge") return null;
  if (which === "brain") return brainEffort(c.ion.quickEffort, true);
  return c.ion.quickEffort ?? null;
}

/** The judge's or ion's quick model's "<agent>[:<model>]": yours, else the first ready in your order. */
async function specOf(c: UserConfig, which: Which, firstOwn: RunnerOpts["firstOwn"]): Promise<string> {
  const set = which === "judge" ? c.access.judge : c.ion.quick;
  const spec = set || (await firstOwn?.(which));
  if (!spec) throw new Error("no agent is ready");
  return spec;
}

/**
 * Runs one prompt on a model from your config: the Auto judge's ("judge", the default), or ion's own quick model
 * ("quick": how ion chief and the project ions think); `agent` ("<harness>[:<model>]") instead, when given. It runs
 * in a fresh folder of ion's data folder (removed after), as a bare session (no tools where the harness allows it; every permission
 * denied), in a run's sandbox (final review, 2026-11-22: ion's folders denied, agents' configs read-only), and
 * returns its last message.
 */
export function harnessRunner(
  o: RunnerOpts,
  which: Which = "judge",
): (prompt: string, signal: AbortSignal, agent?: string) => Promise<string> {
  return async (prompt, signal, agent) => {
    const c = loadUserConfig(o.configFile).config;
    const { id, model, effort } = startOf(c, which, agent ?? (await specOf(c, which, o.firstOwn)));
    const h = getHarness(id);
    if (!h) throw new Error(`Unknown harness: ${id}`);
    const f = foldersOf(o.dataDir, which, id);
    const dir = realpathSync(mkdtempSync(join(f.base, "s-")));
    try {
      const session = await h.adapter.start({
        cwd: dir,
        model,
        effort,
        bare: true,
        bareHome: f.home,
        // Its sandbox writes its kind's folder (a warm agent's sessions each open in a folder there).
        ...(await ownAgentStart(o, f.base, id)),
        signal,
        decide: async () => "deny",
      });
      const startedAt = new Date().toISOString();
      return await lastMessage(session, prompt, signal, (e) => o.record?.(id, e, startedAt));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Where an agent's judge or ion's quick model on it works (PR #25 review, 2026-11-22), apart from each other: `base`,
 * which holds each session's own folder (made fresh, removed when it ends) and which its sandbox may write, and
 * `home`, a daemon-only folder for the agent's own files (Grok's profile), outside it. Emptied at the daemon's start.
 */
function foldersOf(dataDir: string, which: Which, harness: string): { base: string; home: string } {
  const name = `ion-${which}-${harness.replace(/[^\w-]/g, "_")}`;
  const base = join(scratchOf(dataDir), name);
  const home = join(scratchOf(dataDir), `${name}-own`);
  for (const d of [base, home]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return { base: realpathSync(base), home: realpathSync(home) };
}

/** Empties ion's scratch folder (the daemon's start): what judges and checks left there before goes. */
export function clearScratch(dataDir: string): void {
  rmSync(scratchOf(dataDir), { recursive: true, force: true });
}

/**
 * Sends the prompt and returns the session's last message (throws the agent's error when its run failed without one);
 * closes the session (also when the judge gives up).
 */
async function lastMessage(
  session: Session,
  prompt: string,
  signal: AbortSignal,
  heard: (e: AdapterEvent) => void,
): Promise<string> {
  const stop = () => void session.close().catch(() => {});
  if (signal.aborted) stop();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await session.send({ text: prompt });
    let last = "";
    let failed = "";
    for await (const e of session.events()) {
      heard(e);
      if (e.type === EV.messageCompleted) last = String((e.data as { text: unknown }).text);
      if (e.type === EV.error) failed = String((e.data as { message?: unknown }).message ?? "");
    }
    // A run that failed with nothing said is the agent's error (Judge eval, 2026-11-22: opencode out of quota came
    // back as an empty answer, so the judge never said why nor asked another agent).
    if (!last && failed) throw new Error(failed);
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

/**
 * Where ion's own agent processes work, set at the daemon's start: its checks of an agent open it in ion's data folder,
 * sandboxed; what judges and checks left in the temp folder and in ion's scratch folder goes.
 */
export function startOwnAgents(o: { dataDir: string; configFile: string }, kind: SandboxKind): SandboxKind {
  placeProbes({
    root: scratchOf(o.dataDir),
    sandbox: (cwd, harness) => runSandbox(kind, { ...o, cwd, harness }),
  });
  sweepTmp();
  clearScratch(o.dataDir);
  return kind;
}

/** What one of ion's own agent processes starts with: your keys kept from it, and its sandbox (none where there's none). */
export async function ownAgentStart(
  o: { dataDir: string; configFile: string; sandbox?: SandboxKind },
  cwd: string,
  harness: string,
): Promise<Pick<StartOpts, "envDrop" | "sandbox">> {
  return { envDrop: await envDropOf(o.configFile), ...ownAgentSandbox(o, cwd, harness) };
}
