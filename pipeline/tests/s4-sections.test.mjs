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

// The furniture calls ride the same fan-out; the harness answers them with
// minimal legal parts unless a test scripts otherwise.
const FURNITURE_TREES = {
    'furniture/header': {
        version: 1, epoch: EPOCH,
        blocks: [{ name: 'core/group', attributes: { align: 'full', layout: { type: 'constrained' } }, innerBlocks: [
            { name: 'core/site-title', attributes: {}, innerBlocks: [] },
            { name: 'core/navigation', attributes: {}, innerBlocks: [] },
        ] }],
    },
    'furniture/footer': {
        version: 1, epoch: EPOCH,
        blocks: [{ name: 'core/group', attributes: { align: 'full', layout: { type: 'constrained' } }, innerBlocks: [
            { name: 'core/paragraph', attributes: { content: 'footer' }, innerBlocks: [] },
        ] }],
    },
};

function treeFor(label, extra = {}) {
    // Grammar-compliant model output: explicit level + the mapped fontSize
    // (the test scale has one size, so every level maps to 'display'), and
    // grid sections carry their EXACTLY ONE alignwide container.
    const heading = { name: 'core/heading', attributes: { content: label, level: 2, fontSize: 'display' } };
    const inner = label.includes('what-we-bake')
        ? [{ name: 'core/group', attributes: { align: 'wide' }, innerBlocks: [heading] }]
        : [heading];
    return {
        version: 1,
        epoch: EPOCH,
        blocks: [{ name: 'core/group', attributes: { align: 'full', backgroundColor: 'base', layout: { type: 'constrained' } }, innerBlocks: inner }],
        ...extra,
    };
}

// The scripted ctx.call keys tool responses off the section label, which
// lives on the first content-bearing node wherever the grammar nests it.
function labelOf(tree) {
    const walk = (ns) => {
        for (const n of ns ?? []) {
            if (n.attributes?.content) return n.attributes.content;
            const hit = walk(n.innerBlocks);
            if (hit) return hit;
        }
        return null;
    };
    return walk(tree.blocks) ?? '?';
}

function makeCtx({ treesByLabel, validateByKey, compileByKey = {} }) {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s4-'));
    for (const d of ['trees', 'sections']) mkdirSync(join(runDir, d), { recursive: true });
    writeFileSync(join(runDir, 'tokens.json'), JSON.stringify(TOKENS));
    writeFileSync(join(runDir, 'furniture-slice.json'), JSON.stringify({ 'core/group': {}, 'core/site-title': {}, 'core/navigation': {} }));
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
    budget.setCeiling(20);
    const ledger = new Ledger(runDir);
    const payloads = {};
    const provider = {
        id: 'scripted',
        complete: async (_t, _p, payload, { label }) => {
            payloads[label] = payload;
            return { text: JSON.stringify(treesByLabel[label] ?? FURNITURE_TREES[label]), usage: { input_tokens: 1, output_tokens: 1 } };
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
            const key = labelOf(tree);
            if (name === 'wp_compile') {
                return { ok: true, data: compileByKey[key] ?? { markup: '<!-- wp:group /-->', all_valid: true, invalid: [], content_lost: [] } };
            }
            assert.equal(name, 'wp_validate');
            active += 1; peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 5));
            active -= 1;
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
    // 3 sections + the 2 furniture parts ride the same fan-out.
    assert.equal(ctx.budget.spent, 5);
    assert.equal(ctx.state.artifacts.furniture.header.status, 'pass');
    assert.equal(ctx.state.artifacts.furniture.footer.status, 'pass');
    assert.ok(existsSync(join(ctx.runDir, 'trees', 'furniture--header.json')));
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
    assert.equal(ctx.budget.spent, 2 + 2 + 2); // hero burned 2 (attempt+retry), other sections and the 2 furniture parts 1 each
});

