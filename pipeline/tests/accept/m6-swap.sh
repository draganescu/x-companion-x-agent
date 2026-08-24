#!/usr/bin/env bash
# M6 swap (spec M6_end_to_end_determinism, clause 3): swapping the tree task's
# provider in pipeline.config.json changes ledger provider entries and NOTHING
# in the stage code (asserted by diff). Real swap: cerebras -> gemini.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT="${X_PIPELINE_ACCEPT_PORT:-9410}"
SLOT=pipeline-accept
PROMPT="A one-page site for a tiny plant nursery: a hero and a section about seasonal seedlings. No signup, no shop."

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

GEMINI_MODEL=$(python3 - <<'EOF'
import json, time, urllib.request
key = json.load(open('.x-agent.json'))['gemini_api_key']
models = []
for attempt in range(4):
    try:
        req = urllib.request.Request('https://generativelanguage.googleapis.com/v1beta/openai/models',
                                     headers={'Authorization': f'Bearer {key}'})
        models = [m['id'] for m in json.load(urllib.request.urlopen(req))['data']]
        break
    except Exception:
        time.sleep(3 * (attempt + 1))
flash = sorted(m for m in models if 'flash' in m and 'image' not in m and 'live' not in m and 'tts' not in m)
print((flash or models or ['gemini-flash-latest'])[-1].removeprefix('models/'))
EOF
)
echo "gemini text model: $GEMINI_MODEL"

CODE_HASH_BEFORE=$(git status --porcelain pipeline/stages pipeline/lib pipeline/providers | wc -l | tr -d ' ')

run_with_tree_provider() { # $1 provider, $2 model
    python3 - "$1" "$2" <<'EOF'
import json, sys
prov, model = sys.argv[1], sys.argv[2]
temps = {"brief": 0.5, "tokens": 0.4, "tree": 0.3, "block": 0.2, "schema": 0.2, "repair": 0.2}
tasks = {t: {"provider": "cerebras", "model": "gpt-oss-120b", "temperature": temps[t]} for t in
         ("brief", "tokens", "tree", "block", "schema", "repair")}
tasks["tree"] = {"provider": prov, "model": model}
json.dump({"tasks": tasks, "concurrency": 3, "budget_hard_cap": 80}, open('pipeline.config.json', 'w'), indent=2)
EOF
    node pipeline/run.mjs "$PROMPT" --until S4_sections
}

run_with_tree_provider cerebras gpt-oss-120b
RUN_A=$(ls -td runs/*/ | head -1)
run_with_tree_provider gemini "$GEMINI_MODEL"
RUN_B=$(ls -td runs/*/ | head -1)

CODE_HASH_AFTER=$(git status --porcelain pipeline/stages pipeline/lib pipeline/providers | wc -l | tr -d ' ')
if [ "$CODE_HASH_BEFORE" != "$CODE_HASH_AFTER" ]; then echo "stage/lib/provider code changed during the swap"; exit 1; fi

node - "$RUN_A" "$RUN_B" <<'EOF'
import { readFileSync } from 'node:fs';
const trees = (dir) => JSON.parse(readFileSync(`${dir}/ledger.json`, 'utf8')).filter((e) => e.task_type === 'tree');
const [a, b] = [trees(process.argv[2]), trees(process.argv[3])];
if (!a.length || !b.length) throw new Error('a run made no tree calls');
if (!a.every((e) => e.provider === 'cerebras')) throw new Error('run A tree provider not cerebras');
if (!b.every((e) => e.provider === 'gemini')) throw new Error('run B tree provider not gemini');
console.log(`M6 SWAP ACCEPTED — tree provider cerebras -> gemini via config only (${a.length} vs ${b.length} tree calls); zero code changes (git-clean pipeline/stages, lib, providers).`);
EOF
