#!/usr/bin/env bash
# theme-factory M3: the stage, the flags, the budget, the resume.
#   1. --bespoke without --new-site fails preflight NAMING the rule.
#   2. A fake-provider bespoke run to S1T: the printed ceiling includes T=1,
#      the ledger holds exactly {brief, theme}, the theme installs (the
#      instance's manifest serves its name), and --resume replays with ZERO new
#      calls and ZERO reinstalls (fingerprint stable).
#   3. A non-bespoke S1 ledger is byte-identical to the SAME run on main
#      (started_at/ms stripped) — pre-spec behavior untouched.
set -euo pipefail
cd "$(dirname "$0")/../../.."
REPO="$(pwd)"

echo "-- 1. the flag rule"
set +e
OUT="$(node pipeline/cli.mjs build "x" --bespoke 2>&1)"
CODE=$?
set -e
[ "$CODE" -ne 0 ] || { echo "expected a preflight failure"; exit 1; }
echo "$OUT" | grep -q -- "--bespoke is valid only alongside --new-site" || { echo "the rule was not named: $OUT"; exit 1; }

echo "-- 2. the bespoke stage against a live slot"
SLOT=tf-m3-accept
PORT=9492
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
RUN_OUT="$(mktemp)"
node pipeline/tests/accept/tf-m3-run.mjs "$SCRATCH" > "$RUN_OUT" 2>&1
cat "$RUN_OUT"
RUN_DIR="$(grep -o 'RUN_DIR=.*' "$RUN_OUT" | cut -d= -f2)"

grep -q "T=1" "$RUN_OUT" || { echo "the printed ceiling never named T=1"; exit 1; }
grep -q "the ground is bespoke" "$RUN_OUT" || { echo "S1T never announced the ground"; exit 1; }

TASKS="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RUN_DIR/ledger.json','utf8')).map(e=>e.task_type).sort().join(','))")"
[ "$TASKS" = "brief,theme" ] || { echo "ledger tasks: $TASKS (expected brief,theme)"; exit 1; }

URL="$(node -e "console.log(JSON.parse(require('fs').readFileSync('tools/.runtime/$SLOT.json','utf8')).url)")"
AUTH="$(node -e "const r=JSON.parse(require('fs').readFileSync('tools/.runtime/$SLOT.json','utf8'));console.log(Buffer.from(r.admin.user+':'+r.admin.app_password).toString('base64'))")"
NAME="$(curl -s -H "Authorization: Basic $AUTH" "$URL/?rest_route=/x-companion/v1/manifest" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).theme.name))")"
[ "$NAME" = "Salon Regale Theme" ] || { echo "manifest theme name: $NAME"; exit 1; }
FP1="$(curl -s -H "Authorization: Basic $AUTH" "$URL/?rest_route=/x-companion/v1/fingerprint" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).fingerprint))")"

echo "-- 2b. resume: zero new calls, zero reinstalls"
ENTRIES_BEFORE="$(wc -l < "$RUN_DIR/ledger.jsonl" | tr -d ' ')"
node pipeline/tests/accept/tf-m3-run.mjs "$SCRATCH" "$RUN_DIR" > /dev/null 2>&1
ENTRIES_AFTER="$(wc -l < "$RUN_DIR/ledger.jsonl" | tr -d ' ')"
[ "$ENTRIES_BEFORE" = "$ENTRIES_AFTER" ] || { echo "resume spent calls: $ENTRIES_BEFORE -> $ENTRIES_AFTER"; exit 1; }
FP2="$(curl -s -H "Authorization: Basic $AUTH" "$URL/?rest_route=/x-companion/v1/fingerprint" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).fingerprint))")"
[ "$FP1" = "$FP2" ] || { echo "resume moved the epoch: $FP1 -> $FP2 (a reinstall happened)"; exit 1; }

echo "-- 3. non-bespoke S1 ledger vs main (timestamps excepted)"
strip_ledger() {
    node -e "
const l = JSON.parse(require('fs').readFileSync('$1/ledger.json', 'utf8'));
console.log(JSON.stringify(l.map(({ started_at, ms, ...keep }) => keep), null, 2));"
}
run_s1() { # <cwd> <checkout> <until>
    node --input-type=module -e "
const { runPipeline } = await import('$2/pipeline/run.mjs');
const { runDir } = await runPipeline({ prompt: 'a cozy neighborhood bakery site', configPath: '$SCRATCH/pipeline.config.json', until: '$3', cwd: '$1', skipToolchain: true });
console.log(runDir);" 2>/dev/null
}
BRANCH_CWD="$(mktemp -d)"
BRANCH_RUN="$(run_s1 "$BRANCH_CWD" "$REPO" S1_brief)"
WT="$(mktemp -d)/main"
git worktree add --quiet "$WT" main
trap 'cleanup; git worktree remove --force "$WT" 2>/dev/null || true' EXIT
# The committed dist resolves zod & co. from node_modules, which a worktree
# does not share (the recorded worktree limitation) — borrow the checkout's.
ln -s "$REPO/x-agent/mcp/node_modules" "$WT/x-agent/mcp/node_modules"
MAIN_CWD="$(mktemp -d)"
MAIN_RUN="$(run_s1 "$MAIN_CWD" "$WT" S1_brief)"
diff <(strip_ledger "$BRANCH_RUN") <(strip_ledger "$MAIN_RUN") || { echo "the non-bespoke ledger drifted from main"; exit 1; }
echo "non-bespoke S1 ledger byte-identical to main (started_at/ms stripped)"

echo "TF-M3 ACCEPTED"
