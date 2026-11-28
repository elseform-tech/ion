import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// Plan 21 Task 3 (2026-11-24): "no screen shows a retired word". Every string and JSX text the desktop app and the
// CLI can show, read with the repo's own config and only the plain-words rule; and (Plan 21 Task 4) the daemon's words
// that reach you.
it("no screen shows a retired word", { timeout: 120_000 }, async () => {
  const eslint = new ESLint({ cwd: ROOT, ruleFilter: ({ ruleId }) => ruleId === "ion/plain-words" });
  const results = await eslint.lintFiles([
    "apps/desktop/src",
    "apps/cli/src",
    ...["ions", "mcp", "api", "memory"].map((d) => `apps/daemon/src/${d}`),
  ]);
  const found = results.flatMap((r) =>
    r.messages.map((m) => `${r.filePath.slice(ROOT.length)}:${m.line} ${m.message}`),
  );
  expect(found).toEqual([]);
});
