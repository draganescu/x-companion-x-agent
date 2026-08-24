#!/usr/bin/env bash
# M5 acceptance (spec M5_publish_and_verify): the FULL pipeline, S1 through S9,
# against a live Playground — sequential installs, final-epoch compile, publish,
# nav/footer/front-page, the image pass, verification, one screenshot, report.
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

python3 - <<'EOF'
import json
temps = {"brief": 0.5, "tokens": 0.4, "tree": 0.3, "block": 0.2, "schema": 0.2, "repair": 0.2}
tasks = {t: {"provider": "cerebras", "model": "gpt-oss-120b", "temperature": temps[t]} for t in
         ("brief", "tokens", "tree", "block", "schema", "repair")}
json.dump({"tasks": tasks, "concurrency": 3, "budget_hard_cap": 80},
          open('pipeline.config.json', 'w'), indent=2)
EOF

node pipeline/run.mjs "A one-page site for the Hearth & Crumb bakery: hero with one atmospheric photo, what we bake, and a newsletter signup with an email form that stores subscribers for staff review — the form needs a custom signup block and a subscriber storage package."

RUN_DIR=$(ls -td runs/*/ | head -1)
node - "$RUN_DIR" <<'EOF'
import { readFileSync, existsSync } from 'node:fs';
const dir = process.argv[2];
const state = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8'));
const ledger = JSON.parse(readFileSync(`${dir}/ledger.json`, 'utf8'));
const report = readFileSync(`${dir}/report.md`, 'utf8');

if (!state.completed.includes('S9_verify')) throw new Error('run did not complete S9');

// installs sequential, and the assembled page tree carries the LAST install's fingerprint
const installs = state.installs ?? [];
if (installs.length < 1) throw new Error('no installs recorded');
const finalFp = installs[installs.length - 1].fingerprint;
const front = state.published.pages.find((p) => p.front_page);
const pageTree = JSON.parse(readFileSync(`${dir}/trees/page--${front.slug}.json`, 'utf8'));
if (pageTree.epoch !== finalFp) throw new Error(`page epoch ${pageTree.epoch.slice(0,8)} != last install ${finalFp.slice(0,8)}`);

// verify: one h1, every image loaded
const verify = JSON.parse(readFileSync(`${dir}/verify.json`, 'utf8'));
const h1s = (verify.a11y_outline ?? []).filter((h) => h.role === 'heading' && h.level === 1);
if (h1s.length !== 1) throw new Error(`${h1s.length} h1s on the front page`);
const images = verify.images ?? [];
if (images.length === 0) throw new Error('no images measured on the front page');
if (!images.every((i) => i.loaded === true && i.natural_w > 0)) throw new Error('an image did not load');

// exactly one screenshot
if (!existsSync(`${dir}/screenshot.png`)) throw new Error('no screenshot.png');

// clean run: predicted == actual per task type
if ((state.dead ?? []).length === 0) {
    const counts = {};
    for (const e of ledger) counts[e.task_type] = (counts[e.task_type] ?? 0) + 1;
    const b = state.budget;
    const predicted = { brief: 1, tokens: 1, tree: b.S, block: b.B, schema: b.P, repair: 0 };
    for (const [task, want] of Object.entries(predicted)) {
        const got = counts[task] ?? 0;
        if (got !== want) throw new Error(`task ${task}: predicted ${want}, actual ${got} (retries/repairs made this a non-clean run — rerun)`);
    }
    if ((counts.image ?? 0) > b.I) throw new Error(`image calls ${counts.image} > I=${b.I}`);
}
if (!/predicted vs spent/.test(report)) throw new Error('report missing the budget section');

console.log(`M5 ACCEPTED — ${state.published.pages.length} page(s) at ${front.link}; installs ${installs.map(i=>i.kind+':'+i.slug).join(', ')}; ${images.length} image(s) loaded; budget spent ${ledger.length} entries, ceiling ${state.budget.ceiling}.`);
EOF
