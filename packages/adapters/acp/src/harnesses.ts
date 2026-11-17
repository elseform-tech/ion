/** How to launch and sign in to an ACP agent. */
export type AcpHarness = {
  id: string;
  label: string;
  bin: string;
  args: string[];
  versionArgs: string[];
  loginArgs: string[];
  loginHint: string;
  defaultModel: string | null;
};

export const GROK_BUILD: AcpHarness = {
  id: "grok-build",
  label: "Grok Build",
  bin: "grok",
  args: ["agent", "stdio"],
  versionArgs: ["--version"],
  loginArgs: ["login"],
  loginHint: "grok login",
  defaultModel: null,
};

export const OPENCODE: AcpHarness = {
  id: "opencode",
  label: "opencode",
  bin: "opencode",
  args: ["acp"],
  versionArgs: ["--version"],
  loginArgs: ["auth", "login"],
  loginHint: "opencode auth login",
  // A free model, so trying ion costs nothing.
  defaultModel: "opencode/big-pickle",
};
