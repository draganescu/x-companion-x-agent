import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetMeter, Ledger } from '../budget.mjs';
import { createLlm } from '../lib/llm.mjs';
import { screenTreeLiterals } from '../lib/gates.mjs';
import * as s3b from '../stages/s3b-molecules.mjs';

const brief = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));
const PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));
const EPOCH = 'f2'.padEnd(64, '0');

const TOKENS = {
    palette: [{ slug: 'base', name: 'B', color: '#F6EFE6' }, { slug: 'contrast', name: 'C', color: '#3B2A1E' }, { slug: 'ember', name: 'E', color: '#D96C2C' }],
    spacing: { scale_unit: 'px', steps: [{ slug: '40', size: '1rem' }] },
    typography: { families: [{ slug: 'serif', name: 'S', fontFamily: 'Georgia' }], sizes: [{ slug: 'display', size: '4rem' }] },
    layout: { contentSize: '640px', wideSize: '1200px' },
};

const MOLECULES = [
    { id: 'hero-split', role: 'hero', when_to_use: 'The opening statement, copy left.', recipe: { blocks: ['core/group'], layout: 'split' }, style_refs: {}, region_id: 'r-hero' },
    { id: 'card-row', role: 'features', when_to_use: 'Short items that read as peers.', recipe: { blocks: ['core/columns'], layout: 'grid' }, style_refs: {} },
    { id: 'cta-band', role: 'cta', when_to_use: 'A band asking for one action.', recipe: { blocks: ['core/group'], layout: 'centered' }, style_refs: {} },
];

const cleanTree = (label) => ({
    version: 1, epoch: EPOCH,
    blocks: [{ name: 'core/group', attributes: { backgroundColor: 'base', style: { spacing: { padding: { top: 'var:preset|spacing|40' } } } }, innerBlocks: [{ name: 'core/heading', attributes: { content: label, level: 2 } }] }],
});

const literalTree = (label) => ({
    version: 1, epoch: EPOCH,
    blocks: [{ name: 'core/group', attributes: { style: { color: { background: '#D96C2C' } } }, innerBlocks: [{ name: 'core/heading', attributes: { content: label, level: 2 } }] }],
});

function makeCtx({ treeFor = cleanTree, saveOk = () => true, validDiagnostics = () => [] } = {}) {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s3b-'));
    mkdirSync(join(runDir, 'molecules'), { recursive: true });
    writeFileSync(join(runDir, 'tokens.json'), JSON.stringify(TOKENS));
    writeFileSync(join(runDir, 'manifest-blocks.json'), JSON.stringify({ 'core/group': {}, 'core/heading': {}, 'core/columns': {}, 'core/column': {}, 'core/buttons': {}, 'core/button': {} }));
    writeFileSync(join(runDir, 'molecules.json'), JSON.stringify({ molecules: MOLECULES }));
    writeFileSync(join(runDir, 'kit.json'), JSON.stringify({
        version: 1,
        source: { kind: 'synthesized', files: [], viewport: { width: 1440, height: 2000 } },
        tokens_candidates: { ...TOKENS, quantization_log: [] },
        content: [],
        regions: [{ id: 'r-hero', role: 'hero', box: { x: 0, y: 0, w: 1440, h: 700 }, style_refs: { background_palette_slug: 'base' } }],
    }));
    const budget = new BudgetMeter({});
    budget.setCeiling(40);
    const ledger = new Ledger(runDir);
    const provider = { id: 'scripted', complete: async (_t, _p, _payload, { label }) => ({ text: JSON.stringify(treeFor(label)), usage: { input_tokens: 1, output_tokens: 1 } }) };
    const calls = [];
    let epoch = EPOCH;
    return {
        runDir, budget, ledger, calls,
        config: { concurrency: 3 },
        llm: createLlm({ providers: new Map([['molecule', { provider, model: 'm' }]]), promptsDir: PROMPTS_DIR, budget, ledger }),
        state: { brief: structuredClone(brief), fingerprint: EPOCH, instance: { fingerprint: EPOCH } },
        logs: [],
        log(m) { this.logs.push(m); },
        call: async (name, args) => {
            calls.push([name, args, epoch]);
            if (name === 'wp_validate') return { ok: true, data: { valid: true, diagnostics: validDiagnostics(args) } };
            if (name === 'wp_compile') return { ok: true, data: { all_valid: true, markup: `<!-- wp:group --><!-- /wp:group -->`, registry_gaps: [] } };
            if (name === 'wp_pattern_save') {
                if (!saveOk(args)) return { ok: false, data: { code: 'pattern_policy', message: 'refused', hint: '' } };
                epoch = `${args.slug}-epoch`.padEnd(64, '0');
                return { ok: true, data: { saved: args.slug, replaced: false, total: calls.filter((c) => c[0] === 'wp_pattern_save').length, fingerprint: epoch } };
            }
            throw new Error(`unexpected tool ${name}`);
        },
    };
}

test('every molecule is built, compiled and saved as a pattern under the kit namespace', async () => {
    const ctx = makeCtx();
    await s3b.run(ctx);
    const saves = ctx.calls.filter((c) => c[0] === 'wp_pattern_save');
    assert.equal(saves.length, 3);
    assert.deepEqual(saves.map((c) => c[1].slug).sort(), [
        'agent/hearth-crumb-card-row',
        'agent/hearth-crumb-cta-band',
        'agent/hearth-crumb-hero-split',
    ].sort());
    // The pattern's description is the sentence a site editor reads in the inserter.
    assert.equal(saves[0][1].description, MOLECULES.find((m) => saves[0][1].slug.endsWith(m.id)).when_to_use);
    // content is compiler output, never hand-written (wp_pattern_save refuses otherwise).
    assert.ok(saves.every((c) => c[1].content.startsWith('<!-- wp:')));
    assert.equal(ctx.state.kit.saved.length, 3);
});

