import { z } from "zod";

/** A count of tokens. */
const tokens = z.number().int().min(0);

/** One of an agent's rate-limit windows: its name ("5 h", "week"), how much is used, and when it resets. */
const UsageWindowSchema = z.object({
  name: z.string().min(1).max(40),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.iso.datetime().nullable(),
});

/** What an agent reported a run used (Plan 20): tokens, cost, its rate-limit windows. */
export const usageEventSchemas = {
  "usage.reported": z.object({
    model: z.string(),
    inputTokens: tokens,
    outputTokens: tokens,
    /**
     * Every token the run processed: its input with the cached context it read and wrote, and its output. Absent
     * when the agent's count is known to be partial (opencode's covers only a turn's last step): no token estimate.
     */
    totalTokens: tokens.optional(),
    costUsd: z.number().min(0).nullable().optional(),
    /**
     * The agent's own rate-limit windows, as it reported them with this run (Codex's, Claude's): absent when it
     * reports none, so a gauge it stopped reporting goes away (docs/research/usage-signals.md).
     */
    windows: z.array(UsageWindowSchema).max(8).optional(),
    /** The agent, for usage outside a chat's run (an ion's turn, the judge): ion stamps it. */
    harness: z.string().optional(),
  }),
};
