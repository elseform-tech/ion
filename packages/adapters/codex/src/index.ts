import { execFile } from "node:child_process";
import {
  agentEnv,
  type AuthStatus,
  cachedCatalog,
  capabilitiesWith,
  type HarnessAdapter,
  readVersion,
  runLogout,
  startLogin,
  whichOnPath,
} from "@ion/adapter-kit";
import type { Billing, Capabilities } from "@ion/schema";
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

/** How you signed in, and how that bills: ChatGPT is its plan (a subscription), an API key is paid per token. */
const LOGINS: [RegExp, string, Billing][] = [
  [/ChatGPT/, "ChatGPT", "subscription"],
  [/API key/i, "API key", "api"],
];

const SIGNED_OUT: AuthStatus = { signedIn: false, method: "Not signed in" };
const UNKNOWN: AuthStatus = { signedIn: false, unknown: true, method: "Couldn't tell" };

/**
 * `codex login status` answers by its exit code. Only how you signed in is kept (ChatGPT or an API key), never
 * the account or the key it prints part of.
 */
function loginStatus(l: Launch): Promise<AuthStatus> {
  return new Promise((resolve) =>
    execFile(l.bin, [...l.prefix, "login", "status"], { timeout: 10_000, env: agentEnv() }, (e, out, err) => {
      // It exits non-zero when signed out; a check that timed out or couldn't start says nothing either way.
      if (e) return resolve(typeof e.code === "number" && !e.killed ? SIGNED_OUT : UNKNOWN);
      // It prints to stderr; read both, keep only the kind of login.
      const text = `${out}${err}`;
      const login = LOGINS.find(([re]) => re.test(text));
      resolve(
        login
          ? { signedIn: true, method: login[1], billing: login[2] }
          : { signedIn: true, method: "Signed in" },
      );
    }),
  );
}

/** Whether Codex is signed in (and how), and its own login and logout. */
function codexAuth(launch: () => Launch | null): HarnessAdapter["auth"] {
  return {
    async status() {
      const l = launch();
      return l ? loginStatus(l) : { signedIn: false, method: "Not installed" };
    },
    // `codex login` serves its page on localhost:1455 and opens your browser (0.153.2). Starting it deletes the
    // sign-in Codex has (checked on a copy of its folder, 2026-11-23): ion starts it only when signed out.
    login: {
      command: "codex login",
      clears: true,
      start: (signal) => {
        const l = launched(launch());
        return startLogin(l.bin, [...l.prefix, "login"], { signal });
      },
    },
    logout: {
      command: "codex logout",
      run: () => {
        const l = launched(launch());
        return runLogout(l.bin, [...l.prefix, "logout"]);
      },
    },
  };
}

/** How to start Codex, or why it can't sign in or out. */
function launched(l: Launch | null): Launch {
  if (!l) throw new Error("Codex isn't installed");
  return l;
}

/**
 * What it takes from ion: MCP servers by url (Codex's mcp_servers is Streamable HTTP), and a start with no web (ion's
 * dream: its web search off in the thread's config); its default model's context (272k input tokens).
 */
const TAKES = { mcpTransports: { http: true }, noWeb: true, contextTokens: 272_000 } as const;

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
    auth: codexAuth(launch),
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
