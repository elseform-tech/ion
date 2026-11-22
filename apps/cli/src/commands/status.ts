import { type AgentUsage, usageLine } from "@ion/schema";
import type { Command } from "commander";
import { connect } from "../connect.js";
import { type Out, print } from "../output.js";
import { clean } from "../sanitize.js";

/** Each ready agent's usage, one line each, as Settings → Agents says it: "Codex · 62% of 5 h · resets 14:20". */
export const agentLines = (list: AgentUsage[], now: Date): string[] =>
  list.map((u) => clean(`${u.label} · ${usageLine(u, now).text}`));

export function statusCommand(program: Command, out: () => Out) {
  program
    .command("status")
    .description("Is ion running, and how many projects")
    .action(async () => {
      // Inside a hook or a chat's run, with its key and ION_PORT (daemon.json is out of reach there).
      const c = await connect();
      const s = await c.call("status", {});
      // A chat's run may not ask for usage (its key allows less): then there are no agent lines.
      const usage = await c.call("usage.list", {}).catch(() => [] as AgentUsage[]);
      c.close();
      const n = `${s.projects} project${s.projects === 1 ? "" : "s"}`;
      const lines = [`ion is running · ${n}`];
      if (s.configError) lines.push(s.configError);
      for (const n of s.notes ?? []) lines.push(n);
      lines.push(...agentLines(usage, new Date()));
      print(out(), lines.join("\n"), { ...s, usage });
    });
}
