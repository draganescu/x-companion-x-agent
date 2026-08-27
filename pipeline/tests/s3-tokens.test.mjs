import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetMeter, Ledger } from '../budget.mjs';
import { createLlm } from '../lib/llm.mjs';
import { deriveThemeSpacing, deriveThemeLayout } from '../lib/tokens.mjs';
import * as s3 from '../stages/s3-tokens.mjs';

const brief = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));
const PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));

const THEME_TOKENS = {
    color: {},
    spacing: { spacingSizes: [{ slug: '40', size: '1rem' }, { slug: '50', size: 'clamp(2rem, 4vw, 3rem)' }] },
    typography: {},
    layout: { contentSize: '640px', wideSize: '1200px' },
};

function goodTokens() {
    return {
        palette: [
            { slug: 'base', name: 'Base', color: '#F6EFE6' },
            { slug: 'contrast', name: 'Contrast', color: '#3B2A1E' },
            { slug: 'flour', name: 'Flour', color: '#F6EFE6', role: 'background' },
            { slug: 'rye', name: 'Rye', color: '#3B2A1E', role: 'text' },
            { slug: 'ember', name: 'Ember', color: '#D96C2C', role: 'accent' },
            { slug: 'crust', name: 'Crust', color: '#8A5A33', role: 'primary' },
        ],
        spacing: deriveThemeSpacing(THEME_TOKENS),
        typography: {
            families: [{ slug: 'serif-display', name: 'Serif Display', fontFamily: 'Georgia, serif' }],
            sizes: [{ slug: 'display', size: '4rem', fluid: { min: '2.75rem', max: '6rem' } }],
        },
        layout: deriveThemeLayout(THEME_TOKENS),
    };
}

function makeCtx({ outputs, dryDiff = [], dryOk = true }) {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s3-'));
    const budget = new BudgetMeter({});
    budget.setCeiling(16);
    const ledger = new Ledger(runDir);
    const provider = { id: 'scripted', complete: async () => ({ text: outputs.shift(), usage: { input_tokens: 1, output_tokens: 1 } }) };
    const calls = [];
    return {
        runDir, budget, ledger, calls,
        llm: createLlm({ providers: new Map([['tokens', { provider, model: 'm' }]]), promptsDir: PROMPTS_DIR, budget, ledger }),
        state: { brief: structuredClone(brief), instance: { theme_tokens: THEME_TOKENS, fingerprint: 'f1' } },
        log: () => {},
        call: async (name, args) => {
            calls.push([name, args]);
            assert.equal(name, 'wp_tokens_apply');
            if (args.dry_run) {
                if (!dryOk) return { ok: false, data: { code: 'invalid_input', message: 'bad tokens', hint: '' } };
                return { ok: true, data: { applied: false, dry_run: true, theme_json_preview: { color: { palette: args.palette } }, diff_against_instance: dryDiff, fingerprint: 'f1' } };
            }
            return { ok: true, data: { applied: true, dry_run: false, theme_json_preview: {}, diff_against_instance: [], fingerprint: 'f2' } };
        },
    };
}

test('S3 happy path: dry run first, gate checks, real apply moves the fingerprint', async () => {
    const ctx = makeCtx({ outputs: [JSON.stringify(goodTokens())] });
    await s3.run(ctx);
    assert.equal(ctx.calls.length, 2);
    assert.equal(ctx.calls[0][1].dry_run, true);
    assert.equal(ctx.calls[1][1].dry_run, undefined);
    // The stage-authored seam reset rides BOTH calls: core's default block-gap
    // margin between top-level blocks never ships as page-background seams.
    for (const [, args] of ctx.calls) {
        assert.match(args.css.global, /\.wp-site-blocks > \* \+ \* \{ margin-block-start: 0; \}/);
        assert.match(args.css.global, /\.wp-block-post-content > \* \+ \* \{ margin-block-start: 0; \}/);
    }
    assert.ok(existsSync(join(ctx.runDir, 'tokens.json')));
    assert.ok(existsSync(join(ctx.runDir, 'tokens-dry-run.json')));
    assert.equal(ctx.state.fingerprint, 'f2');
    assert.equal(JSON.parse(readFileSync(join(ctx.runDir, 'instance.json'), 'utf8')).fingerprint, 'f2');
});

