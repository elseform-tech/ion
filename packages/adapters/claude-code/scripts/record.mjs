#!/usr/bin/env node
// Records one real Claude Code session as raw SDK messages (JSON lines) for transcript tests.
// Usage: node scripts/record.mjs <name> <allow|deny> "<prompt>"   (manual only; never in CI)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { EV } from "@ion/schema";
import { createClaudeCodeAdapter } from "../dist/index.js";

const [name, decision, prompt] = process.argv.slice(2);
if (!name || !["allow", "deny"].includes(decision) || !prompt) {
  console.error('Usage: node scripts/record.mjs <name> <allow|deny> "<prompt>"');
  process.exit(1);
}

const cwd = mkdtempSync(join(tmpdir(), "ion-rec-"));
const realCwd = realpathSync(cwd); // macOS: /var is /private/var
execFileSync("git", ["init", "-q"], { cwd });
writeFileSync(join(cwd, "README.md"), "# scratch\n");

const raw = [];
const recordingQuery = (args) => {
  const q = sdkQuery(args);
  return Object.assign(
    (async function* () {
      for await (const m of q) {
        raw.push(m);
        yield m;
      }
    })(),
    { interrupt: () => q.interrupt() },
  );
};

const adapter = createClaudeCodeAdapter({ query: recordingQuery });
const { version } = await adapter.detect();
const session = await adapter.start({
  cwd,
  model: "haiku",
  effort: "low",
  signal: new AbortController().signal,
  decide: async () => decision,
});
await session.send({ text: prompt });
for await (const e of session.events())
  if (e.type !== EV.messageDelta) console.log(e.type, JSON.stringify(e.data).slice(0, 100));

// Redact anything machine- or account-specific.
const DROP = new Set([
  "session_id",
  "uuid",
  "request_id",
  "account",
  "email",
  "apiKeySource",
  "mcp_servers",
  "plugins",
  "slash_commands",
  "skills",
  "agents",
  "tools",
  "output_style",
  "memory_paths",
]);
const scrub = (v) => {
  if (typeof v === "string")
    return v.replaceAll(realCwd, "<cwd>").replaceAll(cwd, "<cwd>").replaceAll(homedir(), "~");
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !DROP.has(k))
        .map(([k, x]) => [k, scrub(x)]),
    );
  return v;
};
const dir = resolve(
  import.meta.dirname,
  "../../../../fixtures/transcripts/claude-code",
  version ?? "unknown",
);
mkdirSync(dir, { recursive: true });
// Hook messages carry the user's own hook output: never keep them.
const kept = raw.filter((m) => !(m.type === "system" && String(m.subtype).startsWith("hook_")));
writeFileSync(join(dir, name + ".jsonl"), kept.map((m) => JSON.stringify(scrub(m))).join("\n") + "\n");
const out = join(dir, `${name}.jsonl`);
console.log(`Saved ${kept.length} messages to ${out}`);