test('content the save() ignores fails the artifact at the compile-parity gate', async () => {
    // The quote-value field bug: a legal sourced attribute (block.json keeps
    // `value` for migration) that the current save() never renders. Validation
    // passes; only compile can see the loss — and it must fail the artifact so
    // the repair lane gets it, instead of publishing an empty blockquote.
    const treesByLabel = {
        'home/hero': treeFor('home/hero', {
            blocks: [{
                name: 'core/group',
                attributes: { align: 'full', backgroundColor: 'base', layout: { type: 'constrained' } },
                innerBlocks: [
                    { name: 'core/heading', attributes: { content: 'home/hero', level: 2, fontSize: 'display' } },
                    { name: 'core/quote', attributes: { value: '<p>the quote text</p>', citation: 'someone' }, innerBlocks: [] },
                ],
            }],
        }),
        'home/what-we-bake': treeFor('home/what-we-bake'),
        'home/signup': treeFor('home/signup'),
    };
    const compileByKey = {
        'home/hero': {
            markup: '<!-- wp:group --><blockquote class="wp-block-quote"><cite>someone</cite></blockquote><!-- /wp:group -->',
            all_valid: true,
            invalid: [],
            content_lost: [{
                path: '/0/innerBlocks/1/attributes/value',
                name: 'core/quote',
                attribute: 'value',
                message: 'attribute "value" carries authored content but this block\'s save() does not render it',
            }],
        },
        // Poisoned on purpose: a deferred section cannot compile before its
        // block installs, so this result must never be consulted.
        'home/signup': { markup: '', all_valid: true, invalid: [], content_lost: [{ path: '/0', name: 'x', message: 'must not be read' }] },
    };
    const validateByKey = {
        'home/signup': { valid: false, epoch_ok: true, diagnostics: [{ code: 'E_UNKNOWN_BLOCK', severity: 'error', path: '/blocks/0', message: 'unknown block agent/signup-banner' }] },
    };
    const ctx = makeCtx({ treesByLabel, validateByKey, compileByKey });
    await s4.run(ctx);
    const hero = ctx.state.artifacts.trees['home--hero'];
    assert.equal(hero.status, 'fail');
    assert.equal(hero.failures[0].code, 'content_lost');
    assert.match(hero.failures[0].message, /value/);
    assert.equal(hero.failures[0].path, '/0/innerBlocks/1/attributes/value');
    assert.equal(ctx.state.artifacts.trees['home--what-we-bake'].status, 'pass');
    // The deferred section (waiting on an install) cannot compile yet: its
    // poisoned compile result was never consulted and the deferral stands.
    assert.equal(ctx.state.artifacts.trees['home--signup'].status, 'pass');
    assert.deepEqual(ctx.state.artifacts.trees['home--signup'].deferred, ['agent/signup-banner']);
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
    // hero band: contrast — the pair plus the band's measured ink menus.
    assert.deepEqual(hero.band_colors, { background: 'contrast', text: 'base', safe_inks: ['base'], display_only_inks: ['ember'] });

    const signup = ctx.payloads['home/signup'];
    // accent by hex; dark ink by luminance; menus measured against ember. This
    // accent band has no 4.5:1 ink at all — the best pair (3.99:1) is honest
    // display-only territory, exactly what S9 logs as advisory.
    assert.equal(signup.band_colors.background, 'ember');
    assert.equal(signup.band_colors.text, 'contrast');
    assert.deepEqual(signup.band_colors.safe_inks, []);
    assert.ok(signup.band_colors.display_only_inks.includes('contrast'));

    // The axis rides in every payload: one site anchor, obeyed per section…
    assert.deepEqual(hero.axis, { site: 'left', section: 'left', is_break: false, argument: brief.axis.argument });
    // …flipped only where the brief argued the break (signup, the accent moment)…
    assert.deepEqual(signup.axis, { site: 'left', section: 'center', is_break: true, argument: brief.axis.argument });
    assert.deepEqual(hero.page_plan.map((p) => p.axis), ['left', 'left', 'center']);
    // …and dictated from the furniture, which sees it before any section ships.
    assert.deepEqual(ctx.payloads['furniture/header'].axis, { anchor: 'left', argument: brief.axis.argument });
    assert.deepEqual(ctx.payloads['furniture/footer'].axis, { anchor: 'left', argument: brief.axis.argument });

    // One language, likewise: every writing call gets the brief's declared one.
    assert.equal(hero.language, 'English');
    assert.equal(ctx.payloads['furniture/header'].language, 'English');
    assert.equal(ctx.payloads['furniture/footer'].language, 'English');

    const features = ctx.payloads['home/what-we-bake'];
    assert.equal(features.design.layout, 'grid');
    assert.match(features.image_note, /EXACTLY one core\/image node per intent/);
});

