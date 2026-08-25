import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetMeter, Ledger } from '../budget.mjs';
import { createLlm } from '../lib/llm.mjs';
import * as s4 from '../stages/s4-sections.mjs';

const brief = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));
const PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));
const EPOCH = 'f2'.padEnd(64, '0');

const TOKENS = {
    palette: [
        { slug: 'base', name: 'B', color: '#F6EFE6' },
        { slug: 'contrast', name: 'C', color: '#3B2A1E' },
        { slug: 'ember', name: 'E', color: '#D96C2C' },
    ],
    spacing: { scale_unit: 'px', steps: [{ slug: '40', size: '1rem' }] },
    typography: { families: [{ slug: 'serif', name: 'S', fontFamily: 'Georgia' }], sizes: [{ slug: 'display', size: '4rem' }] },
    layout: { contentSize: '640px', wideSize: '1200px' },
};

function treeFor(label, extra = {}) {
    return {
        version: 1,
        epoch: EPOCH,
        blocks: [{ name: 'core/group', attributes: { backgroundColor: 'base' }, innerBlocks: [{ name: 'core/heading', attributes: { content: label } }] }],
        ...extra,
    };
}

function makeCtx({ treesByLabel, validateByKey }) {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s4-'));
    for (const d of ['trees', 'sections']) mkdirSync(join(runDir, d), { recursive: true });
    writeFileSync(join(runDir, 'tokens.json'), JSON.stringify(TOKENS));
    const sections = [];
    for (const page of brief.pages) {
        for (const section of page.sections) {
            const key = `${page.slug}--${section.id}`;
            const file = join('sections', `${key}.json`);
            writeFileSync(join(runDir, file), JSON.stringify({
                page: { slug: page.slug, title: page.title },
                section,
                manifest_slice: { blocks: { 'core/group': {}, 'core/heading': {} } },
                pattern: { name: 'p/x', title: 'X', parsed_tree: [{ name: 'core/group', attributes: {}, innerBlocks: [] }] },
            }));
            sections.push({ key, page: page.slug, id: section.id, file });
        }
    }
    const budget = new BudgetMeter({});
    budget.setCeiling(16);
    const ledger = new Ledger(runDir);
    const payloads = {};
    const provider = {
        id: 'scripted',
        complete: async (_t, _p, payload, { label }) => {
            payloads[label] = payload;
            return { text: JSON.stringify(treesByLabel[label]), usage: { input_tokens: 1, output_tokens: 1 } };
        },
    };
    let active = 0;
    let peak = 0;
    return {
        runDir, budget, ledger, payloads,
        config: { concurrency: 2 },
        llm: createLlm({ providers: new Map([['tree', { provider, model: 'm' }]]), promptsDir: PROMPTS_DIR, budget, ledger }),
        state: { brief: structuredClone(brief), fingerprint: EPOCH, sections },
        log: () => {},
        peak: () => peak,
        call: async (name, tree) => {
            assert.equal(name, 'wp_validate');
            active += 1; peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 5));
            active -= 1;
            const key = tree.blocks[0].innerBlocks?.[0]?.attributes?.content ?? '?';
            return { ok: true, data: validateByKey[key] ?? { valid: true, epoch_ok: true, diagnostics: [] } };
        },
    };
}

test('S4 fans out per section, screens diagnostics, defers the declared block', async () => {
    const treesByLabel = {
        'home/hero': treeFor('home/hero'),
        'home/what-we-bake': treeFor('home/what-we-bake'),
        'home/signup': treeFor('home/signup'),
    };
    const validateByKey = {
        'home/what-we-bake': { valid: true, epoch_ok: true, diagnostics: [{ code: 'W_STATIC_NEEDS_HARNESS', severity: 'warning', path: '/blocks/0', message: 'static' }] },
        'home/signup': { valid: false, epoch_ok: true, diagnostics: [{ code: 'E_UNKNOWN_BLOCK', severity: 'error', path: '/blocks/0', message: 'unknown block agent/signup-banner' }] },
    };
    const ctx = makeCtx({ treesByLabel, validateByKey });
    await s4.run(ctx);
    const arts = ctx.state.artifacts.trees;
    assert.equal(arts['home--hero'].status, 'pass');
    assert.equal(arts['home--what-we-bake'].status, 'pass');
    assert.equal(arts['home--signup'].status, 'pass');
    assert.deepEqual(arts['home--signup'].deferred, ['agent/signup-banner']);
    assert.ok(existsSync(join(ctx.runDir, 'trees', 'home--hero.json')));
    assert.ok(ctx.peak() <= 2);
    assert.equal(ctx.budget.spent, 3);
});

test('a W_ATTR_UNKNOWN artifact records fail and the stage still completes', async () => {
    const treesByLabel = {
        'home/hero': treeFor('home/hero'),
        'home/what-we-bake': treeFor('home/what-we-bake'),
        'home/signup': treeFor('home/signup'),
    };
    const validateByKey = {
        'home/hero': { valid: true, epoch_ok: true, diagnostics: [{ code: 'W_ATTR_UNKNOWN', severity: 'warning', path: '/blocks/0/attributes/glow', message: 'glow is not an attribute' }] },
    };
    const ctx = makeCtx({ treesByLabel, validateByKey });
    await s4.run(ctx);
    assert.equal(ctx.state.artifacts.trees['home--hero'].status, 'fail');
    assert.match(ctx.state.artifacts.trees['home--hero'].failures[0].message, /glow/);
    assert.equal(ctx.state.artifacts.trees['home--what-we-bake'].status, 'pass');
});

test('a tree that never satisfies the local contract records contract_failed without throwing', async () => {
    const treesByLabel = {
        'home/hero': { version: 1, epoch: 'WRONG', blocks: [{ name: 'core/group' }] },
        'home/what-we-bake': treeFor('home/what-we-bake'),
        'home/signup': treeFor('home/signup'),
    };
    const ctx = makeCtx({ treesByLabel, validateByKey: {} });
    await s4.run(ctx);
    const hero = ctx.state.artifacts.trees['home--hero'];
    assert.equal(hero.status, 'fail');
    assert.equal(hero.failures[0].code, 'contract_failed');
    assert.equal(ctx.budget.spent, 2 + 2); // hero burned 2 (attempt+retry), others 1 each
});

test('every section payload carries the shared design language', async () => {
    const treesByLabel = {
        'home/hero': treeFor('home/hero'),
        'home/what-we-bake': treeFor('home/what-we-bake'),
        'home/signup': treeFor('home/signup'),
    };
    const ctx = makeCtx({ treesByLabel, validateByKey: {} });
    await s4.run(ctx);

    const hero = ctx.payloads['home/hero'];
    assert.match(hero.art_direction, /ember-orange accent/);
    assert.equal(hero.page_plan.length, 3);
    assert.deepEqual(hero.page_plan.map((p) => p.band), ['contrast', 'base', 'accent']);
    assert.deepEqual(hero.band_colors, { background: 'contrast', text: 'base' }); // hero band: contrast

    const signup = ctx.payloads['home/signup'];
    assert.deepEqual(signup.band_colors, { background: 'ember', text: 'base' }); // accent resolves by hex

    const features = ctx.payloads['home/what-we-bake'];
    assert.equal(features.design.layout, 'grid');
    assert.match(features.image_note, /EXACTLY one core\/image node per intent/);
});
