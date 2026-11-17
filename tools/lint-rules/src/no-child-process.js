import { isTest, onImports, repoPath, startsWithAny } from "./paths.js";

const SPAWN = /^(node:)?child_process$|^execa$/;
const ALLOWED = ["apps/daemon/src/workspace/", "packages/adapters/", "apps/cli/src/daemon-control.ts"];

/** Processes start only where sandboxing and concurrency limits apply. */
export default {
  meta: {
    type: "problem",
    messages: { noSpawn: "Only workspace, adapters and the CLI's daemon control may start processes." },
    schema: [],
  },
  create(ctx) {
    const p = repoPath(ctx.filename);
    if (isTest(p) || startsWithAny(p, ALLOWED)) return {};
    return onImports((node, source) => {
      if (SPAWN.test(source)) ctx.report({ node, messageId: "noSpawn" });
    });
  },
};