test('a tool error in one lane is fatal to the run, but no sibling lane is abandoned', async () => {
    const treesByLabel = {
        'home/hero': treeFor('home/hero'),
        'home/what-we-bake': treeFor('home/what-we-bake'),
        'home/signup': treeFor('home/signup'),
    };
    const ctx = makeCtx({ treesByLabel, validateByKey: {} });
    const inner = ctx.call;
    ctx.call = async (name, tree) => {
        const key = labelOf(tree);
        if (name === 'wp_validate' && key === 'home/hero') {
            return { ok: false, data: { code: 'companion_unreachable', message: 'net::ERR_ABORTED (scripted)' } };
        }
        return inner(name, tree);
    };
    await assert.rejects(() => s4.run(ctx), (e) => e.code === 'companion_unreachable');
    // settleAll semantics: the failure ended the stage, but only AFTER every
    // sibling finished — their artifacts and files landed (the orphan lanes
    // that once outlived dispose and zombied the process no longer exist).
    assert.equal(ctx.state.artifacts.trees['home--what-we-bake'].status, 'pass');
    assert.equal(ctx.state.artifacts.trees['home--signup'].status, 'pass');
    assert.ok(existsSync(join(ctx.runDir, 'trees', 'home--what-we-bake.json')));
    assert.equal(ctx.state.artifacts.furniture.header.status, 'pass');
    assert.equal(ctx.state.artifacts.furniture.footer.status, 'pass');
    assert.equal(ctx.state.artifacts.trees['home--hero'], undefined); // the failed lane never recorded a verdict
});

test('every section is told its band\'s skin state before it writes a word on it', async () => {
    const treesByLabel = {
        'home/hero': treeFor('home/hero'),
        'home/what-we-bake': treeFor('home/what-we-bake'),
        'home/signup': treeFor('home/signup'),
    };
    const ctx = makeCtx({ treesByLabel, validateByKey: {} });
    ctx.state.brief.surfaces = [
        { id: 'linen-wash', class: 'field', prompt_seed: 'Woven linen texture', intensity: 'whisper', attach: ['home/hero'] },
    ];
    await s4.run(ctx);
    const hero = ctx.payloads['home/hero'];
    assert.equal(hero.design.skinned, true);
    assert.equal(ctx.payloads['home/what-we-bake'].design.skinned, false);
    const plan = hero.page_plan;
    assert.equal(plan.find((p) => p.id === 'hero').skinned, true);
    assert.equal(plan.find((p) => p.id === 'what-we-bake').skinned, false);
});

test('canvas bands: menus from the measured canvas luminance, base fallback without one', async () => {
    const treesByLabel = {
        'home/hero': treeFor('home/hero'),
        'home/what-we-bake': treeFor('home/what-we-bake'),
        'home/signup': treeFor('home/signup'),
    };
    const withCanvas = (state) => {
        const ctx = makeCtx({ treesByLabel, validateByKey: {} });
        ctx.state.brief.surfaces = [
            { id: 'plaster-ground', class: 'canvas', prompt_seed: 'Fine plaster texture', intensity: 'whisper', attach: [] },
        ];
        ctx.state.brief.pages[0].sections[0].design.band = 'canvas';
        // The per-section entry file is what the payload reads its design from.
        const heroFile = join(ctx.runDir, 'sections', 'home--hero.json');
        const entry = JSON.parse(readFileSync(heroFile, 'utf8'));
        entry.section.design.band = 'canvas';
        writeFileSync(heroFile, JSON.stringify(entry));
        Object.assign(ctx.state, state);
        return ctx;
    };

    // Measured canvas (light range): no backgroundColor on the band, and only
    // the dark slug clears the worst-case bar.
    const measured = withCanvas({ canvas: { asset_id: 'plaster-ground', lum_min: 0.8, lum_max: 0.9 } });
    await s4.run(measured);
    const bc = measured.payloads['home/hero'].band_colors;
    assert.equal(bc.background, null);
    assert.ok(bc.safe_inks.includes('contrast'));
    assert.ok(!bc.safe_inks.includes('ember'));
    assert.equal(bc.text, 'contrast');

    // No measured canvas (e.g. --no-images): the band still ships bare, rated
    // against the flat page ground it actually sits on.
    const fallback = withCanvas({});
    await s4.run(fallback);
    const fb = fallback.payloads['home/hero'].band_colors;
    assert.equal(fb.background, null);
    assert.ok(fb.safe_inks.length > 0);
});
