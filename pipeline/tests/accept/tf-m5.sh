#!/usr/bin/env bash
# theme-factory M5: the Font Library lane end to end, live, zero model spend.
# Google download (miss then hit), core font REST upload, activation via the
# tokens write, rendered-promise verify, the no-hotlink grep, and the
# activation-strip poison failing the S9 screen. The unit suites already pin
# "the ledger contains no font entries" and the report section.
set -euo pipefail
cd "$(dirname "$0")/../../.."

SLOT=tf-m5-accept
PORT=9493
LOG="$(mktemp)"
node pipeline/tests/accept/_theme-holder.mjs "$SLOT" "$PORT" > "$LOG" 2>&1 &
HOLDER=$!
cleanup() {
    kill "$HOLDER" 2>/dev/null || true
    node tools/playground/stop.mjs --port "$PORT" > /dev/null 2>&1 || true
}
trap cleanup EXIT
for i in $(seq 1 90); do grep -q READY "$LOG" && break; sleep 2; done
grep -q READY "$LOG" || { echo "instance never came up"; cat "$LOG"; exit 1; }

SCRATCH="$(node pipeline/tests/accept/_theme-scratch.mjs "tools/.runtime/$SLOT.json")"
node pipeline/tests/accept/tf-m5-run.mjs "$SCRATCH"

echo "TF-M5 ACCEPTED"
