import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";

/** Soft limits: crossing one isn't an error, but the count of crossings may never grow. */
export const SOFT = { fileLines: 400, functionLines: 50, cognitiveComplexity: 10 };

const SOURCES = ["apps/*/src/**/*.{ts,js}", "packages/*/src/**/*.{ts,js}", "tools/*/src/**/*.{ts,js}"];
// This file names the patterns it counts; don't count it.
const SELF = "tools/health/src/measure.js";
const isTest = (f) => /\.test\.[jt]s$/.test(f);

async function softLimitCounts(root, files) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfig: {
      rules: {
        "max-lines": ["warn", { max: SOFT.fileLines, skipBlankLines: true, skipComments: true }],
        "max-lines-per-function": [
          "warn",
          { max: SOFT.functionLines, skipBlankLines: true, skipComments: true },
        ],
        "sonarjs/cognitive-complexity": ["warn", SOFT.cognitiveComplexity],
      },
    },
  });
  const results = await eslint.lintFiles(files);
  const count = (rule) => results.reduce((n, r) => n + r.messages.filter((m) => m.ruleId === rule).length, 0);
  return {
    filesOver400: count("max-lines"),
    functionsOver50: count("max-lines-per-function"),
    complexityOver10: count("sonarjs/cognitive-complexity"),
  };
}

function duplicationPct(root) {
  const report = join(root, ".health/jscpd/jscpd-report.json");
  if (!existsSync(report)) throw new Error("Run jscpd first (pnpm health does).");
  return JSON.parse(readFileSync(report, "utf8")).statistics.total.percentage;
}

function textCounts(root, files) {
  let eslintDisables = 0;
  let todos = 0;
  for (const f of files.filter((x) => x !== SELF)) {
    const text = readFileSync(join(root, f), "utf8");
    eslintDisables += text.match(/eslint-disable/g)?.length ?? 0;
    todos += text.match(/\b(TODO|FIXME|XXX)\b/g)?.length ?? 0;
  }
  return { eslintDisables, todos };
}

/** Current health metrics for the repo at `root`. Lower is better for every one. */
export async function measureHealth(root) {
  const files = SOURCES.flatMap((g) => globSync(g, { cwd: root })).filter((f) => !isTest(f));
  return {
    ...(await softLimitCounts(root, files)),
    duplicationPct: duplicationPct(root),
    ...textCounts(root, files),
  };
}
