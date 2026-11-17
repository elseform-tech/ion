import { isTest, repoPath } from "./paths.js";

// A model name: a family followed by a version ("claude-haiku-5-5", "grok-4.7", "Opus 5.5", "gpt-6").
const MODEL = /(claude|grok|gpt|gemini|opus|sonnet|haiku)[-\s]?\d/i;

/** Model names come from each harness's own list; only adapters (and tests, fixtures) may spell one out. */
export default {
  meta: {
    type: "problem",
    messages: {
      fromHarness: "Don't hard-code a model (\"{{value}}\"): read it from the harness's model list.",
    },
    schema: [],
  },
  create(ctx) {
    const p = repoPath(ctx.filename);
    if (!/^(apps|packages|tools)\//.test(p) || p.startsWith("packages/adapters/") || isTest(p)) return {};
    const check = (node, value) => {
      if (typeof value === "string" && MODEL.test(value))
        ctx.report({ node, messageId: "fromHarness", data: { value } });
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
    };
  },
};
