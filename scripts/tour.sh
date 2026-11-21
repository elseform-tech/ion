#!/bin/bash
# The UX tour (AGENTS.md): a fresh ion with every chat state, ion threads and ion chief, and the app in a browser.
#   scripts/tour.sh            start it; prints the app's address
#   scripts/tour.sh stop       stop the tour's ion and the app
# Needs a build (pnpm build). Uses the fake agent, so it costs no quota; send a real message with opencode's free
# model from the app as part of the tour.
set -e
cd "$(dirname "$0")/.."
export ION_HOME="${ION_TOUR_HOME:-/tmp/ion-tour}" ION_ALLOW_FAKE=1
ion() { node apps/cli/dist/index.js "$@"; }
if [ "$1" = stop ]; then
  ion daemon stop >/dev/null 2>&1 || true
  pkill -f "apps/desktop.*vite" >/dev/null 2>&1 || true
  pkill -f "ion-tour-oauth" >/dev/null 2>&1 || true
  exit 0
fi
ion daemon stop >/dev/null 2>&1 || true
rm -rf "$ION_HOME" && mkdir -p "$ION_HOME"
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
{ "enabledPlugins": { "superpowers@mkt": true } }
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
db.close();'
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
(ion ask "slow" -p payments-api --harness fake >/dev/null 2>&1 &) # running while you look
pgrep -f "apps/desktop.*vite" >/dev/null || (cd apps/desktop && nohup pnpm dev >/dev/null 2>&1 &)
sleep 3
# ION_TOUR_APP: the app's address when your vite runs elsewhere (another worktree's port).
node -e 'const j=require(process.env.ION_HOME+"/data/daemon.json");console.log(`${process.env.ION_TOUR_APP||"http://127.0.0.1:5173"}/?port=${j.port}&token=${j.token}`)'
