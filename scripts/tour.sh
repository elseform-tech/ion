#!/bin/bash
# The UX tour (AGENTS.md): a fresh ion with every chat state, ion threads and ion chief, and the app in a browser.
#   scripts/tour.sh            start it; prints the app's address
#   scripts/tour.sh stop       stop the tour's ion and the app
#   scripts/tour.sh fresh      a brand-new ion (no projects, no chats) for the first run, with a made-up folder that
#                              isn't a git repo to add (its path is printed); `fresh none`: no agent found (PATH holds the
#                              system's and node), for the no-agent rows
# Needs a build (pnpm build). Uses the fake agent, so it costs no quota; send a real message with opencode's free
# model from the app as part of the tour.
set -e
cd "$(dirname "$0")/.."
export ION_HOME="${ION_TOUR_HOME:-/tmp/ion-tour}" ION_ALLOW_FAKE=1 ION_TOUR=1
# Plan 20: the fake agent is listed (ION_DEBUG) and paid per use, so Settings → Agents has a line with this week's cost;
# "slow" runs an hour, so an ion chat waiting for its slot stays waiting while you look.
export ION_DEBUG=1 ION_FAKE_BILLING=api ION_FAKE_SLOW_S=3600
ion() { node apps/cli/dist/index.js "$@"; }
if [ "$1" = stop ]; then
  ion daemon stop >/dev/null 2>&1 || true
  pkill -f "apps/desktop.*vite" >/dev/null 2>&1 || true
  pkill -f "ion-tour-oauth" >/dev/null 2>&1 || true
  exit 0
fi
ion daemon stop >/dev/null 2>&1 || true
rm -rf "$ION_HOME" && mkdir -p "$ION_HOME"
app() {
  pgrep -f "apps/desktop.*vite" >/dev/null || (cd apps/desktop && nohup pnpm dev >/dev/null 2>&1 &)
  sleep 3
  # ION_TOUR_APP: the app's address when your vite runs elsewhere (another worktree's port).
  node -e 'const j=require(process.env.ION_HOME+"/data/daemon.json");console.log(`${process.env.ION_TOUR_APP||"http://127.0.0.1:5173"}/?port=${j.port}&token=${j.token}`)'
}
# Plan 21 Task 6: the first run as a newcomer meets it: ion's defaults (but its projects folder, ion's model and the
# judge are the tour's), your real agents (no fake one), and a folder of made-up code that isn't a git repo, for "Pick a folder" and its git setup.
if [ "$1" = fresh ]; then
  unset ION_DEBUG ION_FAKE_BILLING ION_FAKE_SLOW_S
  # Ions think and the judge decides on opencode and Grok Build, never Claude (Plan 21 final review, M7).
  printf '[folders]\nprojects = "%s/projects"\n[ion]\nquick = "opencode"\n[access]\njudge = "grok-build"\n' "$ION_HOME" > "$ION_HOME/config.toml"
  export ION_AGENTS_HOME="$ION_HOME/agents-home" && mkdir -p "$ION_AGENTS_HOME"
  # Beside ion's home, not in it: ion refuses its own folders (Plan 21 Task 2).
  F="$ION_HOME-folders/tip-calc" && rm -rf "$ION_HOME-folders" && mkdir -p "$F/src"
  printf '# tip-calc\n\nA tiny tip calculator: `node src/tip.js 42.50 18` prints the tip and the total.\n' > "$F/README.md"
  printf 'const [bill, pct] = process.argv.slice(2).map(Number);\nconst tip = Math.round(bill * pct) / 100;\nconsole.log(`tip ${tip.toFixed(2)} · total ${(bill + tip).toFixed(2)}`);\n' > "$F/src/tip.js"
  if [ "$2" = none ]; then
    NODE_DIR="$(dirname "$(command -v node)")" && mkdir -p "$ION_HOME/bin" && ln -s "$NODE_DIR/node" "$ION_HOME/bin/node"
    PATH="$ION_HOME/bin:/usr/bin:/bin" ion daemon start >/dev/null
  else
    ion daemon start >/dev/null
  fi
  echo "A folder to add: $F"
  echo "Your real agents answer here: a message spends a little of opencode's free use (or Grok Build's)."
  app
  exit 0
