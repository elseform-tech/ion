import {
  cachedCatalog,
  capabilitiesWith,
  type HarnessAdapter,
  readVersion,
  runLogout,
  type StartOpts,
  startLogin,
  whichOnPath,
  withPaths,
} from "@ion/adapter-kit";
import type { Billing, Capabilities } from "@ion/schema";
import {
  type ConnectOpts,
  connect,
  type ProbePlace,
  probeModels,
  probeSignedIn,
  setOption,
  setUpOutside,
} from "./connection.js";
import { bareConnect, REFUSE_ALL } from "./bare.js";
import type { AcpHarness } from "./harnesses.js";
import { startAcpSession } from "./session.js";

/** An agent that says nothing at all this long after a prompt is stuck (an expired key does this to opencode). */
const SILENCE_MS = 120_000;

const silenceOf = (h: AcpHarness) => ({
  ms: h.silenceMs ?? SILENCE_MS,
  why: `${h.label} didn't answer. Check that it's signed in: ${h.loginHint}`,
});

export { type AcpHarness, GROK_BUILD, OPENCODE } from "./harnesses.js";
export type { ProbePlace } from "./connection.js";

/** What the adapter is given: how to find the agent, how long a start may take, where its checks open it. */
export type AcpDeps = {
  which?: (bin: string) => string | null;
  startTimeoutMs?: number;
  /** Where and how its sign-in and model checks open the agent (the daemon's sandbox, in ion's data folder). */
  probes?: () => ProbePlace;
};

/** Everything but the model list, which comes from the agent itself. */
const CAPABILITIES: Omit<Capabilities, "models" | "defaultModel" | "modelsLive"> = {
  effort: { levels: ["low", "medium", "high"], canDisableThinking: false },
  thinking: "summary",
  approvals: "interactive",
  resume: true,
  interrupt: true,
  images: false,
  mcp: true,
  skills: false,
  usage: "cost",
};

/** What the agent brings of its own (its tools, hooks, trust) and how it takes "/" picks, as its harness says. */
const ownOf = (h: AcpHarness) => ({
  ...(h.ownTools ? { ownTools: true as const } : {}),
  ...(h.noWeb ? { noWeb: true as const } : {}),
  ...(h.picks ? { picks: h.picks } : {}),
  ...(h.ownHooks ? { ownHooks: true as const } : {}),
  ...(h.ownOff ? { ownOff: h.ownOff } : {}),
  ...(h.ownTrust ? { ownTrust: true as const } : {}),
  ...(h.contextTokens ? { contextTokens: h.contextTokens } : {}),
  ...(h.judge ? { judge: h.judge } : {}),
  ...(h.brain ? { brain: h.brain } : {}),
});

/** One adapter for any agent that speaks ACP over stdio (Grok Build, opencode, …). */
export function createAcpAdapter(h: AcpHarness, deps: AcpDeps = {}): HarnessAdapter {
  const which = deps.which ?? whichOnPath;
  const binary = () => which(h.bin);
  return {
    id: h.id,
    // ion's sandbox around the agent's process: neither opencode nor Grok has one of its own that keeps a folder away.
    sandbox: "ion",
    async detect() {
      const path = binary();
      if (!path) return { installed: false };
      const version = await readVersion(path, h.versionArgs);
      return { installed: true, ...(version ? { version } : {}), path };
    },
    auth: {
      async status() {
        const path = binary();
        if (!path) return { signedIn: false, method: "Not installed" };
        const probe = await probeSignedIn(h, path, {
          timeoutMs: deps.startTimeoutMs,
          place: deps.probes?.(),
        });
        const slow = h.notResponding?.() ?? "Not responding";
        const method = { yes: "Signed in", no: "Not signed in", "not-responding": slow }[probe];
        const billing = probe === "yes" ? h.billing : undefined;
        return { signedIn: probe === "yes", method, ...(billing ? { billing } : {}) };
      },
      login: {
        command: h.loginHint,
        ...(h.loginInApp
          ? { start: (signal: AbortSignal) => startLogin(installed(h, binary()), h.loginArgs, { signal }) }
          : {}),
      },
      logout: {
        command: h.logoutHint,
        ...(h.logoutInApp ? { run: () => runLogout(installed(h, binary()), h.logoutArgs) } : {}),
      },
    },
    ...(h.toCall ? { gateCall: h.toCall } : {}),
    ...(h.billingOf ? { billingOf: billingWith(h, binary) } : {}),
    capabilities: capabilitiesWith(CAPABILITIES, acpCatalog(h, binary, deps)),
    mcpTransports: { http: h.mcpHttp ?? true },
    ...ownOf(h),
    start: (opts) => startAcp(h, binary(), deps, opts),
  };
}

/** Its binary, or why it can't sign in or out. */
function installed(h: AcpHarness, path: string | null): string {
  if (!path) throw new Error(`${h.label} isn't installed`);
  return path;
}

