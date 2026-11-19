import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../api/errors.js";
import { wrapData } from "../context/index.js";
import type { Decisions } from "../decisions/index.js";
import type { Db } from "../store/index.js";
import { decisionsView } from "../views/decisions.js";
import type { Scope } from "./grants.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const refuse = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

/** Runs a tool body; a refusal (UserError) becomes an error result the agent can read. */
const guard =
  <A>(f: (a: A) => Result | Promise<Result>) =>
  async (a: A): Promise<Result> => {
    try {
      return await f(a);
    } catch (e) {
      if (e instanceof UserError) return refuse(e.message);
      throw e;
    }
  };

const Choice = z.object({
  label: z
    .string()
    .min(1)
    .max(200)
    .describe('The option as a one-line sentence saying what you\'ll do, e.g. "Merge it into main now"'),
  consequence: z
    .string()
    .max(1000)
    .describe(
      "One line on what it leads to, with its pros and cons: cost, risk, effort, what's hard to undo, and the facts the user needs to choose",
    ),
  recommended: z.boolean().optional().describe("Your own pick; at most one"),
});

/** Asking the user instead of being approved, your past decisions, and what came of them. */
export function askTools(server: McpServer, scope: Scope, d: { db: Db; decisions: Decisions }): void {
  server.registerTool(
    "ask",
    {
      description:
        'Ask the user to decide something before you do it. Write the question as one full sentence that stands on its own (what you\'ll do and to what, e.g. "Should I merge the cart drawer fix into main now that its tests pass?", never just "Merge it?"), add the context they need (why), and give 2 to 4 real options, each a one-line sentence with its pros and cons, marking your recommended one. The user can also answer in their own words. Then end your turn; the answer comes as the next message. Check `decisions` first: the user may have decided already.',
      inputSchema: {
        question: z
          .string()
          .min(1)
          .max(500)
          .describe("One full sentence that stands on its own: what you'd do, and to what"),
        choices: z.array(Choice).min(2).max(4),
        why: z.string().max(1000).optional().describe("Why you're asking: the situation and what's at stake"),
      },
    },
    guard((a: { question: string; choices: z.infer<typeof Choice>[]; why?: string }) =>
      d.decisions.ask(scope, a).then(ok),
    ),
  );
  server.registerTool(
    "decisions",
    {
      description: "The user's past decisions that apply here, and what happened after each.",
      inputSchema: {},
    },
    guard(() => {
      const list = decisionsView.applicable(d.db, scope.projectId, scope.chatId);
      const lines = list.map(
        (x) =>
          `${x.decisionId} (${x.scope}, ${x.decidedAt.slice(0, 10)}): ${JSON.stringify(x.question)} → ${JSON.stringify(x.choice)}` +
          // Notes on another project's "everywhere" decisions stay in that project.
          (x.projectId === scope.projectId ? x.outcomes : [])
            .map((o) => `\n  ${o.kind} (${o.by}): ${JSON.stringify(o.text)}`)
            .join(""),
      );
      return ok(wrapData("your decisions", lines.join("\n")));
    }),
  );
  server.registerTool(
    "report_outcome",
    {
      description: "Say what came of one of the user's decisions (at most 3 per run). Plain facts, short.",
      inputSchema: { decisionId: z.string().min(1), text: z.string().min(1).max(1000) },
    },
    guard((a: { decisionId: string; text: string }) => {
      d.decisions.report(scope, a.decisionId, a.text);
      return ok("Noted");
    }),
  );
}
