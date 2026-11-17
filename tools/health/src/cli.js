#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareHealth } from "./compare.js";
import { measureHealth } from "./measure.js";

const root = process.cwd();
const baselineFile = join(root, "health/baseline.json");
const current = await measureHealth(root);

if (process.argv[2] === "update") {
  writeFileSync(baselineFile, `${JSON.stringify(current, null, 2)}\n`);
  console.log("Baseline updated:", current);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
const { ok, worse, better } = compareHealth(baseline, current);
for (const w of worse) console.error(`Worse: ${w.metric} ${w.was} → ${w.now}`);
for (const b of better)
  console.log(`Better: ${b.metric} ${b.was} → ${b.now}. Lock it in with: pnpm health:update`);
if (ok) console.log("Code health: no metric got worse.");
process.exit(ok ? 0 : 1);
