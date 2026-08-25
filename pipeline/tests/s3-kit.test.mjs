import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetMeter, Ledger } from '../budget.mjs';
import { createLlm } from '../lib/llm.mjs';
import { deriveThemeSpacing, deriveThemeLayout } from '../lib/tokens.mjs';
import { kitChecks, tokensFromKit, kitId, patternSlug } from '../lib/kit.mjs';
import * as s3 from '../stages/s3-kit.mjs';

const brief = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));
const PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));

const THEME_TOKENS = {
    color: {},
    spacing: { spacingSizes: [{ slug: '40', size: '1rem' }, { slug: '50', size: 'clamp(2rem, 4vw, 3rem)' }] },
    typography: {},
    layout: { contentSize: '640px', wideSize: '1200px' },
};

function goodSpec() {
    const spacing = deriveThemeSpacing(THEME_TOKENS);
    const layout = deriveThemeLayout(THEME_TOKENS);
    const palette = [
        { slug: 'base', name: 'Base', color: '#F6EFE6' },
        { slug: 'contrast', name: 'Contrast', color: '#3B2A1E' },
        { slug: 'ember', name: 'Ember', color: '#D96C2C', role: 'accent' },
        { slug: 'crust', name: 'Crust', color: '#8A5A33', role: 'primary' },
    ];
    const sizes = [{ slug: 'display', size: '4rem', fluid: { min: '2.75rem', max: '6rem' } }];
    return {
        version: 1,
        source: { kind: 'synthesized', files: [], viewport: { width: 1440, height: 2400 } },
        tokens_candidates: {
            palette,
            spacing,
            typography: { families: [{ slug: 'serif-display', name: 'Serif Display', fontFamily: 'Georgia, serif' }], sizes },
            layout,
            quantization_log: [
                ...palette.map((p) => ({ observed: p.color, snapped_to: p.color, delta: '0', note: `${p.name} — the brief's own` })),
                ...spacing.steps.map((s) => ({ observed: s.size, snapped_to: s.size, delta: '0', note: "the theme's own step, passed through" })),
                { observed: '4rem', snapped_to: '4rem', delta: '0', note: 'display step: one clear tier above the body scale' },
                { observed: '640px', snapped_to: '640px', delta: '0', note: "the theme's measured text column" },
                { observed: '1200px', snapped_to: '1200px', delta: '0', note: "the theme's wide rail" },
            ],
        },
        content: [
            { id: 'c-headline', kind: 'heading', text: 'Bread worth the walk', region_id: 'r-hero' },
            { id: 'c-lede', kind: 'paragraph', text: 'Sourdough pulled from the oven every morning at six.', region_id: 'r-hero' },
            { id: 'c-features', kind: 'heading', text: 'What we bake', region_id: 'r-features' },
            { id: 'c-cta', kind: 'button', text: 'Reserve a loaf', region_id: 'r-cta' },
        ],
        regions: [
            {
                id: 'r-hero', role: 'hero', box: { x: 0, y: 0, w: 1440, h: 760 },
                layout: { direction: 'row', gap_px: 48 }, style_refs: { background_palette_slug: 'base', palette_slug: 'contrast', font_size_slug: 'display' },
                responsive_assumptions: [{ breakpoint: '<=781px', change: 'the two columns stack; copy leads', confidence: 'synthesized' }],
            },
            {
                id: 'r-features', role: 'features', box: { x: 0, y: 760, w: 1440, h: 900 },
                layout: { direction: 'grid', gap_px: 32, columns: 3 }, style_refs: { background_palette_slug: 'base', palette_slug: 'contrast' },
                responsive_assumptions: [{ breakpoint: '<=781px', change: 'three columns become one', confidence: 'synthesized' }],
            },
            {
                id: 'r-cta', role: 'cta', box: { x: 0, y: 1660, w: 1440, h: 460 },
                layout: { direction: 'column', gap_px: 24 }, style_refs: { background_palette_slug: 'ember', palette_slug: 'contrast' },
                responsive_assumptions: [{ breakpoint: '<=781px', change: 'outer padding drops one step', confidence: 'synthesized' }],
            },
        ],
    };
}

function goodMolecules() {
    return [
        { id: 'hero-split', role: 'hero', when_to_use: 'The opening statement, copy left and image right.', recipe: { blocks: ['core/group', 'core/columns'], layout: 'split' }, style_refs: { background_palette_slug: 'base', spacing_slugs: ['50'] }, region_id: 'r-hero' },
        { id: 'card-row', role: 'features', when_to_use: 'Three or more short items that read as peers.', recipe: { blocks: ['core/columns', 'core/column'], layout: 'grid' }, style_refs: { background_palette_slug: 'base' } },
        { id: 'cta-band', role: 'cta', when_to_use: 'A full-bleed band asking for one action.', recipe: { blocks: ['core/group', 'core/buttons'], layout: 'centered' }, style_refs: { background_palette_slug: 'ember' } },
    ];
}

const goodKit = () => ({ spec: goodSpec(), molecules: goodMolecules() });