fi
# ion thinks ([ion] quick) and judges ([access] judge) with the fake agent: no quota, no real model.
printf '[ion]\nquick = "fake"\n[access]\njudge = "fake"\n[folders]\nprojects = "%s/projects"\n' "$ION_HOME" > "$ION_HOME/config.toml"
# Plan 18: Tools in every state. mcp.json holds a local server (turned on below), a remote one whose ${TOUR_KEY}
# has no key yet (Add key), and one that wants OAuth (Sign in): a stub on this computer that answers 401 to
# everything, so signing in goes no further. One already answering (another tour's) is shared, not restarted.
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4719/mcp 2>/dev/null | grep -q 401 || (nohup node -e 'require("http").createServer((q, r) => { r.writeHead(401, { "WWW-Authenticate":
  `Bearer resource_metadata="http://127.0.0.1:4719/.well-known/oauth-protected-resource"` }); r.end(); }).listen(4719,
  "127.0.0.1")' ion-tour-oauth >/dev/null 2>&1 &)
cat > "$ION_HOME/mcp.json" <<'JSON'
{
  "mcpServers": {
    "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] },
    "search": {
      "type": "http",
      "url": "https://search.example.com/mcp",
      "headers": { "Authorization": "Bearer ${TOUR_KEY}" }
    },
    "notes": { "type": "http", "url": "http://127.0.0.1:4719/mcp" },
    "github-mcp": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}" }
    }
  }
}
JSON
chmod 600 "$ION_HOME/mcp.json" # yours alone, or Connections says others can read the keys in it
# Your agents' own configs, for Import and Skills: a fake home (ION_AGENTS_HOME), so the tour never reads yours.
export ION_AGENTS_HOME="$ION_HOME/agents-home"
put() { mkdir -p "$(dirname "$ION_AGENTS_HOME/$1")" && cat > "$ION_AGENTS_HOME/$1"; }
put .claude.json <<'JSON'
{ "mcpServers": { "weather": { "command": "npx", "args": ["-y", "@example/weather-mcp"] },
  "tickets": { "type": "http", "url": "https://tickets.example.com/mcp" } } }
JSON
# weather is in Claude Code and Codex alike (one row, both faces); tickets in Codex runs something else (Differs).
put .codex/config.toml <<'TOML'
[mcp_servers.docs]
command = "npx"
args = ["-y", "@example/docs-mcp"]

[mcp_servers.weather]
command = "npx"
args = ["-y", "@example/weather-mcp"]

[mcp_servers.tickets]
command = "tickets-mcp"

[plugins."sales@curated"]
enabled = true
TOML
put .config/opencode/opencode.json <<'JSON'
{ "mcp": { "todo": { "type": "local", "command": ["npx", "-y", "@example/todo-mcp"] } },
  "plugin": ["opencode-notify@1.2.0"] }
JSON
# Plugins: Claude Code's (skills, a server and hooks ion leaves out) and Codex's.
P="$ION_AGENTS_HOME/.claude/plugins/cache/mkt/superpowers/5.0.0"
put .claude/plugins/installed_plugins.json <<JSON
{ "version": 2, "plugins": { "superpowers@mkt": [{ "scope": "user", "installPath": "$P", "version": "5.0.0" }] } }
JSON
put .claude/settings.json <<'JSON'
{ "enabledPlugins": { "superpowers@mkt": true },
  "permissions": { "allow": ["Bash(npm test)"], "deny": ["Bash(git push:*)"] } }
JSON
put .claude/plugins/cache/mkt/superpowers/5.0.0/.claude-plugin/plugin.json <<'JSON'
{ "name": "superpowers", "version": "5.0.0" }
JSON
for k in brainstorming writing-plans; do
  printf -- '---\nname: %s\ndescription: %s\n---\nSteps.\n' "$k" "$k" | put ".claude/plugins/cache/mkt/superpowers/5.0.0/skills/$k/SKILL.md"
