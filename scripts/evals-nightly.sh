#!/bin/bash
# The live evals on the agents you name (for developers; each costs that agent's quota). Not ion's own nightly check
# (Settings → Agents → Check the agents each night): that one is small and runs inside ion.
#   scripts/evals-nightly.sh opencode grok      run them now on opencode and Grok Build
# Agents: opencode, grok, claude, codex. Results: .ion-evals/<date>-<time>.log, its table at the end.
# To run it each night, add a line to `crontab -e`:  0 3 * * * cd /path/to/ion && scripts/evals-nightly.sh opencode
set -e
cd "$(dirname "$0")/.."
[ $# -gt 0 ] || { echo "Name the agents: opencode grok claude codex" >&2; exit 2; }
for a in "$@"; do
  case "$a" in
    opencode) export ION_LIVE=1 ;;
    grok) export ION_LIVE_GROK=1 ;;
    claude) export ION_LIVE_CLAUDE=1 ;;
    codex) export ION_LIVE_CODEX=1 ;;
    *) echo "Unknown agent: $a (opencode grok claude codex)" >&2; exit 2 ;;
  esac
done
mkdir -p .ion-evals
log=".ion-evals/$(date +%Y-%m-%d-%H%M).log"
status=0
pnpm --filter @ion/daemon exec vitest run src/evals/live.test.ts >"$log" 2>&1 || status=$?
echo "$log"
exit $status
