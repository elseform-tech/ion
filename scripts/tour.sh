#!/bin/bash
# The UX tour (AGENTS.md): a fresh ion with every chat state, and the app in a browser.
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
printf '[access]\njudge = "fake"\n[folders]\nprojects = "%s/projects"\n' "$ION_HOME" > "$ION_HOME/config.toml"
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
(ion ask "slow" -p payments-api --harness fake >/dev/null 2>&1 &) # running while you look
pgrep -f "apps/desktop.*vite" >/dev/null || (cd apps/desktop && nohup pnpm dev >/dev/null 2>&1 &)
sleep 3
node -e 'const j=require(process.env.ION_HOME+"/data/daemon.json");console.log(`http://127.0.0.1:5173/?port=${j.port}&token=${j.token}`)'
