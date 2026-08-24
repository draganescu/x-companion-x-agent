import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetMeter, Ledger } from '../budget.mjs';
import { createLlm } from '../lib/llm.mjs';
import * as s7 from '../stages/s7-repair.mjs';

const brief = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));
const PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));
const EPOCH = 'f2'.padEnd(64, '0');

const GOOD_TREE = { version: 1, epoch: EPOCH, blocks: [{ name: 'core/group', attributes: {}, innerBlocks: [] }] };
const BAD_TREE = { version: 1, epoch: EPOCH, blocks: [{ name: 'core/group', attributes: { glow: 11 }, innerBlocks: [] }] };

function makeCtx({ repairText, validateResults, artifacts }) {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s7-'));
    for (const d of ['trees', 'sections', 'blocks', 'packages']) mkdirSync(join(runDir, d), { recursive: true });
    // Section payload files (baseline source) for every section in the brief.
    for (const page of brief.pages) {
        for (const section of page.sections) {
            writeFileSync(join(runDir, 'sections', `${page.slug}--${section.id}.json`), JSON.stringify({
                page: { slug: page.slug, title: page.title },
                section,
                manifest_slice: {},
                pattern: section.id === 'hero'
                    ? { name: 'p/hero', title: 'H', parsed_tree: [{ name: 'core/cover', attributes: {}, innerBlocks: [] }] }
                    : null,
            }));
        }
    }
    // Tree artifact files matching the incoming artifact records.
    for (const [key, art] of Object.entries(artifacts.trees ?? {})) {
        writeFileSync(join(runDir, 'trees', `${key}.json`), JSON.stringify({ tree: art._tree ?? BAD_TREE, gate: { status: art.status } }));
    }
    const budget = new BudgetMeter({});
    budget.setCeiling(16);
    const ledger = new Ledger(runDir);
    const provider = { id: 'scripted', complete: async () => ({ text: repairText.shift() ?? '{}', usage: { input_tokens: 1, output_tokens: 1 } }) };
    const validations = [...validateResults];
    return {
        runDir, budget, ledger,
        config: { concurrency: 2 },
        llm: createLlm({ providers: new Map([['repair', { provider, model: 'm' }]]), promptsDir: PROMPTS_DIR, budget, ledger }),
        state: { brief: structuredClone(brief), fingerprint: EPOCH, artifacts, dead: [] },
        log: () => {},
        call: async (name) => {
            assert.equal(name, 'wp_validate');
            return { ok: true, data: validations.shift() ?? { valid: true, epoch_ok: true, diagnostics: [] } };
        },
    };
}

const failedArt = () => ({ status: 'fail', deferred: [], failures: [{ code: 'W_ATTR_UNKNOWN', path: '/blocks/0/attributes/glow', message: 'glow unknown' }] });

test('scenario A: one failed tree, repair passes its gate, exactly one repair call', async () => {
    const ctx = makeCtx({
        repairText: [JSON.stringify(GOOD_TREE)],
        validateResults: [{ valid: true, epoch_ok: true, diagnostics: [] }],
        artifacts: { trees: { 'home--hero': failedArt() }, blocks: {}, packages: {} },
    });
    await s7.run(ctx);
    assert.equal(ctx.state.artifacts.trees['home--hero'].status, 'repaired');
    const rec = JSON.parse(readFileSync(join(ctx.runDir, 'trees', 'home--hero.json'), 'utf8'));
    assert.deepEqual(rec.tree, GOOD_TREE);
    assert.equal(rec.gate.repaired, true);
    const repairEntries = ctx.ledger.entries.filter((e) => e.task_type === 'repair');
    assert.equal(repairEntries.length, 1);
    assert.deepEqual(ctx.state.dead, []);
});

test('scenario B: repair fails the gate again -> dead artifact, pattern baseline, verbatim diagnostics, no second call', async () => {
    const ctx = makeCtx({
        repairText: [JSON.stringify(GOOD_TREE)],
        validateResults: [{ valid: true, epoch_ok: true, diagnostics: [{ code: 'W_ATTR_UNKNOWN', severity: 'warning', path: '/blocks/0', message: 'still wrong' }] }],
        artifacts: { trees: { 'home--hero': failedArt() }, blocks: {}, packages: {} },
    });
    await s7.run(ctx);
    const art = ctx.state.artifacts.trees['home--hero'];
    assert.equal(art.status, 'baseline');
    assert.equal(ctx.state.dead.length, 1);
    assert.equal(ctx.state.dead[0].key, 'home--hero');
    assert.match(JSON.stringify(ctx.state.dead[0].diagnostics), /glow unknown/); // original diagnostics ride along verbatim
    const rec = JSON.parse(readFileSync(join(ctx.runDir, 'trees', 'home--hero.json'), 'utf8'));
    assert.equal(rec.gate.status, 'baseline');
    assert.equal(rec.tree.blocks[0].name, 'core/cover'); // the pattern baseline, not the failed tree
    assert.equal(ctx.ledger.entries.filter((e) => e.task_type === 'repair').length, 1);
});

test('scenario C: a dead block re-gates the deferred tree; failure -> baseline for the tree too', async () => {
    const blockDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s7-block-'));
    writeFileSync(join(blockDir, 'render.php'), '<?php // broken');
    const ctx = makeCtx({
        repairText: ['not json at all'], // block repair output is garbage -> dead (maxAttempts 1)
        validateResults: [
            // the re-gate of home--signup after the block died:
            { valid: false, epoch_ok: true, diagnostics: [{ code: 'E_UNKNOWN_BLOCK', severity: 'error', path: '/blocks/0', message: 'unknown block agent/signup-banner' }] },
        ],
        artifacts: {
            trees: { 'home--signup': { status: 'pass', deferred: ['agent/signup-banner'], failures: [], _tree: { version: 1, epoch: EPOCH, blocks: [{ name: 'agent/signup-banner', attributes: {}, innerBlocks: [] }] } } },
            blocks: { 'signup-banner': { status: 'fail', failures: [{ code: 'build_failed', message: 'php fatal' }], dir: blockDir, files: ['render.php'] } },
            packages: {},
        },
    });
    await s7.run(ctx);
    assert.equal(ctx.state.artifacts.blocks['signup-banner'].status, 'dead');
    assert.equal(ctx.state.artifacts.trees['home--signup'].status, 'baseline');
    assert.equal(ctx.state.dead.length, 2);
    const rec = JSON.parse(readFileSync(join(ctx.runDir, 'trees', 'home--signup.json'), 'utf8'));
    assert.equal(rec.gate.status, 'baseline');
    assert.equal(rec.tree.blocks[0].name, 'core/group'); // signup had no pattern: minimal honest slot
});