/** How the models ion ran on it bill (null: its default), as the agent says, kept 10 minutes per set of models. */
function billingWith(h: AcpHarness, binary: () => string | null) {
  const kept = new Map<string, { at: number; billing: Promise<Billing | undefined> }>();
  return (models: (string | null)[]): Promise<Billing | undefined> => {
    const path = binary();
    const named = [...new Set(models.map((m) => m ?? h.defaultModel).filter((m): m is string => !!m))].sort();
    if (!path || !h.billingOf || !named.length) return Promise.resolve(undefined);
    const key = named.join("\n");
    const k = kept.get(key);
    if (k && Date.now() - k.at < 600_000) return k.billing;
    const billing = h.billingOf(path, named).catch(() => undefined);
    kept.set(key, { at: Date.now(), billing });
    return billing;
  };
}

/** A chat's run (or ion's judge, bare) on the agent. */
async function startAcp(h: AcpHarness, path: string | null, deps: AcpDeps, opts: StartOpts) {
  if (!path) throw new Error(`${h.label} isn't installed`);
  // Not set up yet: once outside the sandbox first, where it can write ion's folder for it.
  if (opts.sandbox && h.prepare && !h.prepare(opts.ownTools))
    await setUpOutside(h, path, { ownTools: !!opts.ownTools, timeoutMs: deps.startTimeoutMs });
  // The chat's folder, session, MCP server, gate and env (ConnectOpts reads only those). ion's judge (bare): a
  // session of a warm agent with no tools, on the harness's fast model and low effort.
  const c = opts.bare
    ? await bareConnect(h, path, bareOpts(h, opts, deps.startTimeoutMs))
    : await connect(h, path, { ...opts, ...noWebOpts(h, opts), timeoutMs: deps.startTimeoutMs });
  const want = wanted(h, opts);
  const model = (await setOption(c, "model", want.model)) ?? h.defaultModel ?? "default";
  await setOption(c, "thought_level", want.effort === "max" ? "high" : want.effort);
  return startAcpSession(
    c,
    { ...opts, effort: want.effort },
    {
      ...{ harness: h.id, model, silent: silenceOf(h) },
      ...(h.fullTokens ? { fullTokens: true } : {}),
    },
  );
}

/** A start with no web (ion's dream): the harness's way to turn its web off, or an error when it has none. */
function noWebOpts(h: AcpHarness, opts: StartOpts): Partial<ConnectOpts> {
  if (!opts.noWeb) return {};
  if (!h.noWeb) throw new Error(`${h.label} can't turn its web off`);
  const nw = h.noWeb({ dir: opts.bareHome ?? opts.cwd, own: !!opts.ownTools });
  return {
    ...(nw.args ? { args: nw.args } : {}),
    ...(nw.env ? { lastEnv: nw.env } : {}),
    ...(opts.sandbox && nw.read ? { sandbox: withPaths(opts.sandbox, { read: nw.read }) } : {}),
  };
}

/** The model and effort a start asks for: yours, else (ion's judge) the harness's fast model and low effort. */
function wanted(h: AcpHarness, opts: StartOpts): { model: string | null; effort: StartOpts["effort"] } {
  const bare = opts.bare ? h.bare : undefined;
  return { model: opts.model ?? bare?.model ?? h.defaultModel, effort: opts.effort ?? bare?.effort ?? null };
}

/**
 * A bare start's connection: the harness's bare command line, no servers, ion's gate pointed where every call is
 * refused (final review, 2026-11-22), in the judge's folder and sandbox.
 */
function bareOpts(h: AcpHarness, opts: StartOpts, timeoutMs?: number): ConnectOpts {
  return {
    cwd: opts.cwd,
    gate: { url: REFUSE_ALL },
    env: { ION_GATE_URL: REFUSE_ALL },
    ...(opts.envDrop ? { envDrop: opts.envDrop } : {}),
    // The agent's own files (Grok's profile) in the daemon's folder for them, which it may only read.
    ...(opts.sandbox
      ? { sandbox: withPaths(opts.sandbox, { read: opts.bareHome ? [opts.bareHome] : [] }) }
      : {}),
    ...(h.bare?.args ? { args: h.bare.args(opts.bareHome ?? opts.cwd) } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

/** The agent's models (from a session opened without a prompt), kept for 10 minutes. */
function acpCatalog(h: AcpHarness, binary: () => string | null, deps: AcpDeps) {
  return cachedCatalog(
    async () => {
      const path = binary();
      if (!path) throw new Error(`${h.label} isn't installed`);
      return probeModels(h, path, { timeoutMs: deps.startTimeoutMs, place: deps.probes?.() });
    },
    { fallback: { models: [], defaultModel: h.defaultModel } },
  );
}