test('S3 canvas birth: the asset is born with the tokens, metered, its luminance recorded for S4', async () => {
    const ctx = makeCtx({ outputs: [JSON.stringify(goodTokens())] });
    ctx.state.brief.surfaces = [
        { id: 'plaster-ground', class: 'canvas', prompt_seed: 'Fine plaster texture, near white', intensity: 'whisper', attach: [] },
    ];
    ctx.state.brief.pages[0].sections[0].design.band = 'canvas';
    const generateCalls = [];
    const inner = ctx.call;
    ctx.call = async (name, args) => {
        if (name === 'wp_images_generate') {
            generateCalls.push(args);
            return {
                ok: true,
                data: {
                    found: 0, found_surfaces: 0, generated: 1, cached: [], cached_content: [], dry_run: false,
                    manifest_path: join(ctx.runDir, 'images', 'images-manifest.json'),
                    images: [],
                    surfaces: [{ asset_id: 'plaster-ground', class: 'canvas', paths: [], file: '/assets/plaster.jpg', ms: 9, post_processing: 'recompress', lum_min: 0.82, lum_max: 0.91 }],
                    scan_errors: [],
                },
            };
        }
        return inner(name, args);
    };
    await s3.run(ctx);
    assert.equal(generateCalls.length, 1);
    assert.equal(generateCalls[0].assets_only, true);
    assert.equal(generateCalls[0].surfaces.length, 1);
    assert.equal(generateCalls[0].surfaces[0].id, 'plaster-ground');
    assert.ok(generateCalls[0].surfaces[0].hexes.length > 0);
    assert.deepEqual(ctx.state.canvas, { asset_id: 'plaster-ground', file: '/assets/plaster.jpg', lum_min: 0.82, lum_max: 0.91 });
    assert.equal(ctx.budget.calls.filter((c) => c.task_type === 'image' && c.label === 'plaster-ground').length, 1);
    assert.equal(ctx.ledger.entries.filter((e) => e.task_type === 'image' && e.label === 'plaster-ground').length, 1);
});

test('S3 canvas birth: no canvas asset means no call; --no-images skips the birth whole', async () => {
    const plain = makeCtx({ outputs: [JSON.stringify(goodTokens())] });
    await s3.run(plain);
    assert.ok(plain.calls.every(([name]) => name === 'wp_tokens_apply'));

    const skipped = makeCtx({ outputs: [JSON.stringify(goodTokens())] });
    skipped.state.no_images = true;
    skipped.state.brief.surfaces = [
        { id: 'plaster-ground', class: 'canvas', prompt_seed: 'Fine plaster texture, near white', intensity: 'whisper', attach: [] },
    ];
    await s3.run(skipped);
    assert.ok(skipped.calls.every(([name]) => name === 'wp_tokens_apply'));
    assert.equal(skipped.state.canvas, undefined);
});

test('S3 canvas birth: a failed birth degrades to the flat ground and the run continues', async () => {
    const ctx = makeCtx({ outputs: [JSON.stringify(goodTokens())] });
    ctx.state.brief.surfaces = [
        { id: 'plaster-ground', class: 'canvas', prompt_seed: 'Fine plaster texture, near white', intensity: 'whisper', attach: [] },
    ];
    const inner = ctx.call;
    ctx.call = async (name, args) => {
        if (name === 'wp_images_generate') return { ok: false, data: { code: 'companion_error', message: 'model down', hint: '' } };
        return inner(name, args);
    };
    await s3.run(ctx);
    assert.equal(ctx.state.canvas, undefined);
    assert.ok(ctx.state.surface_report.degraded.some((d) => d.asset_id === 'plaster-ground'));
    assert.equal(ctx.state.fingerprint, 'f2'); // tokens still applied, the run lives
});

