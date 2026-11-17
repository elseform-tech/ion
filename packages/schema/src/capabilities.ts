export type EffortLevel = "low" | "medium" | "high" | "max";

export interface Capabilities {
  models: { id: string; label: string }[];
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
