#!/usr/bin/env bash
# M1 acceptance (spec M1_provider_shim_and_budget):
#  - fake routing resolves at preflight; missing task entry fails naming the task
#  - ceiling for the S=3,B=1,P=1,I=2 fixture is 16; the 17th call throws budget_exceeded
#  - identical runs produce identical ledgers (timestamps excepted) — mechanism
#    proven by the deterministic-sort unit test here; end-to-end by m6-determinism.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
node --test pipeline/tests/*.test.mjs
node - <<'EOF'
import { computeBudget, BudgetMeter } from './pipeline/budget.mjs';
import { readFileSync } from 'node:fs';
const brief = JSON.parse(readFileSync('pipeline/fixtures/brief.m1.json', 'utf8'));
const b = computeBudget(brief);
if (b.ceiling !== 16) throw new Error(`ceiling ${b.ceiling} != 16`);
console.log(`this brief costs at most ${b.ceiling} calls (S=${b.S}, B=${b.B}, P=${b.P}, I=${b.I})`);
const m = new BudgetMeter({}); m.spend('brief','brief'); m.setCeiling(16);
for (let i = 2; i <= 16; i++) m.spend('tree', `c${i}`);
try { m.spend('tree', 'c17'); throw new Error('17th call did NOT throw'); }
catch (e) { if (e.code !== 'budget_exceeded') throw e; console.log('17th call: budget_exceeded OK'); }
EOF
echo "M1 ACCEPTED"
