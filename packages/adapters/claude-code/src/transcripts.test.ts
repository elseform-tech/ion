import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMapState, mapSdkMessage } from "./map.js";

// Golden: real Claude Code sessions (recorded with scripts/record.mjs) replayed through the mapper.
// A Claude Code update that changes its output shows up here as a diff; record again under the new version.
const ROOT = join(import.meta.dirname, "../../../../fixtures/transcripts/claude-code");

for (const version of readdirSync(ROOT)) {
  describe(`Claude Code ${version} transcripts`, () => {
    for (const file of readdirSync(join(ROOT, version)).filter((f) => f.endsWith(".jsonl"))) {
      it(file, async () => {
        const state = createMapState({ cwd: "<cwd>", effort: "low", authMethod: "Claude subscription" });
        const lines = readFileSync(join(ROOT, version, file), "utf8")
          .trim()
          .split("\n");
        const events = lines.flatMap((l) => mapSdkMessage(JSON.parse(l), state));
        await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot(
          `../golden/${version}/${file.replace(".jsonl", ".events.json")}`,
        );
      });
    }
  });
}
