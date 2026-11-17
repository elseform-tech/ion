import type { AuthStatus } from "@ion/adapter-kit";
import type { Capabilities } from "@ion/schema";

/** When Claude Code can't list its models: aliases that always point at the current ones. */
export const FALLBACK_MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

/** Everything but the model list, which comes from Claude Code itself (see index.ts). */
export const CAPABILITIES: Omit<Capabilities, "models" | "defaultModel" | "modelsLive"> = {
  effort: { levels: ["low", "medium", "high", "max"], nativeName: "effort", canDisableThinking: true },
  thinking: "summary",
  approvals: "interactive",
  resume: true,
  interrupt: true,
  images: true,
  mcp: true,
  skills: true,
  usage: "cost",
};

const METHOD_LABELS: Record<string, string> = {
  "claude.ai": "Claude subscription",
  oauth_token: "Long-lived token",
  api_key: "API key",
  api_key_helper: "API key",
  third_party: "Cloud provider",
};

/** Only Claude's own login counts; an API key or cloud provider doesn't (ion uses the user's Claude account). */
const LOGIN_METHODS = new Set(["claude.ai", "oauth_token"]);

/** Reads `claude auth status --json`, keeping only whether you're signed in and how. Never account details. */
export function parseAuthStatus(code: number, stdout: string): AuthStatus {
  let parsed: { loggedIn?: unknown; authMethod?: unknown };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { signedIn: false, method: "Not signed in" };
  }
  const method = typeof parsed.authMethod === "string" ? parsed.authMethod : "none";
  const signedIn = code === 0 && parsed.loggedIn === true && LOGIN_METHODS.has(method);
  return { signedIn, method: METHOD_LABELS[method] ?? "Not signed in" };
}