done
echo '{ "hooks": { "SessionStart": [] } }' | put .claude/plugins/cache/mkt/superpowers/5.0.0/hooks/hooks.json
echo '{ "mcpServers": { "notes": { "command": "notes-mcp" } } }' | put .claude/plugins/cache/mkt/superpowers/5.0.0/.mcp.json
echo '{ "name": "sales", "version": "1.1.7" }' | put .codex/plugins/cache/curated/sales/1.1.7/.codex-plugin/plugin.json
printf -- '---\nname: pitch\ndescription: Writes a sales pitch.\n---\nPitch.\n' | put .codex/plugins/cache/curated/sales/1.1.7/skills/pitch/SKILL.md
put .claude/skills/release-notes/SKILL.md <<'MD'
---
name: release-notes
description: Writes release notes from the merged pull requests since the last tag.
---
List the merged pull requests since the last tag and group them by area.
MD
# An ion skill, for "/" in the message box (its marker phrase shows a skill was followed, on a real agent).
mkdir -p "$ION_HOME/skills/tour-check"
printf -- '---\nname: tour-check\ndescription: Checks the tour. Start the reply with TOUR-CHECK-OK.\n---\nStart your reply with the words TOUR-CHECK-OK, then answer.\n' > "$ION_HOME/skills/tour-check/SKILL.md"
ion daemon start >/dev/null
ion projects new storefront >/dev/null
ion projects new payments-api >/dev/null
# The projects' ions start their threads on the fake agent too (no quota).
node --input-type=module -e '
const c = await import("./packages/config/dist/index.js");
const f = process.env.ION_HOME + "/config.toml";
const { config } = c.loadUserConfig(f);
c.saveUserConfig(f, { ...config, projects: config.projects.map((p) => ({ ...p, harness: "fake" })) });'
# One chat per state: an edit, a question, a failure, a retry that works, one that gives up, a gated call.
for s in edit asks fail flaky overloaded gated; do ion ask "$s" -p storefront --harness fake >/dev/null 2>&1 || true; done
ion ask "hello" --harness fake >/dev/null 2>&1 # a plain chat, in default
# Task 5, 2026-11-22: memory a chat wrote names the chat by its title ("edit · now" read oddly): a real title.
ion ask "Pricing headline" -p storefront --harness fake >/dev/null 2>&1
ion ask "edit the onboarding email copy so it reads warmer and mentions the free trial length up front" \
  -p payments-api --harness fake >/dev/null 2>&1
# A question that ended without you: its run stopped before you answered (written below while ion is stopped).
ion ask "asks which color the button should be" -p storefront --harness fake >/dev/null 2>&1 || true
# Plan 11: what ion chief suggests. Written into the past while ion is stopped: storefront's ion asked the same thing
# on three Fridays (a routine), and the "edit" chat's last run failed four days ago (stalled, with changes).
ion daemon stop >/dev/null
node --input-type=module -e '
const { EventStore, openDb } = await import("./apps/daemon/dist/store/index.js");
const { allViews } = await import("./apps/daemon/dist/views/index.js");
const db = openDb(process.env.ION_HOME + "/data/ion.db");
const store = new EventStore(db, allViews);
const ago = (d, h, m = 0) => { const t = new Date(Date.now() - d * 864e5); t.setHours(h, m, 0, 0); return t.toISOString(); };
const add = (chatId, type, data, ts) => store.append({ chatId, runId: null, origin: "daemon", type, data, ts });
for (const [d, m] of [[15, 5], [8, 50], [1, 10]])
  add("ion:storefront", "ion.heard", { text: "Summarize this week’s merged PRs" }, ago(d, d === 8 ? 16 : 17, m));
const edit = db.prepare("SELECT chat_id AS id FROM view_chats WHERE title = ? AND project_id = ?").get("edit", "storefront");
add(edit.id, "run.finished", { status: "failed" }, ago(4, 11));
const ended = db.prepare("SELECT chat_id AS id FROM view_chats WHERE title LIKE ?").get("asks which%");
const q = ended && db.prepare("SELECT need_id AS needId, run_id AS runId FROM view_needs WHERE chat_id = ?").get(ended.id);
if (q) store.append({ chatId: ended.id, runId: q.runId, origin: "daemon", type: "need.resolved",
  data: { needId: q.needId, decision: "superseded", by: "daemon", why: "stopped" } });
// Plan 18 Task 8: github-mcp was added by the "edit" chat'"'"'s agent with `ion mcp add … --from <registry id>`: off, its
// source and chat on its row, and the chat'"'"'s line about it.
const fs = await import("node:fs");
const { parseMcp } = await import("./apps/daemon/dist/tools/mcp-file.js");
const { mcpHash } = await import("./apps/daemon/dist/api/tools-entries.js");
const { createAdded } = await import("./apps/daemon/dist/tools/added.js");
const gh = parseMcp(fs.readFileSync(process.env.ION_HOME + "/mcp.json", "utf8")).servers.find((x) => x.name === "github-mcp");
const at = new Date().toISOString();
createAdded(process.env.ION_HOME + "/data/added.json").put({ kind: "mcp", name: "github-mcp", hash: mcpHash(gh),
  source: "io.github.github/github-mcp-server", chatId: edit.id, at });
