#!/usr/bin/env bash
# M6 determinism (spec M6_end_to_end_determinism, clause 2): two runs with the
# fake provider over the same fixtures produce byte-identical artifacts and
# ledgers (timestamps excepted).
#
# Three fresh Playground boots: the core-only fingerprint is deterministic
# across boots (same WP + same plugins), identical token sets compile to the
# same fingerprint, and identical package registrations keep it — so a capture
# run and two replays all walk the same epoch sequence.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT="${X_PIPELINE_ACCEPT_PORT:-9410}"
SLOT=pipeline-accept
PROMPT="A one-page site for the Hearth & Crumb bakery: hero with one atmospheric photo, what we bake, and a newsletter signup with an email form that stores subscribers for staff review — the form needs a custom signup block and a subscriber storage package."
CAPTURE_DIR=$(mktemp -d /tmp/x-pipeline-m6-fixtures.XXXXXX)

boot() {
    node tools/playground/stop.mjs --port "$PORT" 2>/dev/null || true
    rm -f "tools/.runtime/$SLOT.json"
    nohup node pipeline/tests/accept/_playground.mjs hold "$SLOT" "$PORT" > "tools/.runtime/$SLOT.boot.log" 2>&1 &
    BOOT_PID=$!
    for i in $(seq 1 120); do [ -f "tools/.runtime/$SLOT.json" ] && break; sleep 2; done
    if [ ! -f "tools/.runtime/$SLOT.json" ]; then echo "boot failed:"; tail -30 "tools/.runtime/$SLOT.boot.log"; exit 1; fi
    python3 - "$SLOT" <<'EOF'
import json, os, sys
d = json.load(open(f'tools/.runtime/{sys.argv[1]}.json'))
cfg = json.load(open('.x-agent.json')) if os.path.exists('.x-agent.json') else {}
cfg.update({'url': d['url'], 'user': d['admin']['user'], 'app_password': d['admin']['app_password']})
for k, env in (('cerebras_api_key','CEREBRAS_API_KEY'), ('gemini_api_key','GEMINI_API_KEY')):
    if k not in cfg and os.environ.get(env):
        cfg[k] = os.environ[env]
json.dump(cfg, open('.x-agent.json','w'), indent=2)
os.chmod('.x-agent.json', 0o600)
EOF
}
stopper() { node tools/playground/stop.mjs --port "$PORT" 2>/dev/null || true; kill "${BOOT_PID:-0}" 2>/dev/null || true; }
trap stopper EXIT

config() { # $1 = provider mode: real | fake
    python3 - "$1" "$CAPTURE_DIR" <<'EOF'
import json, sys
mode, fixtures = sys.argv[1], sys.argv[2]
if mode == 'real':
    temps = {"brief": 0.5, "tokens": 0.4, "tree": 0.3, "block": 0.2, "schema": 0.2, "repair": 0.2}
    tasks = {t: {"provider": "cerebras", "model": "gpt-oss-120b", "temperature": temps[t]} for t in
             ("brief", "tokens", "tree", "block", "schema", "repair")}
else:
    tasks = {t: {"provider": "fake", "model": "fixtures", "options": {"fixtures_dir": fixtures}} for t in
             ("brief", "tokens", "tree", "block", "schema", "repair")}
json.dump({"tasks": tasks, "concurrency": 3, "budget_hard_cap": 80}, open('pipeline.config.json', 'w'), indent=2)
EOF
}

echo "== capture run (real provider, fixtures recorded)"
boot; config real
X_PIPELINE_CAPTURE=1 X_PIPELINE_CAPTURE_DIR="$CAPTURE_DIR" node pipeline/run.mjs "$PROMPT"
CAPTURE_RUN=$(ls -td runs/*/ | head -1)
stopper

echo "== replay A (fake provider over the captured fixtures)"
boot; config fake
node pipeline/run.mjs "$PROMPT"
RUN_A=$(ls -td runs/*/ | head -1)
stopper

echo "== replay B"
boot; config fake
node pipeline/run.mjs "$PROMPT"
RUN_B=$(ls -td runs/*/ | head -1)
stopper

node - "$RUN_A" "$RUN_B" <<'EOF'
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
const [a, b] = [process.argv[2], process.argv[3]];

const normalize = (dir, text) => text.replaceAll(dir.replace(/\/$/, ''), 'RUNDIR');
const compare = (rel) => {
    const ta = normalize(a, readFileSync(join(a, rel), 'utf8'));
    const tb = normalize(b, readFileSync(join(b, rel), 'utf8'));
    if (ta !== tb) throw new Error(`NOT byte-identical: ${rel}`);
};

compare('brief.json');
compare('tokens.json');
for (const f of readdirSync(join(a, 'trees'))) compare(join('trees', f));
for (const f of readdirSync(join(a, 'pages'))) compare(join('pages', f));

const ledger = (dir) => JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'))
    .map(({ started_at, ms, ...rest }) => rest);
const la = JSON.stringify(ledger(a), null, 1);
const lb = JSON.stringify(ledger(b), null, 1);
if (la !== lb) throw new Error('ledgers differ beyond timestamps');

console.log(`M6 DETERMINISM ACCEPTED — ${readdirSync(join(a, 'trees')).length} trees + pages byte-identical; ledgers identical (timestamps excepted); ${ledger(a).length} ledger entries.`);
EOF
