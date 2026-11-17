import { EVENT_TYPES } from "@ion/schema";
import { isTest, repoPath } from "./paths.js";

// Only dotted names: "error" is also an ordinary word (event listeners, log levels).
const types = new Set(EVENT_TYPES.filter((t) => t.includes(".")));

/** Event type strings exist only in packages/schema; everywhere else imports the EV constants. */
export default {
  meta: {
    type: "problem",
    messages: { useSchema: 'Import the event type from @ion/schema (EV) instead of writing "{{value}}".' },
    schema: [],
  },
  create(ctx) {
    const p = repoPath(ctx.filename);
    if (!/^(apps|packages|tools)\//.test(p) || p.startsWith("packages/schema/") || isTest(p)) return {};
    return {
      Literal(node) {
        if (typeof node.value === "string" && types.has(node.value))
          ctx.report({ node, messageId: "useSchema", data: { value: node.value } });
      },
    };
  },
};