function makeCtx({ outputs, dryDiff = [], specDiagnostics = [] }) {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s3kit-'));
    mkdirSync(join(runDir, 'molecules'), { recursive: true });
    const budget = new BudgetMeter({});
    const ledger = new Ledger(runDir);
    const provider = { id: 'scripted', complete: async () => ({ text: outputs.shift(), usage: { input_tokens: 1, output_tokens: 1 } }) };
    const calls = [];
    return {
        runDir, budget, ledger, calls,
        llm: createLlm({ providers: new Map([['kit', { provider, model: 'm' }]]), promptsDir: PROMPTS_DIR, budget, ledger }),
        state: { brief: structuredClone(brief), instance: { theme_tokens: THEME_TOKENS, fingerprint: 'f1', block_names: ['core/group', 'core/columns'] } },
        log: () => {},
        call: async (name, args) => {
            calls.push([name, args]);
            if (name === 'wp_spec_validate') {
                return { ok: true, data: { valid: specDiagnostics.length === 0, diagnostics: specDiagnostics } };
            }
            assert.equal(name, 'wp_tokens_apply');
            if (args.dry_run) {
                return { ok: true, data: { applied: false, dry_run: true, theme_json_preview: { color: { palette: args.palette } }, diff_against_instance: dryDiff, fingerprint: 'f1' } };
            }
            return { ok: true, data: { applied: true, dry_run: false, theme_json_preview: {}, diff_against_instance: [], fingerprint: 'f2' } };
        },
    };
}

test('S3 happy path: spec gate, budget fixed HERE, dry run, real apply moves the fingerprint', async () => {
    const ctx = makeCtx({ outputs: [JSON.stringify(goodKit())] });
    await s3.run(ctx);
    assert.deepEqual(ctx.calls.map((c) => c[0]), ['wp_spec_validate', 'wp_tokens_apply', 'wp_tokens_apply']);
    assert.equal(ctx.calls[1][1].dry_run, true);
    assert.equal(ctx.calls[2][1].dry_run, undefined);
    for (const f of ['kit.json', 'molecules.json', 'tokens.json', 'tokens-dry-run.json']) {
        assert.ok(existsSync(join(ctx.runDir, f)), `${f} written`);
    }
    // The ceiling is fixed by the KIT, not the brief: M=3, S=3, B=1, P=1, I from the brief.
    assert.equal(ctx.state.budget.M, 3);
    assert.equal(ctx.budget.ceiling, 2 * (1 + 1 + 3 + 3 + 1 + 1) + ctx.state.budget.I);
    assert.equal(ctx.state.fingerprint, 'f2');
    assert.equal(JSON.parse(readFileSync(join(ctx.runDir, 'kit.json'), 'utf8')).source.kind, 'synthesized');
});

test('an unlogged token value burns the schema-retry, then the logged kit passes', async () => {
    const bad = goodKit();
    bad.spec.tokens_candidates.quantization_log = bad.spec.tokens_candidates.quantization_log.filter((q) => q.snapped_to !== '#D96C2C');
    const ctx = makeCtx({ outputs: [JSON.stringify(bad), JSON.stringify(goodKit())] });
    await s3.run(ctx);
    assert.equal(ctx.budget.spent, 2);
    assert.deepEqual(ctx.ledger.entries.map((e) => e.outcome), ['schema_failed', 'ok']);
});

test('wp_spec_validate errors are a gate failure and the tokens never apply', async () => {
    const ctx = makeCtx({
        outputs: [JSON.stringify(goodKit())],
        specDiagnostics: [{ code: 'E_BOX_OVERLAP', severity: 'error', path: '/regions/0', message: 'child escapes parent' }],
    });
    await assert.rejects(s3.run(ctx), (e) => e.code === 'gate_failed' && /E_BOX_OVERLAP/.test(e.message));
    assert.deepEqual(ctx.calls.map((c) => c[0]), ['wp_spec_validate']);
});

test('W_UNQUANTIZED from the server gate is promoted to a failure', async () => {
    const ctx = makeCtx({
        outputs: [JSON.stringify(goodKit())],
        specDiagnostics: [{ code: 'W_UNQUANTIZED', severity: 'warning', path: '/tokens_candidates', message: 'no log entry for #D96C2C' }],
    });
    await assert.rejects(s3.run(ctx), (e) => e.code === 'gate_failed' && /W_UNQUANTIZED/.test(e.message));
});

test('R9 drift in the dry-run diff is still a gate failure', async () => {
    const ctx = makeCtx({
        outputs: [JSON.stringify(goodKit())],
        dryDiff: [{ group: 'spacing.spacingSizes', slug: '40', kind: 'value_differs', expected: '1rem', actual: '2rem' }],
    });
    await assert.rejects(s3.run(ctx), (e) => e.code === 'gate_failed' && /R9/.test(e.message));
    assert.equal(ctx.calls.filter((c) => c[0] === 'wp_tokens_apply').length, 1); // the real apply never ran
});

// ---- kitChecks, the pre-call screen ------------------------------------------