add(edit.id, "tool.added", { kind: "mcp", name: "github-mcp" }, at);
// Tour, 2026-11-21: a server a chat has used. The fake agent can'"'"'t call your servers, so the "hello" chat gets a
// run that used everything'"'"'s echo, written as Claude Code writes an MCP step (a real one: send a message on opencode).
const hello = db.prepare("SELECT chat_id AS id FROM view_chats WHERE title = ?").get("hello");
const r = "tour-mcp-run";
const { isDaemonOnly } = await import("./packages/schema/dist/index.js");
const step = (type, data, s) => store.append({ chatId: hello.id, runId: r, origin: isDaemonOnly(type) ? "daemon" : "adapter",
  type, data, ts: new Date(Date.now() - (10 - s) * 1000).toISOString() });
step("message.sent", { text: "Echo hello with the everything server" }, 1);
step("run.started", { harness: "fake", model: "fake", effort: null, authMethod: null }, 2);
step("tool.started", { toolId: "e1", name: "mcp__everything__echo", kind: "mcp", summary: "", input: "{\n  \"message\": \"hello\"\n}" }, 3);
step("tool.output", { toolId: "e1", text: "Echo: hello" }, 4);
step("tool.finished", { toolId: "e1", ok: true, summary: null }, 4);
step("message.completed", { text: "The everything server echoed: hello" }, 5);
step("run.finished", { status: "done" }, 6);
// Plan 19: memory files (made up): yours (a preference a chat changed, a chat suggestion, a person, to-dos, one due
// today and one done), a project file, a to-do the "Pricing headline" chat added (its line in the chat), and a file that
// cannot be read (its line in Settings).
const { openMemory } = await import("./apps/daemon/dist/memory/index.js");
const mem = openMemory(process.env.ION_HOME + "/data", store, db);
const day = (d) => { const t = new Date(Date.now() + d * 864e5); return [t.getFullYear(), t.getMonth() + 1, t.getDate()].map((n) => String(n).padStart(2, "0")).join("-"); };
const put = (scope, header, text, by) => mem.write({ scope, header, text, by });
const pricing = db.prepare("SELECT chat_id AS id FROM view_chats WHERE title = ?").get("Pricing headline");
// Task review, 2026-11-22: if that chat couldn'"'"'t start, the "edit" chat writes instead (the tour goes on).
const byChat = { chatId: (pricing ?? edit).id, runId: "tour-memory" };
const tabs = put("you", { name: "Tabs, not spaces", description: "Indent with tabs in every project", type: "preference" }, "Indent with tabs.", "you");
mem.write({ scope: "you", slug: tabs.slug, header: tabs.header, text: "Indent with **tabs**, width 2.\n\nSpaces only where a file already uses them.", expectHash: tabs.hash, by: byChat });
put("you", { name: "Short replies", description: "Answers in a few lines, details on request", type: "preference", suggested: "storefront" }, "Keep answers short. Offer details instead of writing them.", byChat);
put("you", { name: "Sam", description: "Designer on the storefront; reviews UI changes", type: "person" }, "Sam reviews UI changes on storefront and likes screenshots in the PR.", { ion: "chief" });
put("you", { name: "Renew the passport", description: "Renew the passport", type: "todo", status: "open", due: day(0) }, "Renew the passport.", "you");
put("you", { name: "Book the dentist", description: "Book the dentist", type: "todo", status: "done" }, "Book the dentist.", "you");
put({ projectId: "storefront" }, { name: "Deploy", description: "pnpm deploy from main; staging first", type: "reference" }, "Deploy with `pnpm deploy` from main. Staging first, then production.", { ion: "storefront" });
put({ projectId: "storefront" }, { name: "Check the headline on mobile", description: "Check the headline on mobile", type: "todo", status: "open", due: day(3) }, "Check the headline on mobile.", byChat);
fs.writeFileSync(process.env.ION_HOME + "/data/memory/projects/storefront/notes.md", "no header here\n");
db.close();'
# Plan 20 (made up): each agent's usage line, a limit handed to another agent (one asked, one on Auto after your
# "Always"), a chat Automatic routed, and past chats in storefront, so a short request there has an estimate.
node --input-type=module -e '
const { EventStore, openDb } = await import("./apps/daemon/dist/store/index.js");
const { allViews } = await import("./apps/daemon/dist/views/index.js");
const db = openDb(process.env.ION_HOME + "/data/ion.db");
const store = new EventStore(db, allViews);
const now = Date.now();
const at = (min) => new Date(now + min * 60_000).toISOString();
const { isDaemonOnly } = await import("./packages/schema/dist/index.js");
const add = (chatId, runId, type, data, min) =>
  store.append({ chatId, runId, origin: isDaemonOnly(type) ? "daemon" : "adapter", type, data, ts: at(min) });