test('saves are SEQUENTIAL and each adopts the epoch the previous one moved', async () => {
    const ctx = makeCtx();
    await s3b.run(ctx);
    const seq = ctx.calls.filter((c) => ['wp_compile', 'wp_pattern_save'].includes(c[0]));
    // compile, save, compile, save, compile, save — never two saves in flight.
    assert.deepEqual(seq.map((c) => c[0]), ['wp_compile', 'wp_pattern_save', 'wp_compile', 'wp_pattern_save', 'wp_compile', 'wp_pattern_save']);
    // Each compile carries the fingerprint the previous save returned (R3).
    const compiles = ctx.calls.filter((c) => c[0] === 'wp_compile');
    const saves = ctx.calls.filter((c) => c[0] === 'wp_pattern_save');
    assert.equal(compiles[0][1].epoch, EPOCH);
    assert.equal(compiles[1][1].epoch, `${saves[0][1].slug}-epoch`.padEnd(64, '0'));
    assert.equal(compiles[2][1].epoch, `${saves[1][1].slug}-epoch`.padEnd(64, '0'));
    // The stage leaves the run holding the LAST fingerprint; every page tree uses it.
    const last = `${saves[2][1].slug}-epoch`.padEnd(64, '0');
    assert.equal(ctx.state.fingerprint, last);
    assert.equal(ctx.state.instance.fingerprint, last);
});

test('a hardcoded hex is a dead artifact, not a warning — it never reaches the site', async () => {
    const ctx = makeCtx({ treeFor: literalTree });
    await assert.rejects(s3b.run(ctx), (e) => e.code === 'gate_failed' && /no molecule survived/.test(e.message));
    assert.equal(ctx.calls.filter((c) => c[0] === 'wp_pattern_save').length, 0);
    // Two attempts each (the one metered schema-retry), all off-contract.
    assert.ok(ctx.ledger.entries.every((e) => e.outcome === 'schema_failed'));
    for (const m of MOLECULES) {
        assert.equal(ctx.state.artifacts.molecules[m.id].status, 'fail');
    }
});

test('one bad arrangement is dropped; the rest still become vocabulary', async () => {
    const ctx = makeCtx({ treeFor: (label) => (label === 'card-row' ? literalTree(label) : cleanTree(label)) });
    await s3b.run(ctx);
    assert.equal(ctx.state.kit.saved.length, 2);
    assert.deepEqual(ctx.state.kit.saved.map((s) => s.id), ['cta-band', 'hero-split']);
    assert.equal(ctx.state.artifacts.molecules['card-row'].status, 'fail');
});

test('an agent/ block in a molecule fails: shared vocabulary is core only', async () => {
    const ctx = makeCtx({
        validDiagnostics: () => [{ code: 'E_UNKNOWN_BLOCK', severity: 'error', path: '/blocks/0', message: 'agent/signup-banner is not registered' }],
    });
    await assert.rejects(s3b.run(ctx), (e) => e.code === 'gate_failed' && /no molecule survived/.test(e.message));
});

// ---- the literal screen itself ----------------------------------------------

test('the literal screen passes slugs and preset references', () => {
    assert.deepEqual(screenTreeLiterals(cleanTree('x')), []);
    assert.deepEqual(screenTreeLiterals({
        version: 1, epoch: EPOCH,
        blocks: [{ name: 'core/column', attributes: { width: '50%', fontSize: 'display', style: { spacing: { blockGap: 'var(--wp--preset--spacing--40)' } } } }],
    }), []);
});

test('the literal screen fails hex colours anywhere and absolute lengths under style', () => {
    const hex = screenTreeLiterals(literalTree('x'));
    assert.equal(hex.length, 1);
    assert.match(hex[0].message, /hex colour literal/);
    const len = screenTreeLiterals({
        version: 1, epoch: EPOCH,
        blocks: [{ name: 'core/heading', attributes: { style: { typography: { fontSize: '3rem' } } } }],
    });
    assert.equal(len.length, 1);
    assert.match(len[0].message, /absolute length/);
});

test('the literal screen is property-aware: no preset category means no failure', () => {
    // letter-spacing, line heights, hairline borders, radii — the token system
    // has no preset to spend these through, and the tree prompt's own editorial
    // details (letterspaced kickers) depend on them.
    assert.deepEqual(screenTreeLiterals({
        version: 1, epoch: EPOCH,
        blocks: [{ name: 'core/paragraph', attributes: { style: {
            typography: { letterSpacing: '0.22em', lineHeight: '1.4' },
            border: { radius: '4px', top: { width: '1px' } },
        } } }],
    }), []);
    // spacing and font sizes DO have presets — literals there stay dead.
    const spacing = screenTreeLiterals({
        version: 1, epoch: EPOCH,
        blocks: [{ name: 'core/group', attributes: { style: { spacing: { padding: { top: '32px' } } } } }],
    });
    assert.equal(spacing.length, 1);
    assert.match(spacing[0].message, /spacing preset/);
    // em never fails — relative to its own context, a mechanic (parity with
    // styleLiteralSeverity in the S5 CSS gate).
    assert.deepEqual(screenTreeLiterals({
        version: 1, epoch: EPOCH,
        blocks: [{ name: 'core/heading', attributes: { style: { typography: { fontSize: '1.2em' } } } }],
    }), []);
});
