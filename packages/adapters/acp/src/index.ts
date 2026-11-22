import { spawn } from "node:child_process";
import {
  agentEnv,
  cachedCatalog,
  capabilitiesWith,
  type HarnessAdapter,
  readVersion,
  whichOnPath,
} from "@ion/adapter-kit";
import type { Capabilities } from "@ion/schema";
import {
  connect,
  type ProbePlace,
  probeModels,
  probeSignedIn,
  setOption,
  setUpOutside,
} from "./connection.js";
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
  ...(h.picks ? { picks: h.picks } : {}),
  ...(h.ownHooks ? { ownHooks: true as const } : {}),
  ...(h.ownOff ? { ownOff: h.ownOff } : {}),
  ...(h.ownTrust ? { ownTrust: true as const } : {}),
});

/** One adapter for any agent that speaks ACP over stdio (Grok Build, opencode, …). */
export function createAcpAdapter(
  h: AcpHarness,
  deps: AcpDeps = {},
): HarnessAdapter {
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
        const probe = await probeSignedIn(h, path, { timeoutMs: deps.startTimeoutMs, place: deps.probes?.() });
        const slow = h.notResponding?.() ?? "Not responding";
        const method = { yes: "Signed in", no: "Not signed in", "not-responding": slow }[probe];
        return { signedIn: probe === "yes", method };
      },
      login: () =>
        new Promise<void>((resolve, reject) => {
          const path = binary();
          if (!path) return reject(new Error(`${h.label} isn't installed`));
          spawn(path, h.loginArgs, { stdio: "inherit", env: agentEnv() }).on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error("Sign-in didn't finish")),
          );
        }),
    },
    ...(h.toCall ? { gateCall: h.toCall } : {}),
    capabilities: capabilitiesWith(CAPABILITIES, acpCatalog(h, binary, deps)),
    mcpTransports: { http: h.mcpHttp ?? true },
    ...ownOf(h),
    async start(opts) {
      const path = binary();
      if (!path) throw new Error(`${h.label} isn't installed`);
      // Not set up yet: once outside the sandbox first, where it can write ion's folder for it.
      if (opts.sandbox && h.prepare && !h.prepare(opts.ownTools))
        await setUpOutside(h, path, { ownTools: !!opts.ownTools, timeoutMs: deps.startTimeoutMs });
      // The chat's folder, session, MCP server, gate and env (ConnectOpts reads only those).
      const c = await connect(h, path, { ...opts, timeoutMs: deps.startTimeoutMs });
      const model =
        (await setOption(c, "model", opts.model ?? h.defaultModel)) ?? h.defaultModel ?? "default";
      await setOption(c, "thought_level", opts.effort === "max" ? "high" : opts.effort);
      return startAcpSession(c, opts, { harness: h.id, model, silent: silenceOf(h) });
    },
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