const chat = (id, title, min, projectId = "storefront") => add(id, null, "chat.created", { title, projectId }, min);
const run = (chatId, runId, harness, text, min, o = {}) => {
  add(chatId, runId, "message.sent", { text, ...(o.handoff ? { handoff: true } : {}) }, min);
  add(chatId, runId, "run.queued", { access: "auto" }, min);
  if (o.before) o.before();
  add(chatId, runId, "run.started", { harness, model: "tour", effort: null, authMethod: "Signed in" }, min + 0.1);
};
const reply = (chatId, runId, text, tokens, min, costUsd) => {
  add(chatId, runId, "message.completed", { text }, min);
  add(chatId, runId, "usage.reported", { model: "tour", inputTokens: tokens - 900, outputTokens: 900, totalTokens: tokens,
    ...(costUsd ? { costUsd } : {}) }, min);
  add(chatId, runId, "run.finished", { status: "done" }, min);
};
const limit = (chatId, runId, who, resetsAt, min) => {
  add(chatId, runId, "error", { code: "usage_limit", retryable: false, message: `${who} usage limit reached`, limit: { resetsAt } }, min);
  add(chatId, runId, "run.finished", { status: "failed" }, min);
};
// Asked, then Continue: Claude Code hit its limit 20 minutes ago (limited until its reset); Grok Build went on.
const a = "chat_tour-handoff";
chat(a, "Make the pricing table responsive", -25);
run(a, "tour-ho-1", "claude-code", "Make the pricing table stack its columns on small screens", -25);
add(a, "tour-ho-1", "tool.started", { toolId: "r1", name: "Read", kind: "read", summary: "src/pricing.css" }, -24);
add(a, "tour-ho-1", "tool.finished", { toolId: "r1", ok: true, summary: null }, -24);
limit(a, "tour-ho-1", "Claude", at(70), -20);
run(a, "tour-ho-2", "grok-build", "ion’s brief: the request, what was done, the last error. Check git status and the tests before continuing.", -19, {
  handoff: true,
  before: () => add(a, null, "chat.handoff", { kind: "continued", text: "Continued on Grok Build — Claude Code hit its limit", to: "grok-build" }, -19),
});
reply(a, "tour-ho-2", "git status showed the earlier step changed nothing, so I made the change: the pricing table stacks its columns under 640px. The tests pass.", 46_000, -15);
// Yesterday, after your "Always continue on opencode here": Codex hit its limit and opencode went on, on Auto.
const b = "chat_tour-always";
chat(b, "Fix the coupon rounding", -1500);
add(b, null, "decision.recorded", { decisionId: "dtour01", needId: "ntour01", projectId: "storefront", question: "When an agent hits its limit here", choice: "Always continue on opencode", scope: "project", by: "you", allowKey: "handoff:opencode" }, -1499);
add(b, "tour-al-1", "message.sent", { text: "Round coupon discounts to the cent, half up" }, -1440);
add(b, "tour-al-1", "run.queued", { access: "full" }, -1440);
add(b, "tour-al-1", "run.started", { harness: "codex", model: "tour", effort: null, authMethod: "ChatGPT" }, -1440);
limit(b, "tour-al-1", "Codex", at(-1300), -1438);
run(b, "tour-al-2", "opencode", "ion’s brief: the request, what was done, the last error. Check git status and the tests before continuing.", -1437, {
  handoff: true,
  before: () => add(b, null, "chat.handoff", { kind: "continued", text: "Continued on opencode on Auto — Codex hit its limit · always here", to: "opencode" }, -1437),
});
add(b, "tour-al-2", "message.completed", { text: "Coupon discounts now round half up to the cent; added a test for 0.005." }, -1430);
add(b, "tour-al-2", "run.finished", { status: "done" }, -1430);
// Automatic picked the agent, and says why.
const c = "chat_tour-routed";
chat(c, "Tidy the footer links", -90);
add(c, "tour-ro-1", "message.sent", { text: "Tidy the footer links: one column on phones" }, -90);
add(c, null, "chat.handoff", { kind: "routed", text: "On opencode — free and enough for this", to: "opencode" }, -90);
add(c, "tour-ro-1", "run.queued", { access: "auto" }, -90);
add(c, "tour-ro-1", "run.started", { harness: "opencode", model: "tour", effort: null, authMethod: "Signed in" }, -90);
add(c, "tour-ro-1", "message.completed", { text: "The footer links are one column under 640px." }, -88);
add(c, "tour-ro-1", "run.finished", { status: "done" }, -88);
// Five past chats in storefront (short changes) on the fake agent, paid per use there: a short change in storefront
// (By usage picks the project’s agent) says what it usually costs; and three on Grok Build, which say nothing yet.
const past = [["Rename the cart button to Checkout", 28_000, 0.18], ["Add alt text to the hero image", 31_000, 0.21],
  ["Fix the typo in the FAQ", 24_000, 0.12], ["Make the promo banner dismissible", 52_000, 0.41],
  ["Sort the size picker small to large", 37_000, 0.26], ["Lazy-load the review photos", 44_000],
  ["Trim the checkout page’s bundle", 61_000], ["Add a skeleton to the product grid", 39_000]];
