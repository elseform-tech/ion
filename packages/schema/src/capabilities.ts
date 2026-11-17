export type EffortLevel = "low" | "medium" | "high" | "max";

export interface Capabilities {
  models: { id: string; label: string }[];
  /** The model the harness uses when none is picked, if it says. */
  defaultModel: string | null;
  /** True when `models` came from the harness itself; false for the built-in fallback. */
  modelsLive: boolean;
  effort: { levels: EffortLevel[]; nativeName?: string; canDisableThinking: boolean };
  thinking: "full" | "summary" | "none";
  approvals: "interactive" | "preset-only";
  resume: boolean;
  interrupt: boolean;
  images: boolean;
  mcp: boolean;
  skills: boolean;
  usage: "tokens" | "cost" | "quota" | "none";
}
