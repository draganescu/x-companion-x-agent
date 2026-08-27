#!/usr/bin/env bash
# theme-factory M6: the whole promise at once — REAL provider spend.
#   one prompt + --new-site --bespoke => an original named theme (admin-visible),
#   a measure the brief argued, a skeleton, a verified site, zero human input;
#   the SAME prompt without --bespoke => a stock-theme-grounded build, no theme
#   call anywhere; wp_snapshot carries the bespoke theme.
# Runs from a SCRATCH cwd so the repo root's .x-agent.json connection is never
# touched; boots its own sites on dedicated slots/ports; --no-images bounds the
# spend and removes the Gemini dependency (placeholders still ship + verify).
set -euo pipefail
cd "$(dirname "$0")/../../.."
REPO="$(pwd)"

KEYS="$(node -e "
const fs = require('fs');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync('.x-agent.json', 'utf8')); } catch {}
const keys = {};
for (const k of ['anthropic_api_key', 'cerebras_api_key', 'openai_api_key', 'gemini_api_key']) if (cfg[k]) keys[k] = cfg[k];
console.log(JSON.stringify(keys));
")"
if [ "$KEYS" = "{}" ]; then
    echo "TF-M6 SKIPPED: no provider key in .x-agent.json — the full-promise run needs real spend"
    exit 3
fi

PROMPT="a single-page site for Salon Regale, a quiet luxury hair salon in Vienna: a welcoming hero, a services section, and a visit section with hours and address"

SCRATCH="$(mktemp -d)"
node -e "
const fs = require('fs');
fs.writeFileSync('$SCRATCH/.x-agent.json', JSON.stringify($KEYS, null, 4) + '\n', { mode: 0o600 });
const repoCfg = JSON.parse(fs.readFileSync('$REPO/pipeline.config.json', 'utf8'));
if (!repoCfg.tasks.theme) repoCfg.tasks.theme = { ...repoCfg.tasks.brief, effort: 'high' };
fs.writeFileSync('$SCRATCH/pipeline.config.json', JSON.stringify(repoCfg, null, 4) + '\n');
"

cleanup() {
    node tools/playground/stop.mjs --port 9494 > /dev/null 2>&1 || true
    node tools/playground/stop.mjs --port 9495 > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "-- the bespoke run"
( cd "$SCRATCH" && node "$REPO/pipeline/cli.mjs" build "$PROMPT" --new-site --bespoke --no-images --slot tf-m6 --port 9494 )
RUN_DIR="$(ls -d "$SCRATCH"/runs/* | sort | tail -1)"

node -e "
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('$RUN_DIR/state.json', 'utf8'));
const ledger = JSON.parse(fs.readFileSync('$RUN_DIR/ledger.json', 'utf8'));
const assert = (c, w) => { if (!c) { console.error('FAILED: ' + w); process.exit(1); } console.log('ok: ' + w); };
assert(state.bespoke === true, 'the run carries state.bespoke');
assert(state.completed.includes('S1T_theme') && state.completed.includes('S9_verify'), 'S1T ran and the site verified (' + state.completed.join(' -> ') + ')');
assert(state.theme && state.theme.name && state.theme.slug, 'an original named theme: \"' + state.theme.name + '\" (' + state.theme.skeleton + ', ' + state.theme.measure.contentSize + '/' + state.theme.measure.wideSize + ')');
assert(ledger.filter((e) => e.task_type === 'theme').length >= 1, 'the theme call is in the ledger');
const spec = JSON.parse(fs.readFileSync('$RUN_DIR/theme/theme-spec.json', 'utf8'));
assert(spec.identity.slug === state.theme.slug, 'the ThemeSpec is the installed theme');
"

echo "-- the manifest serves the bespoke world"
node --input-type=module -e "
import { join } from 'node:path';
const { createToolchain } = await import('$REPO/pipeline/lib/toolchain.mjs');
const t = await createToolchain({ cwd: '$SCRATCH', providerKeys: {} });
const m = await t.call('wp_manifest', { summary: true });
const state = JSON.parse((await import('node:fs')).readFileSync('$RUN_DIR/state.json', 'utf8'));
const assert = (c, w) => { if (!c) { console.error('FAILED: ' + w); process.exit(1); } console.log('ok: ' + w); };
assert(m.ok, 'wp_manifest answered');
assert(m.data.theme.slug === state.theme.slug, 'manifest theme = the bespoke theme (' + m.data.theme.name + ')');
assert(String(m.data.theme_tokens.layout.contentSize) === state.theme.measure.contentSize, 'manifest measure = the argued measure (' + m.data.theme_tokens.layout.contentSize + ')');
const snap = await t.call('wp_snapshot', {});
assert(snap.ok, 'wp_snapshot exported');
const { execSync } = await import('node:child_process');
const listing = execSync('unzip -l ' + snap.data.zip_path).toString();
assert(listing.includes('theme/' + state.theme.slug + '/') || listing.includes('theme/style.css'), 'the snapshot carries the bespoke theme');
await t.dispose();
"

echo "-- the same prompt WITHOUT --bespoke stays stock-grounded"
( cd "$SCRATCH" && rm -f .x-agent.json && node -e "
const fs = require('fs');
fs.writeFileSync('.x-agent.json', JSON.stringify($KEYS, null, 4) + '\n', { mode: 0o600 });
" && node "$REPO/pipeline/cli.mjs" build "$PROMPT" --new-site --no-images --slot tf-m6b --port 9495 )
RUN_B="$(ls -d "$SCRATCH"/runs/* | sort | tail -1)"
node -e "
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('$RUN_B/state.json', 'utf8'));
const ledger = JSON.parse(fs.readFileSync('$RUN_B/ledger.json', 'utf8'));
const assert = (c, w) => { if (!c) { console.error('FAILED: ' + w); process.exit(1); } console.log('ok: ' + w); };
assert(!state.bespoke, 'no bespoke mode');
assert(!state.theme, 'no bespoke theme');
assert(ledger.every((e) => e.task_type !== 'theme'), 'zero theme calls in the ledger');
assert(state.completed.includes('S9_verify'), 'the stock-grounded build still verifies');
"

echo "TF-M6 ACCEPTED"