past.forEach(([text, tokens, cost], i) => {
  const id = `chat_tour-past-${i}`;
  const min = -(2 + i) * 1440;
  chat(id, text, min);
  run(id, `tour-past-${i}`, cost ? "fake" : "grok-build", text, min);
  reply(id, `tour-past-${i}`, "Done.", tokens, min + 2, cost);
});
// Usage the agents reported: Codex’s windows; the fake agent (paid per use on the tour) with this week’s cost.
add(null, null, "usage.reported", { harness: "codex", model: "tour", inputTokens: 52_000, outputTokens: 3_000,
  windows: [{ name: "5 h", usedPercent: 62, resetsAt: at(140) }, { name: "week", usedPercent: 28, resetsAt: at(4 * 1440) }] }, -30);
add(null, null, "usage.reported", { harness: "fake", model: "fake", inputTokens: 210_000, outputTokens: 12_000, costUsd: 0.06 }, -300);
db.close();
// Plan 21 Task 5 (made up): last night'"'"'s agent checks, Grok Build fine and opencode with one that failed, for the line in
// Settings → Agents and what it opens. The nightly check stays off, so the tour never checks your real agents.
const fs = await import("node:fs");
const night = new Date(now - 864e5); night.setHours(2, 10, 0, 0);
const ok = (name) => ({ name, ok: true });
const rec = (agent, label, checks) => ({ agent, label, at: night.toISOString(), by: "night", checks });
fs.writeFileSync(process.env.ION_HOME + "/data/agent-checks.json", JSON.stringify({ night: null, noted: [], pending: [], last: [
  rec("grok-build", "Grok Build", [ok("Signed in"), ok("Starts"), ok("Answers"), ok("ion\u0027s tools"), ok("Gate")]),
  rec("opencode", "opencode", [ok("Signed in"), ok("Starts"), ok("Answers"), ok("ion\u0027s tools"),
    { name: "Gate", ok: false, note: "No call reached ion\u0027s gate" }]),
] }, null, 2), { mode: 0o600 });'
ion daemon start >/dev/null
# Plan 09, 14: a thread storefront's ion started, and ion chief routing a message to two projects (each a turn of
# the fake agent, starting threads with ion's start_thread tool).
ion ions message storefront "please check storefront for the readme typo" >/dev/null 2>&1
ion ions message storefront "what project am i in?" >/dev/null 2>&1 # answered by its ion, no thread
ion ions message chief "please check storefront and payments-api for the rounding bug" >/dev/null 2>&1
# Plan 10: routines, so Activity has what's next and a routine's run today.
ion routines add "Morning check" -p storefront -w "weekdays 9:00" -d "edit" >/dev/null
ion routines add "Dependency update" -p payments-api -w "mon 10:00" -d "edit the readme" --effort low >/dev/null
ion routines run morning-check >/dev/null 2>&1
# Plan 18: the local server and the OAuth one on (it then shows Sign in), and a hook on A chat finishes.
node --input-type=module -e '
const { connect, readDaemonInfo } = await import("./packages/client/dist/index.js");
const c = await connect(readDaemonInfo(process.env.ION_HOME + "/data"));
for (const id of ["everything", "notes"]) await c.call("tools.setOn", { kind: "mcp", id, on: true });
await c.call("tools.addHook", { name: "Log", event: "run.finished", run: `echo done >> ${process.env.ION_HOME}/hooks.log` });
c.close();'
# Plan 18 Task 8: a question you answered ("Always" for the project) stays in its chat, where it was asked.
ion ask "asks" -p payments-api --harness fake >/dev/null 2>&1 || true
node --input-type=module -e '
const { connect, readDaemonInfo } = await import("./packages/client/dist/index.js");
const c = await connect(readDaemonInfo(process.env.ION_HOME + "/data"));
const chat = (await c.call("chats.list", {})).find((x) => x.title === "asks" && x.projectId === "payments-api");
const need = (await c.call("needs.list", { chatId: chat.chatId }))[0];
if (need) await c.call("need.answer", { needId: need.needId, choice: 1, scope: "project" });
c.close();'
# Plan 18 Part 2 (Task 11): a repo's own server (storefront's .mcp.json runs repo code: it asks in each chat), "/"
# and "@" picks on a message, "Ions can use" on everything's echo, and a call ion isn't sure about (the fake judge
# says unsure for "unsure-me"), asked with the Remember checkbox.
SF="$(node -e 'const c=require("fs").readFileSync(process.env.ION_HOME+"/config.toml","utf8");console.log((/path = "([^"]*storefront)"/.exec(c)||[])[1]||"")')"
[ -n "$SF" ] && printf '{ "mcpServers": { "lint": { "command": "node", "args": ["./tools/lint-mcp.js"] } } }\n' > "$SF/.mcp.json"
node --input-type=module -e '
const { connect, readDaemonInfo } = await import("./packages/client/dist/index.js");
const c = await connect(readDaemonInfo(process.env.ION_HOME + "/data"));
const skill = (await c.call("tools.list", {})).skills.find((x) => x.name === "tour-check");
if (skill) await c.call("tools.setOn", { kind: "skill", id: skill.id, on: true });
await c.call("ask", { text: "hello", projectId: "storefront", harness: "fake", skills: ["tour-check"],
  mentions: ["everything"] }).catch((e) => console.error("picks:", e.message));
