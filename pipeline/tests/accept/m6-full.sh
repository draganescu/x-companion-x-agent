#!/usr/bin/env bash
# M6 full-scope (spec M6_end_to_end_determinism, clause 1): one prompt of
# Moulin-Rouge-class scope produces a published, verified site in one run with
# zero human input; the report's dead-artifact list is empty.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT="${X_PIPELINE_ACCEPT_PORT:-9410}"
SLOT=pipeline-accept

node tools/playground/stop.mjs --port "$PORT" 2>/dev/null || true
rm -f "tools/.runtime/$SLOT.json"
nohup node pipeline/tests/accept/_playground.mjs hold "$SLOT" "$PORT" > "tools/.runtime/$SLOT.boot.log" 2>&1 &
BOOT_PID=$!
trap 'node tools/playground/stop.mjs --port '"$PORT"' 2>/dev/null || true; kill "$BOOT_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 120); do [ -f "tools/.runtime/$SLOT.json" ] && break; sleep 2; done
[ -f "tools/.runtime/$SLOT.json" ] || { echo "boot failed"; tail -30 "tools/.runtime/$SLOT.boot.log"; exit 1; }

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

python3 - <<'EOF'
import json
temps = {"brief": 0.5, "tokens": 0.4, "tree": 0.3, "block": 0.2, "schema": 0.2, "repair": 0.2}
tasks = {t: {"provider": "cerebras", "model": "gpt-oss-120b", "temperature": temps[t]} for t in
         ("brief", "tokens", "tree", "block", "schema", "repair")}
json.dump({"tasks": tasks, "concurrency": 3, "budget_hard_cap": 80},
          open('pipeline.config.json', 'w'), indent=2)
EOF

node pipeline/run.mjs "A landing page for Le Moulin Rouge, the Belle Époque cabaret: deep reds and golds, gaslight glamour, Toulouse-Lautrec poster energy. A dramatic hero with one atmospheric photograph of the windmill at dusk, a marquee strip announcing tonight's acts that needs a custom scrolling-marquee block, the cabaret's numbers (shows per week, dancers on stage, years of history) counting up as you scroll — a custom stats block, a story section about the house, and a guest-list newsletter capture with an email form: a custom signup block posting to a subscriber storage package the box office reviews."

RUN_DIR=$(ls -td runs/*/ | head -1)
node - "$RUN_DIR" <<'EOF'
import { readFileSync, existsSync } from 'node:fs';
const dir = process.argv[2];
const state = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8'));
const ledger = JSON.parse(readFileSync(`${dir}/ledger.json`, 'utf8'));
const report = readFileSync(`${dir}/report.md`, 'utf8');

if (!state.completed.includes('S9_verify')) throw new Error('run did not complete S9');
if ((state.dead ?? []).length > 0) throw new Error(`dead artifacts: ${JSON.stringify(state.dead.map((d) => d.key))}`);
if (!existsSync(`${dir}/screenshot.png`)) throw new Error('no screenshot');
const b = state.budget;
if (b.B < 2) throw new Error(`scope too small: B=${b.B} custom blocks (expected Moulin-Rouge-class, >= 2)`);
if (b.P < 1) throw new Error('no schema package in scope');
if (ledger.length > b.ceiling) throw new Error(`spent ${ledger.length} > ceiling ${b.ceiling}`);
const front = state.published.pages.find((p) => p.front_page);
console.log(`M6 FULL-SCOPE ACCEPTED — ${front.link}: S=${b.S} B=${b.B} P=${b.P} I=${b.I}, spent ${ledger.length}/${b.ceiling}, dead=0, verified + screenshot.`);
console.log(`evidence: ${dir}`);
EOF
