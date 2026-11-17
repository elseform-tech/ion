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
  ],
});
