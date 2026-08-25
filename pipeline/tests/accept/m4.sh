#!/usr/bin/env bash
# M4 acceptance (spec M4_factories), live Playground + real provider:
#  - one custom block: scaffold -> LLM files -> wp_block_build_test built:true,
#    front smoke clean, in exactly 1 call (+ at most 1 repair)
#  - one schema package: wp_schema_build_test built:true, uninstall_clean:true
#  - a scaffold URL-map warning fails preflight before any LLM call is spent
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

node pipeline/run.mjs "A one-page site for the Hearth & Crumb bakery: hero, what we bake, and a newsletter signup section with an email form that stores subscribers for staff review — the form must POST to a custom endpoint, so it needs a custom signup block and a subscriber storage package." \
    --until S7_repair

RUN_DIR=$(ls -td runs/*/ | head -1)
node - "$RUN_DIR" <<'EOF'
import { readFileSync } from 'node:fs';
const dir = process.argv[2];
const state = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8'));
const ledger = JSON.parse(readFileSync(`${dir}/ledger.json`, 'utf8'));

const blocks = Object.entries(state.artifacts.blocks ?? {});
const packages = Object.entries(state.artifacts.packages ?? {});
if (blocks.length !== 1) throw new Error(`expected exactly 1 custom block, got ${blocks.length}`);
if (packages.length !== 1) throw new Error(`expected exactly 1 schema package, got ${packages.length}`);

const [bslug, block] = blocks[0];
if (!['pass', 'repaired'].includes(block.status)) throw new Error(`block ${bslug} status ${block.status}: ${JSON.stringify(block.failures)}`);
const brec = JSON.parse(readFileSync(`${dir}/blocks/${bslug}.json`, 'utf8'));
if (!brec.zip_path && !block.zip_path) throw new Error('no zip for the block');
const smoke = brec.smoke ?? {};
if (smoke.front && (smoke.front.console_errors ?? []).length > 0) throw new Error('front smoke not clean');
const blockCalls = ledger.filter((e) => e.task_type === 'block' && e.label === `block/${bslug}`).length;
const blockRepairs = ledger.filter((e) => e.task_type === 'repair' && e.label === `blocks/${bslug}`).length;
if (blockCalls !== 1) throw new Error(`${blockCalls} block calls (expected exactly 1)`);
if (blockRepairs > 1) throw new Error(`${blockRepairs} block repairs (> 1)`);

const [pslug, pkg] = packages[0];
if (!['pass', 'repaired'].includes(pkg.status)) throw new Error(`package ${pslug} status ${pkg.status}: ${JSON.stringify(pkg.failures)}`);
const prec = JSON.parse(readFileSync(`${dir}/packages/${pslug}.json`, 'utf8'));
if (prec.smoke?.uninstall_clean !== true) throw new Error('uninstall_clean !== true');
if (!prec.zip_path && !pkg.zip_path) throw new Error('no zip for the package');

console.log(`M4 factories OK — block ${bslug}: ${block.status}, 1 call + ${blockRepairs} repair(s); package ${pslug}: ${pkg.status}, uninstall_clean.`);
EOF

# URL-map preflight, live: a public post type claiming /sample-page (the fresh
# Playground's own page) must fail BEFORE any LLM call is spent.
node - <<'EOF'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolchain } from './pipeline/lib/toolchain.mjs';
import * as s6 from './pipeline/stages/s6-schema-packages.mjs';

const tc = await createToolchain({});
const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-m4-urlmap-'));
mkdirSync(join(runDir, 'packages'), { recursive: true });
let llmCalls = 0;
const ctx = {
    runDir,
    config: { concurrency: 1 },
    call: tc.call,
    llm: { generate: async () => { llmCalls += 1; throw new Error('LLM must not be called'); } },
    state: {
        fingerprint: 'x',
        brief: {
            schema_packages: [{
                slug: 'clash',
                intent: 'A public catalog that collides with an existing page on purpose.',
                lifecycle_argument: 'Acceptance fixture: this package exists to prove the URL-map preflight fires before any generative spend.',
                post_types: [{ slug: 'sample-page', label: 'Clash', public: true }],
            }],
        },
    },
    log: () => {},
};
let failed = null;
try { await s6.run(ctx); } catch (e) { failed = e; }
await tc.dispose();
if (!failed || failed.code !== 'preflight_failed') throw new Error(`expected preflight_failed, got ${failed?.code}: ${failed?.message}`);
if (llmCalls !== 0) throw new Error('an LLM call was spent despite the URL-map warning');
console.log('M4 URL-map preflight OK — failed before any LLM call:', failed.message.slice(0, 100));
EOF

echo "M4 ACCEPTED"