const check = (mutate) => {
    const kit = goodKit();
    mutate(kit);
    return kitChecks(kit, { briefPalette: brief.palette, sectionRoles: ['hero', 'features', 'cta'] });
};

test('a clean kit produces no issues', () => {
    assert.deepEqual(check(() => {}), []);
});

test('a lifted spec is rejected: a kit is inferred, and says so', () => {
    const issues = check((k) => { k.spec.source.kind = 'image'; });
    assert.ok(issues.some((i) => /synthesized/.test(i.message)), JSON.stringify(issues));
});

test('a child box escaping its parent is caught before the round trip', () => {
    const issues = check((k) => {
        k.spec.regions[0].children = [{ id: 'r-hero-copy', role: 'column', box: { x: 0, y: 0, w: 1440, h: 2000 } }];
    });
    assert.ok(issues.some((i) => /escapes parent/.test(i.message)), JSON.stringify(issues));
});

test('content pointing at no region is caught', () => {
    const issues = check((k) => { k.spec.content[0].region_id = 'r-nowhere'; });
    assert.ok(issues.some((i) => /not a region/.test(i.message)));
});

test('a contentless kit is refused: the verifier matches on text as well as geometry', () => {
    const issues = check((k) => { k.spec.content = [{ id: 'c1', kind: 'other', text: 'ok', region_id: 'r-hero' }]; });
    assert.ok(issues.some((i) => /real copy/.test(i.message)), JSON.stringify(issues));
});

test('a role the brief uses with no molecule is refused', () => {
    const issues = check((k) => { k.molecules = k.molecules.filter((m) => m.role !== 'cta'); });
    assert.ok(issues.some((i) => /no molecule for the "cta"/.test(i.message)));
});

test('a molecule style_ref that is not a declared slug is refused', () => {
    const issues = check((k) => { k.molecules[0].style_refs.background_palette_slug = 'chartreuse'; });
    assert.ok(issues.some((i) => /not a palette slug this kit declares/.test(i.message)));
});

test('a non-core block in a recipe is refused: an atom is never a custom block', () => {
    const issues = check((k) => { k.molecules[0].recipe.blocks = ['agent/fancy-hero']; });
    assert.ok(issues.some((i) => /molecules/.test(i.path)), JSON.stringify(issues));
});

test('a top-level region with no responsive assumption is refused', () => {
    const issues = check((k) => { delete k.spec.regions[1].responsive_assumptions; });
    assert.ok(issues.some((i) => /responsive_assumption/.test(i.message)));
});

test('a dropped brief colour is refused', () => {
    const issues = check((k) => {
        k.spec.tokens_candidates.palette = k.spec.tokens_candidates.palette.filter((p) => p.slug !== 'ember');
    });
    assert.ok(issues.some((i) => /Ember #D96C2C is missing/.test(i.message)), JSON.stringify(issues));
});

test('the envelope is {spec, molecules} and nothing else', () => {
    const issues = check((k) => { k.notes = 'thoughts'; });
    assert.ok(issues.some((i) => /nothing else/.test(i.message)));
});

// ---- derivations -------------------------------------------------------------

test('tokens_candidates IS a DesignTokens document', () => {
    const tokens = tokensFromKit(goodSpec());
    assert.deepEqual(Object.keys(tokens).sort(), ['layout', 'palette', 'spacing', 'typography']);
    assert.deepEqual(tokens.spacing, deriveThemeSpacing(THEME_TOKENS));
    assert.deepEqual(tokens.layout, deriveThemeLayout(THEME_TOKENS));
});

test('pattern slugs are namespaced per kit and stay inside the companion window', () => {
    assert.equal(kitId({ identity: { site_title: 'The Rye & Ember Bakery' } }), 'the-rye-ember-bakery');
    assert.equal(patternSlug('the-rye-ember-bakery', 'hero-split'), 'agent/the-rye-ember-bakery-hero-split');
    assert.ok(patternSlug('x'.repeat(20), 'y'.repeat(40)).length <= 64);
    assert.match(patternSlug('the-rye-ember-bakery', 'hero-split'), /^agent\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/);
});

// ---- the contrast gate (the invisible-header field bug) ----------------------

test('a kit whose contrast cannot be read on base is rejected with the ratio named', () => {
    const issues = check((k) => {
        const p = k.spec.tokens_candidates.palette;
        p.find((e) => e.slug === 'base').color = '#14110e';
        p.find((e) => e.slug === 'contrast').color = '#0b0908'; // the real bug: ink ≈ ground
    });
    assert.ok(issues.some((i) => /4\.5:1/.test(i.message) && /must be LIGHT/.test(i.message)), JSON.stringify(issues));
});

test('the reserved base/contrast slugs must both exist', () => {
    const issues = check((k) => {
        k.spec.tokens_candidates.palette = k.spec.tokens_candidates.palette.filter((e) => e.slug !== 'contrast');
    });
    assert.ok(issues.some((i) => /reserved "contrast" slug/.test(i.message)), JSON.stringify(issues));
});