const tools = await c.call("tools.serverTools", { id: "everything" }).catch(() => null);
if (tools?.tools?.some((t) => t.name === "echo")) await c.call("tools.setIonUse", { id: "everything", tool: "echo", on: true });
c.close();'
(ion ask "gated npm install unsure-me" -p storefront --harness fake >/dev/null 2>&1 &) # waits on you 4 minutes
(ion ask "slow" -p payments-api --harness fake >/dev/null 2>&1 &) # running while you look
# Plan 20: a chat that waits for its agent's reset (the fake's limit, you picked Wait); one ion chat at a time, so a
# routine's chat waits behind another ("Waiting — 1 ion chat running"). (A new chat is on Automatic by itself.)
ion ask "limited — tidy the checkout copy" -p payments-api --harness fake >/dev/null 2>&1 || true
node --input-type=module -e '
const { connect, readDaemonInfo } = await import("./packages/client/dist/index.js");
const c = await connect(readDaemonInfo(process.env.ION_HOME + "/data"));
const chat = (await c.call("chats.list", {})).find((x) => x.title.startsWith("limited"));
const need = chat && (await c.call("needs.list", { chatId: chat.chatId }))[0];
if (need) await c.call("need.answer", { needId: need.needId, choice: 2 });
if (chat) await c.call("chat.rename", { chatId: chat.chatId, title: "Tidy the checkout copy" });
await c.call("settings.set", { patch: { maxRuns: 1 } });
c.close();'
ion routines add "Hold" -p storefront -w "sun 3:00" -d "slow" >/dev/null
(ion routines run hold >/dev/null 2>&1 &)
sleep 2
(ion routines run dependency-update >/dev/null 2>&1 &)
sleep 2
app
