#!/usr/bin/env bash
# theme-factory M2: the build gate + the install route, on live Playgrounds.
#   - wp_theme_build_test: built:true with MEASURED physics; the page-no-title
#     poison fails naming the template; the rail area registers (vitest live).
#   - POST /themes/install + wp_manifest: install/activate moves the epoch and
#     the manifest serves the bespoke name and measure (php suite, its own slot).
set -euo pipefail
cd "$(dirname "$0")/../../.."

echo "-- the sandbox gate (throwaway Playgrounds on 9480-9489)"
( cd x-agent/mcp && X_AGENT_THEME_LIVE=1 npx vitest run ../tests/live/theme-factory.test.ts )

SLOT=tf-m2-accept
PORT=9491
LOG="$(mktemp)"
node pipeline/tests/accept/_theme-holder.mjs "$SLOT" "$PORT" > "$LOG" 2>&1 &
HOLDER=$!
cleanup() {
    kill "$HOLDER" 2>/dev/null || true
    node tools/playground/stop.mjs --port "$PORT" > /dev/null 2>&1 || true
}
trap cleanup EXIT

for i in $(seq 1 90); do
    grep -q READY "$LOG" && break
    sleep 2
done
grep -q READY "$LOG" || { echo "instance never came up"; cat "$LOG"; exit 1; }

echo "-- the install route (dedicated slot $SLOT on $PORT)"
php x-companion/tests/test-themes.php --runtime "tools/.runtime/$SLOT.json"

echo "TF-M2 ACCEPTED"