test('a token set that redesigns spacing burns the schema-retry, then the clean echo passes', async () => {
    const bad = goodTokens();
    bad.spacing = { scale_unit: 'px', steps: [{ slug: '40', size: '99px' }] };
    const ctx = makeCtx({ outputs: [JSON.stringify(bad), JSON.stringify(goodTokens())] });
    await s3.run(ctx);
    assert.equal(ctx.budget.spent, 2);
    assert.deepEqual(ctx.ledger.entries.map((e) => e.outcome), ['schema_failed', 'ok']);
});

test('dry-run diff drift in spacing/layout is a gate failure, never bypassed', async () => {
    const ctx = makeCtx({
        outputs: [JSON.stringify(goodTokens())],
        dryDiff: [{ group: 'spacing.spacingSizes', slug: '40', kind: 'value_differs', expected: '1rem', actual: '2rem' }],
    });
    await assert.rejects(s3.run(ctx), (e) => e.code === 'gate_failed' && /R9/.test(e.message));
    assert.equal(ctx.calls.length, 1); // the real apply never ran
});

test('a missing brief color in the preview is a gate failure naming the color', async () => {
    const tokens = goodTokens();
    tokens.palette = tokens.palette.filter((p) => p.slug !== 'ember');
    // tokenChecks would catch this locally; simulate a preview miss instead by
    // scripting a dry-run preview that drops the color after a legal token set.
    const ctx = makeCtx({ outputs: [JSON.stringify(goodTokens())] });
    ctx.call = async (name, args) => {
        if (args.dry_run) return { ok: true, data: { theme_json_preview: { color: { palette: [] } }, diff_against_instance: [], fingerprint: 'f1' } };
        throw new Error('real apply must not run');
    };
    await assert.rejects(s3.run(ctx), (e) => e.code === 'gate_failed' && /#D96C2C/.test(e.message));
});

test('a css sanitizer rejection is a gate failure — the seam reset must land whole', async () => {
    const ctx = makeCtx({ outputs: [JSON.stringify(goodTokens())] });
    const inner = ctx.call;
    ctx.call = async (name, args) => {
        const res = await inner(name, args);
        if (!args.dry_run) res.data.css_rejected = ['.wp-site-blocks rule rejected'];
        return res;
    };
    await assert.rejects(s3.run(ctx), (e) => e.code === 'gate_failed' && /css sanitizer/.test(e.message));
});

test('a theme with no contentSize/wideSize fails S3 before any call is spent', async () => {
    // No core default backs constrained layout: without these, "constrained"
    // constrains nothing and every centered section silently runs full width.
    const ctx = makeCtx({ outputs: [JSON.stringify(goodTokens())] });
    ctx.state.instance.theme_tokens = { ...THEME_TOKENS, layout: {} };
    await assert.rejects(s3.run(ctx), (e) => e.code === 'gate_failed' && /contentSize/.test(e.message));
    assert.equal(ctx.budget.spent, 0); // the gate fires before the generative call
    assert.equal(ctx.calls.length, 0);
});

test('deriveThemeSpacing/Layout map global-settings shapes into DesignTokens shapes', () => {
    assert.deepEqual(deriveThemeSpacing(THEME_TOKENS),
        { scale_unit: 'px', steps: [{ slug: '40', size: '1rem' }, { slug: '50', size: 'clamp(2rem, 4vw, 3rem)' }] });
    assert.deepEqual(deriveThemeLayout(THEME_TOKENS), { contentSize: '640px', wideSize: '1200px' });
});

test('origin-keyed spacingSizes derive: theme wins over default; missing_on_instance noise passes the gate', async () => {
    const originTokens = {
        ...THEME_TOKENS,
        spacing: { spacingSizes: { default: [{ slug: '20', size: '0.5rem' }], theme: [{ slug: '40', size: '1rem' }, { slug: '50', size: 'clamp(2rem, 4vw, 3rem)' }] } },
    };
    const { deriveThemeSpacing: derive } = await import('../lib/tokens.mjs');
    assert.deepEqual(derive(originTokens).steps.map((s) => s.slug), ['40', '50']);

    const ctx = makeCtx({
        outputs: [JSON.stringify(goodTokens())],
        dryDiff: [{ group: 'spacing.spacingSizes', slug: '40', kind: 'missing_on_instance', expected: '1rem', actual: null }],
    });
    await s3.run(ctx); // noise, not drift: the run completes
    assert.equal(ctx.state.fingerprint, 'f2');
});

test('resolveBandColors maps bands to applied slugs via brief roles', async () => {
    const { resolveBandColors } = await import('../lib/tokens.mjs');
    const briefPalette = [
        { name: 'Flour', color: '#F6EFE6', role: 'background' },
        { name: 'Rye', color: '#3B2A1E', role: 'text' },
        { name: 'Ember', color: '#D96C2C', role: 'accent' },
    ];
    const applied = [
        { slug: 'base', name: 'Base', color: '#F6EFE6' },
        { slug: 'contrast', name: 'Contrast', color: '#3B2A1E' },
        { slug: 'ember', name: 'Ember', color: '#d96c2c' },
    ];
    // luminance-measured: mid-bright ember gets DARK ink, not whichever slug is named 'base'
    assert.deepEqual(resolveBandColors('accent', briefPalette, applied), { background: 'ember', text: 'contrast' });
    assert.deepEqual(resolveBandColors('contrast', briefPalette, applied), { background: 'contrast', text: 'base' });
    assert.deepEqual(resolveBandColors('base', briefPalette, applied), { background: 'base', text: 'contrast' });
});

test('annotatePalette tags each slug with its hex and measured tone', async () => {
    const { annotatePalette, toneOf, mixHex } = await import('../lib/tokens.mjs');
    // the field bug's palette: base DARK, contrast LIGHT — inverted from the WP default
    const annotated = annotatePalette([
        { slug: 'base', name: 'Night', color: '#14110C', role: 'background' },
        { slug: 'spuma', name: 'Foam', color: '#F5EFE2', role: 'text' },
        { slug: 'chihlimbar', name: 'Amber', color: '#E8A317', role: 'accent' },
    ]);
    assert.deepEqual(annotated, [
        { slug: 'base', color: '#14110C', tone: 'dark' },
        { slug: 'spuma', color: '#F5EFE2', tone: 'light' },
        { slug: 'chihlimbar', color: '#E8A317', tone: 'light' }, // mid-bright amber: dark ink wins
    ]);
    assert.equal(toneOf('#fff'), 'light');
    assert.equal(toneOf('#000000'), 'dark');
    // mixHex: the placeholder tone math — a nudge toward the ink, deterministic
    assert.equal(mixHex('#000000', '#FFFFFF', 0.5), '#808080');
    assert.equal(mixHex('#F5EFE2', '#000000', 0), '#F5EFE2');
    assert.equal(mixHex('#14110C', '#FFFFFF', 1), '#FFFFFF');
});

// ---- the contrast gate (the invisible-header field bug) ----------------------

test('tokens whose contrast cannot be read on base are rejected with the ratio named', async () => {
    const { tokenChecks, deriveThemeSpacing, deriveThemeLayout } = await import('../lib/tokens.mjs');
    const theme = { spacing: { spacingSizes: [{ slug: '40', size: '1rem' }] }, layout: { contentSize: '640px', wideSize: '1200px' } };
    const tokens = {
        palette: [
            { slug: 'base', name: 'Night', color: '#14110e' },
            { slug: 'contrast', name: 'Ink', color: '#0b0908' }, // the real bug: ink ≈ ground, 1.06:1
        ],
        spacing: deriveThemeSpacing(theme),
        typography: { families: [{ slug: 'body', name: 'Body', fontFamily: 'serif' }], sizes: [{ slug: 'display', size: '4rem' }] },
        layout: deriveThemeLayout(theme),
    };
    const issues = tokenChecks(tokens, { theme_spacing: deriveThemeSpacing(theme), theme_layout: deriveThemeLayout(theme), briefPalette: [] });
    assert.ok(issues.some((i) => /4\.5:1/.test(i.message) && /must be LIGHT/.test(i.message)), JSON.stringify(issues));
    // a legible pair passes
    tokens.palette[1].color = '#f3e9da';
    assert.deepEqual(tokenChecks(tokens, { theme_spacing: deriveThemeSpacing(theme), theme_layout: deriveThemeLayout(theme), briefPalette: [] }), []);
});
