#!/usr/bin/env bash
# M2 acceptance (spec M2_brief_and_tokens): S1+S2+S3 against a live Playground
# with one real provider. Provider keys come from .x-agent.json (or, bootstrap
# convenience, CEREBRAS_API_KEY / GEMINI_API_KEY in the environment).
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT="${X_PIPELINE_ACCEPT_PORT:-9410}"
SLOT=pipeline-accept

node tools/playground/stop.mjs --port "$PORT" 2>/dev/null || true
rm -f "tools/.runtime/$SLOT.json"
nohup node pipeline/lib/site-holder.mjs hold "$SLOT" "$PORT" > "tools/.runtime/$SLOT.boot.log" 2>&1 &
BOOT_PID=$!
trap 'node tools/playground/stop.mjs --port '"$PORT"' 2>/dev/null || true; kill "$BOOT_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 120); do [ -f "tools/.runtime/$SLOT.json" ] && break; sleep 2; done
if [ ! -f "tools/.runtime/$SLOT.json" ]; then echo "boot failed:"; tail -30 "tools/.runtime/$SLOT.boot.log"; exit 1; fi

# Merge the Playground connection into .x-agent.json, preserving provider keys.
python3 - "$SLOT" <<'EOF'
import json, os, sys
d = json.load(open(f'tools/.runtime/{sys.argv[1]}.json'))
cfg = {}
if os.path.exists('.x-agent.json'):
    cfg = json.load(open('.x-agent.json'))
cfg.update({'url': d['url'], 'user': d['admin']['user'], 'app_password': d['admin']['app_password']})
for k, env in (('cerebras_api_key','CEREBRAS_API_KEY'), ('gemini_api_key','GEMINI_API_KEY'),
               ('anthropic_api_key','ANTHROPIC_API_KEY'), ('openai_api_key','OPENAI_API_KEY')):
    if k not in cfg and os.environ.get(env):
        cfg[k] = os.environ[env]
json.dump(cfg, open('.x-agent.json','w'), indent=2)
os.chmod('.x-agent.json', 0o600)
EOF

# Route every task to the one configured real provider (cerebras).
python3 - <<'EOF'
import json
tasks = {t: {"provider": "cerebras", "model": "gpt-oss-120b"} for t in
         ("brief", "tokens", "tree", "block", "schema", "repair")}
tasks["brief"]["temperature"] = 0.5
tasks["tokens"]["temperature"] = 0.4
json.dump({"tasks": tasks, "concurrency": 3, "budget_hard_cap": 60},
          open('pipeline.config.json', 'w'), indent=2)
EOF

node pipeline/run.mjs "A one-page site for a small artisan bakery called Hearth & Crumb: warm, floury, honest. A hero, what we bake, and a newsletter signup that stores subscribers." \
    --until S3_tokens

RUN_DIR=$(ls -td runs/*/ | head -1)
node - "$RUN_DIR" <<'EOF'
import { readFileSync } from 'node:fs';
import { validateSchema } from './pipeline/lib/schema.mjs';
import { deriveThemeSpacing, deriveThemeLayout } from './pipeline/lib/tokens.mjs';
const dir = process.argv[2];
const read = (f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));

const schema = JSON.parse(readFileSync('pipeline/schemas/brief.schema.json', 'utf8'));
const brief = read('brief.json');
const issues = validateSchema(schema, brief);
if (issues.length) throw new Error(`brief.json invalid: ${JSON.stringify(issues.slice(0, 5))}`);

const state = read('state.json');
if (!state.budget?.ceiling) throw new Error('no budget fixed after S1');

const tokens = read('tokens.json');
const instance = read('instance.json');
const spacing = deriveThemeSpacing(instance.theme_tokens);
const layout = deriveThemeLayout(instance.theme_tokens);
if (JSON.stringify(tokens.spacing) !== JSON.stringify(spacing)) throw new Error('R9 spacing pass-through violated');
if (JSON.stringify(tokens.layout) !== JSON.stringify(layout)) throw new Error('R9 layout pass-through violated');

const dry = JSON.stringify(read('tokens-dry-run.json')).toLowerCase();
for (const p of brief.palette) {
    if (!dry.includes(p.color.toLowerCase())) throw new Error(`brief color ${p.color} missing from dry-run evidence`);
}
if (instance.fingerprint === instance.initial_fingerprint) throw new Error('fingerprint did not move on token apply');
console.log('M2 ACCEPTED — budget:', JSON.stringify(state.budget), '— fingerprint moved',
    instance.initial_fingerprint.slice(0, 8), '->', instance.fingerprint.slice(0, 8));
EOF
