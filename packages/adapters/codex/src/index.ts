import { execFile, spawn } from "node:child_process";
import {
  agentEnv,
  type AuthStatus,
  cachedCatalog,
  capabilitiesWith,
  type HarnessAdapter,
  readVersion,
  whichOnPath,
} from "@ion/adapter-kit";
import type { Capabilities } from "@ion/schema";
import { connect, type Launch, probeModels } from "./connection.js";
import { codexGateCall } from "./gate.js";
import { startCodexSession } from "./session.js";

/** Everything but the model list, which comes from Codex itself (`model/list`). */
const CAPABILITIES: Omit<Capabilities, "models" | "defaultModel" | "modelsLive"> = {
  effort: {
    levels: ["low", "medium", "high", "max"],
    nativeName: "reasoning effort",
    canDisableThinking: false,
  },
  thinking: "summary",
  approvals: "interactive",
  resume: true,
  interrupt: true,
  images: false,
  mcp: true,
  skills: false,
  usage: "tokens",
};

export type CodexDeps = {
  which?: (bin: string) => string | null;
  /** Arguments before ion's own (tests run a scripted Codex with Node). */
  prefixArgs?: string[];
  startTimeoutMs?: number;
};

const LOGINS: [RegExp, string][] = [
  [/ChatGPT/, "ChatGPT"],
  [/API key/i, "API key"],
];

/**
 * `codex login status` answers by its exit code. Only how you signed in is kept (ChatGPT or an API key), never
 * the account or the key it prints part of.
 */
function loginStatus(l: Launch): Promise<AuthStatus> {
  return new Promise((resolve) =>
    execFile(l.bin, [...l.prefix, "login", "status"], { timeout: 10_000, env: agentEnv() }, (e, out, err) => {
      if (e) return resolve({ signedIn: false, method: "Not signed in" });
      // It prints to stderr; read both, keep only the kind of login.
      const text = `${out}${err}`;
      const method = LOGINS.find(([re]) => re.test(text))?.[1] ?? "Signed in";
      resolve({ signedIn: true, method });
    }),
  );
}

/**
 * What it takes from ion: MCP servers by url (Codex's mcp_servers is Streamable HTTP), and a start with no web (ion's
 * dream: its web search off in the thread's config).
 */
const TAKES = { mcpTransports: { http: true }, noWeb: true } as const;

/** OpenAI's Codex CLI, driven through its app-server (JSON-RPC on stdio): `codex app-server`. */
export function createCodexAdapter(deps: CodexDeps = {}): HarnessAdapter {
  const which = deps.which ?? whichOnPath;
  const launch = (): Launch | null => {
    const bin = which("codex");
    return bin ? { bin, prefix: deps.prefixArgs ?? [], timeoutMs: deps.startTimeoutMs ?? 30_000 } : null;
  };
  const catalog = cachedCatalog(
    async () => {
      const l = launch();
      if (!l) throw new Error("Codex isn't installed");
      return probeModels(l);
    },
    { fallback: { models: [], defaultModel: null } },
  );
  return {
    id: "codex",
    // Its own sandbox, told to keep ion's folders out (it sandboxes its commands; macOS won't nest ion's around it).
    sandbox: "own",
    async detect() {
      const l = launch();
      if (!l) return { installed: false };
      const version = await readVersion(l.bin, [...l.prefix, "--version"]);
      return { installed: true, ...(version ? { version } : {}), path: l.bin };
    },
    auth: {
      async status() {
        const l = launch();
        return l ? loginStatus(l) : { signedIn: false, method: "Not installed" };
      },
      login: () =>
        new Promise<void>((resolve, reject) => {
          const l = launch();
          if (!l) return reject(new Error("Codex isn't installed"));
          spawn(l.bin, [...l.prefix, "login"], { stdio: "inherit", env: agentEnv() }).on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error("Sign-in didn't finish")),
          );
        }),
    },
    gateCall: codexGateCall,
    capabilities: capabilitiesWith(CAPABILITIES, catalog),
    ...TAKES,
    // Task review, 2026-11-21: off turns off its servers and plugins; its own skills (~/.codex/skills, .agents/skills)
    // load whatever the switch says, and a project's own tools load by its own trust.
    ownOff: { servers: true, skills: false, plugins: true },
    ownTools: true,
    ownTrust: true,
    async start(opts) {
      const l = launch();
      if (!l) throw new Error("Codex isn't installed");
      return startCodexSession(await connect(l, opts), opts);
    },
  };
}
