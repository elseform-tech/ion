import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";
import plugin from "./index.js";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2023, sourceType: "module" },
});
const R = "/repo/";
const at = (file, code) => ({ filename: R + file, code });

tester.run("event-types-from-schema", plugin.rules["event-types-from-schema"], {
  valid: [
    at("packages/schema/src/events.ts", 'const t = "run.finished";'),
    at("apps/daemon/src/api/x.test.ts", 'const t = "run.finished";'),
    at("apps/daemon/src/api/x.ts", 'const t = "running";'),
    at("apps/daemon/src/api/x.ts", 'ws.once("error", reject);'),
    at("eslint.config.js", 'const level = "run.finished";'),
  ],
  invalid: [
    { ...at("apps/daemon/src/api/x.ts", 'const t = "run.finished";'), errors: [{ messageId: "useSchema" }] },
  ],
});

tester.run("no-direct-db", plugin.rules["no-direct-db"], {
  valid: [
    at("apps/daemon/src/store/db.ts", 'import Database from "better-sqlite3";'),
    at("apps/daemon/src/views/runs.ts", 'import type { Db } from "../store/index.js";'),
  ],
  invalid: [
    {
      ...at("packages/client/src/index.ts", 'import Database from "better-sqlite3";'),
      errors: [{ messageId: "storeOnly" }],
    },
    {
      ...at("apps/daemon/src/api/x.ts", 'import { sql } from "drizzle-orm";'),
      errors: [{ messageId: "storeOnly" }],
    },
  ],
});

tester.run("no-child-process", plugin.rules["no-child-process"], {
  valid: [
    at("apps/cli/src/daemon-control.ts", 'import { spawn } from "node:child_process";'),
    at("apps/daemon/src/workspace/git.ts", 'import { spawn } from "node:child_process";'),
    // Plan 18: the keychain CLIs (security, secret-tool) for keys and tokens.
    at("apps/daemon/src/secrets/index.ts", 'import { spawn } from "node:child_process";'),
    at("packages/adapters/claude-code/src/x.ts", 'import { execa } from "execa";'),
    at("packages/adapter-kit/src/system.ts", 'import { execFile } from "node:child_process";'),
    at("apps/cli/test/cli.test.ts", 'import { execFile } from "node:child_process";'),
  ],
  invalid: [
    {
      ...at("apps/daemon/src/api/x.ts", 'import { spawn } from "child_process";'),
      errors: [{ messageId: "noSpawn" }],
    },
    {
      ...at("apps/cli/src/commands/status.ts", 'import { spawn } from "node:child_process";'),
      errors: [{ messageId: "noSpawn" }],
    },
  ],
});

tester.run("walls", plugin.rules.walls, {
  valid: [
    at("apps/cli/src/index.ts", 'import { connect } from "@ion/client";'),
    at("apps/daemon/src/main.ts", 'import { ionPaths } from "@ion/config";'),
    at("apps/daemon/src/api/server.test.ts", 'import { connect } from "@ion/client";'),
    at("packages/schema/src/index.ts", 'import { z } from "zod";'),
    at("apps/daemon/src/api/server.ts", 'import { EventStore } from "../store/index.js";'),
    at("apps/daemon/src/adapters/registry.ts", 'import { createFakeAdapter } from "@ion/adapter-fake";'),
    at("apps/daemon/src/runs/manager.ts", 'import { projectRoots } from "@ion/adapter-kit";'),
  ],
  invalid: [
    { ...at("apps/cli/src/index.ts", 'import { x } from "@ion/daemon";'), errors: [{ messageId: "wall" }] },
    {
      ...at("packages/schema/src/index.ts", 'import { x } from "@ion/config";'),
      errors: [{ messageId: "wall" }],
    },
    {
      ...at("packages/client/src/index.ts", 'import { x } from "@ion/config";'),
      errors: [{ messageId: "wall" }],
    },
    {
      ...at("apps/cli/src/index.ts", 'import { x } from "../../daemon/src/main.js";'),
      errors: [{ messageId: "escape" }],
    },
    {
      ...at("apps/desktop/src/app.ts", 'import { readFileSync } from "node:fs";'),
      errors: [{ messageId: "nodeInUi" }],
    },
    {
      ...at("apps/daemon/src/runs/manager.ts", 'import { createFakeAdapter } from "@ion/adapter-fake";'),
      errors: [{ messageId: "registryOnly" }],
    },
  ],
});

tester.run("no-model-names", plugin.rules["no-model-names"], {
  valid: [
    at("packages/adapters/claude-code/src/capabilities.ts", 'const m = "claude-haiku-5-5";'),
    at("apps/daemon/src/runs/manager.test.ts", 'const m = "grok-4.7";'),
    at("apps/daemon/src/x.ts", 'const h = "claude-code";'),
    at("fixtures/x.ts", 'const m = "gpt-6";'),
  ],
  invalid: [
    {
      ...at("apps/daemon/src/x.ts", 'const m = "claude-haiku-5-5";'),
      errors: [{ messageId: "fromHarness" }],
    },
    {
      ...at("packages/config/src/x.ts", 'const m = "claude-code:Opus 5.5";'),
      errors: [{ messageId: "fromHarness" }],
    },
    { ...at("apps/cli/src/x.ts", "const m = `grok-4.7`;"), errors: [{ messageId: "fromHarness" }] },
  ],
});

// Plan 21 Task 3 (2026-11-24): one plain word per idea; a retired word on a screen is an error.
tester.run("plain-words", plugin.rules["plain-words"], {
  valid: [
    at("apps/desktop/src/x.tsx", 'client.call("harnesses.list", {});'),
    at("apps/desktop/src/x.tsx", 'if (card.kind === "threads") go();'),
    at("apps/desktop/src/x.tsx", 'const a = <i className="thread row" />;'),
    at("apps/desktop/src/x.test.tsx", 'const t = "Hide thread";'),
    at("apps/daemon/src/x.ts", 'const t = "Hide thread";'),
    at("apps/desktop/src/x.tsx", "const t = `Chats ion runs at once`;"),
    at("apps/desktop/src/x.tsx", "const t = `${n} failed runs`;"),
    at("apps/desktop/src/x.tsx", 'const source = "ion:_dream";'),
    at("apps/cli/src/x.ts", 'cmd.addOption(new Option("--harness <id>").hideHelp());'),
  ],
  invalid: [
    { ...at("apps/desktop/src/x.tsx", 'const t = "Hide thread";'), errors: [{ messageId: "retired" }] },
    { ...at("apps/desktop/src/x.tsx", "const a = <p>A thread</p>;"), errors: [{ messageId: "retired" }] },
    {
      ...at("apps/desktop/src/x.tsx", 'const a = <b aria-label="Harness" />;'),
      errors: [{ messageId: "retired" }],
    },
    { ...at("apps/desktop/src/x.tsx", "const t = `${n} threads`;"), errors: [{ messageId: "retired" }] },
    { ...at("apps/desktop/src/x.tsx", "const a = <span>Dream</span>;"), errors: [{ messageId: "retired" }] },
    { ...at("apps/desktop/src/x.tsx", 'const t = "ion chief";'), errors: [{ messageId: "retired" }] },
    {
      ...at("apps/cli/src/x.ts", 'cmd.description("Coding agents, by harness");'),
      errors: [{ messageId: "retired" }],
    },
  ],
});
