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
  exit 0
fi
ion daemon stop >/dev/null 2>&1 || true
rm -rf "$ION_HOME" && mkdir -p "$ION_HOME"
# ion thinks ([ion] quick) and judges ([access] judge) with the fake agent: no quota, no real model.
printf '[ion]\nquick = "fake"\n[access]\njudge = "fake"\n[folders]\nprojects = "%s/projects"\n' "$ION_HOME" > "$ION_HOME/config.toml"
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
db.close();'
ion daemon start >/dev/null
# Plan 09: a thread storefront's ion started, and ion chief routing a message to two projects.
ion ions message storefront "edit the readme" >/dev/null 2>&1
ion ions message storefront "what project am i in?" >/dev/null 2>&1 # answered by its ion, no thread
ion ions message chief "please check storefront and payments-api for the rounding bug" >/dev/null 2>&1
# Plan 10: routines, so Activity has what's next and a routine's run today.
ion routines add "Morning check" -p storefront -w "weekdays 9:00" -d "edit" >/dev/null
ion routines add "Dependency update" -p payments-api -w "mon 10:00" -d "edit the readme" --effort low >/dev/null
ion routines run morning-check >/dev/null 2>&1
(ion ask "slow" -p payments-api --harness fake >/dev/null 2>&1 &) # running while you look
pgrep -f "apps/desktop.*vite" >/dev/null || (cd apps/desktop && nohup pnpm dev >/dev/null 2>&1 &)
sleep 3
node -e 'const j=require(process.env.ION_HOME+"/data/daemon.json");console.log(`http://127.0.0.1:5173/?port=${j.port}&token=${j.token}`)'
