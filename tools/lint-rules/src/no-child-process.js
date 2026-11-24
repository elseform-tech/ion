import { isTest, onImports, repoPath, startsWithAny } from "./paths.js";

const SPAWN = /^(node:)?child_process$|^execa$/;
const ALLOWED = [
  "apps/daemon/src/workspace/",
  // The keychain CLIs (security, secret-tool): keys and tokens never in ion's config.
  "apps/daemon/src/secrets/",
  "packages/adapters/",
  "packages/adapter-kit/",
  "apps/cli/src/daemon-control.ts",
  // ps: what a test run left running (its daemons and their agents), found and stopped.
  "tools/test-temp/procs.ts",
];

/** Processes start only where sandboxing and concurrency limits apply. */
export default {
  meta: {
    type: "problem",
    messages: {
      noSpawn: "Only workspace, secrets, adapters and the CLI's daemon control may start processes.",
    },
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
