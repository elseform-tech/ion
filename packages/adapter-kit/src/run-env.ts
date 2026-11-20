/**
 * Every variable ion sets for one run's agent process (a gate address with its key, the chat marker, opencode's
 * per-run config, a Grok trust flag). A daemon started from a run's tool call inherits them; the daemon drops
 * them so nothing it starts later carries another run's address or key.
 */
export const RUN_ENV_VARS = [
  "ION_CHAT",
  "ION_GATE_URL",
  "GROK_FOLDER_TRUST",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
] as const;

/** Per-run variables named with this prefix (`ION_MCP_H<i>`: an ion MCP key header, one per header). */
export const RUN_ENV_PREFIXES = ["ION_MCP_"] as const;
