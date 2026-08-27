#!/usr/bin/env bash
# theme-factory M1: the spec contract + the deterministic scaffolder, offline.
set -euo pipefail
cd "$(dirname "$0")/../../.."

echo "-- the ThemeSpec contract (validator subset, cross-checks, enum naming)"
node --test pipeline/tests/theme-spec.test.mjs

echo "-- the scaffolder (byte determinism, skeleton file sets, poison containment)"
( cd x-agent/mcp && npx vitest run ../tests/theme-factory.test.ts )

echo "-- byte determinism through dist (the compiled artifact scaffolds identically twice)"
node - <<'EOF'
import { mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldTheme } from './x-agent/mcp/dist/mcp/src/themeFactory.js';

const spec = {
    version: 1,
    identity: { name: 'Salon Regale Theme', slug: 'salon-regale', description: 'A bespoke ground for the Salon Regale.' },
    skeleton: 'rail',
    measure: { contentSize: '680px', wideSize: '1080px' },
    physics: { blockGap: '1.5rem', rootPadding: { top: '0px', right: '24px', bottom: '0px', left: '24px' } },
    presets: { shadows: [{ slug: 'lift', name: 'Lift', shadow: '0 8px 24px rgba(0,0,0,0.12)' }], gradients: [], duotones: [], custom: {} },
};
const a = scaffoldTheme(spec, { dir: mkdtempSync(join(tmpdir(), 'tf-m1-a-')) });
const b = scaffoldTheme(spec, { dir: mkdtempSync(join(tmpdir(), 'tf-m1-b-')) });
execSync(`diff -r ${a.dir} ${b.dir}`);
console.log('byte-identical rail scaffolds, rail width', a.rail_width);
EOF

echo "TF-M1 ACCEPTED"
