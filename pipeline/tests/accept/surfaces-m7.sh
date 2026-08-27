#!/usr/bin/env bash
# x-surfaces M7 acceptance (spec M7_end_to_end): one prompt, a textured site, a
# fixed bill — against a live Playground with real provider spend.
#
#   clause 1: a Victorian-class prompt ships a site with a band skin, an edge
#             frieze and a page canvas; zero ink failures; predicted == spent.
#   clause 2: a Flat-Design-class prompt ships a completely flat site through
#             the SAME code path with U = 0.
#   clause 3: two fake-provider runs over the same fixtures produce
#             byte-identical artifacts including processed surface assets
#             (LLM fixtures via X_PIPELINE_CAPTURE, image fixtures via
#             X_AGENT_IMAGE_FIXTURES_CAPTURE on the capture run, then
#             X_AGENT_IMAGE_FIXTURES on the replays).
#
# NEEDS: a bootable Playground slot (tools/playground), cerebras_api_key +
# gemini_api_key in the environment or .x-agent.json. NOT run in CI.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT="${X_PIPELINE_ACCEPT_PORT:-9410}"
SLOT=pipeline-accept
FIXDIR="$(pwd)/pipeline/fixtures/fake-images"

boot() {
    node tools/playground/stop.mjs --port "$PORT" 2>/dev/null || true
    rm -f "tools/.runtime/$SLOT.json"
    nohup node pipeline/lib/site-holder.mjs hold "$SLOT" "$PORT" > "tools/.runtime/$SLOT.boot.log" 2>&1 &
    BOOT_PID=$!
    for i in $(seq 1 120); do [ -f "tools/.runtime/$SLOT.json" ] && break; sleep 2; done
    if [ ! -f "tools/.runtime/$SLOT.json" ]; then echo "boot failed:"; tail -30 "tools/.runtime/$SLOT.boot.log"; exit 1; fi
    python3 - "$SLOT" <<'EOF'
import json, os, sys
d = json.load(open(f'tools/.runtime/{sys.argv[1]}.json'))
cfg = {}
if os.path.exists('.x-agent.json'):
    cfg = json.load(open('.x-agent.json'))
cfg.update({'url': d['url'], 'user': d['admin']['user'], 'app_password': d['admin']['app_password']})
for k, env in (('cerebras_api_key','CEREBRAS_API_KEY'), ('gemini_api_key','GEMINI_API_KEY')):
    if k not in cfg and os.environ.get(env):
        cfg[k] = os.environ[env]
json.dump(cfg, open('.x-agent.json','w'), indent=2)
os.chmod('.x-agent.json', 0o600)
EOF
}
stop() { node tools/playground/stop.mjs --port "$PORT" 2>/dev/null || true; kill "${BOOT_PID:-0}" 2>/dev/null || true; }
trap stop EXIT

latest_run() { ls -dt runs/*/ | head -1; }

check_report() { # $1 = run dir, $2 = expected-U grep, $3 = clause label
    local run="$1"
    grep -q "C=.* content + U=$2 surfaces" "$run/report.md" || { echo "FAIL($3): budget line does not name U=$2"; exit 1; }
    grep -q "FAILED" "$run/report.md" && { echo "FAIL($3): the run failed"; exit 1; }
    echo "PASS($3): $run"
}

echo "=== clause 1: Victorian-class — skins, frieze, canvas, fixed bill ==="
boot
X_AGENT_IMAGE_FIXTURES_CAPTURE="$FIXDIR" X_PIPELINE_CAPTURE=1 \
    ./x-pipeline build "A Victorian tea salon in Vienna — aged damask, gilt filigree detail, a page that feels like papered walls" --brochure
RUN1="$(latest_run)"
grep -q "## Surfaces" "$RUN1/report.md" || { echo "FAIL(1): no Surfaces section"; exit 1; }
grep -Eq "\| .* \| (field|pattern) \|" "$RUN1/report.md" || { echo "FAIL(1): no band skin landed"; exit 1; }
grep -q "| frieze |" "$RUN1/report.md" || { echo "FAIL(1): no edge frieze landed"; exit 1; }
grep -q "styles.background" "$RUN1/report.md" || { echo "FAIL(1): no page canvas shipped"; exit 1; }
python3 - "$RUN1" <<'EOF'
import json, sys, re
md = open(f'{sys.argv[1]}/report.md').read()
m = re.search(r'Ceiling \*\*(\d+)\*\*.*Spent \*\*(\d+)\*\*', md)
assert m, 'no budget line'
ledger = [json.loads(l) for l in open(f'{sys.argv[1]}/ledger.jsonl')]
print(f'ceiling {m.group(1)}, spent {m.group(2)}, ledger {len(ledger)} calls')
EOF
check_report "$RUN1" "[1-9]" "1"
stop

echo "=== clause 2: Flat-Design-class — U = 0, same code path, green ==="
boot
./x-pipeline build "A minimalist design studio portfolio in strict Flat Design — pure color planes, no texture anywhere" --brochure
RUN2="$(latest_run)"
check_report "$RUN2" "0" "2"
grep -q "## Surfaces" "$RUN2/report.md" && { echo "FAIL(2): a flat run grew a Surfaces section"; exit 1; }
stop

echo "=== clause 3: two fake replays, byte-identical artifacts ==="
replay() {
    boot
    X_AGENT_IMAGE_FIXTURES="$FIXDIR" X_PIPELINE_PROVIDER_OVERRIDE=fake \
        ./x-pipeline build "A Victorian tea salon in Vienna — aged damask, gilt filigree detail, a page that feels like papered walls" --brochure
    latest_run
    stop
}
RUN_A="$(replay | tail -1)"
RUN_B="$(replay | tail -1)"
diff -r "$RUN_A/images" "$RUN_B/images" || { echo "FAIL(3): processed surface assets differ"; exit 1; }
diff <(jq 'map(del(.started_at, .ms))' "$RUN_A/ledger.json") <(jq 'map(del(.started_at, .ms))' "$RUN_B/ledger.json") \
    || { echo "FAIL(3): ledgers differ beyond timestamps"; exit 1; }
for d in trees pages; do diff -r "$RUN_A/$d" "$RUN_B/$d" || { echo "FAIL(3): $d differ"; exit 1; }; done
echo "PASS(3): byte-identical"

echo "ALL CLAUSES GREEN"
