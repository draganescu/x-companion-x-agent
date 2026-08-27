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

function makeCtx({ outputs, dryDiff = [], dryOk = true, rest, fetchImpl }) {
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
        ...(rest ? { rest } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
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

// ---- the widened tokens contract (theme-factory font lane) -------------------

test('a sourced family is legal; a model-authored fontFace is not; the face must lead the stack', async () => {
    const { tokenChecks, deriveThemeSpacing, deriveThemeLayout } = await import('../lib/tokens.mjs');
    const theme = { spacing: { spacingSizes: [{ slug: '40', size: '1rem' }] }, layout: { contentSize: '640px', wideSize: '1200px' } };
    const base = () => ({
        palette: [
            { slug: 'base', name: 'Cream', color: '#f7f2e9' },
            { slug: 'contrast', name: 'Ink', color: '#1a140e' },
        ],
        spacing: deriveThemeSpacing(theme),
        typography: {
            families: [{ slug: 'display', name: 'Display', fontFamily: '"Playfair Display", Georgia, serif', source: { provider: 'google', family: 'Playfair Display', weights: [400, 700] } }],
            sizes: [{ slug: 'display', size: '4rem' }],
        },
        layout: deriveThemeLayout(theme),
    });
    const opts = { theme_spacing: deriveThemeSpacing(theme), theme_layout: deriveThemeLayout(theme), briefPalette: [] };

    assert.deepEqual(tokenChecks(base(), opts), []);

    const withFace = base();
    withFace.typography.families[0].fontFace = [{ fontFamily: 'Playfair Display', fontStyle: 'normal', fontWeight: '400', src: ['http://x/p.woff2'] }];
    assert.ok(tokenChecks(withFace, opts).some((i) => /pipeline-owned/.test(i.message)));

    const trailing = base();
    trailing.typography.families[0].fontFamily = 'Georgia, serif';
    assert.ok(tokenChecks(trailing, opts).some((i) => /LEAD with the sourced family/.test(i.message)));
});

// ---- the S3 font hook (theme-factory M5): install BEFORE apply, activation rides the write

const CSS2_STUB = `@font-face { font-family: 'Playfair Display'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/playfairdisplay/v39/abc400.woff2) format('woff2'); }`;

function fontFetchStub() {
    return async (url) => {
        if (url.startsWith('https://fonts.googleapis.com/css2')) return { ok: true, status: 200, text: async () => CSS2_STUB };
        if (url.startsWith('https://fonts.google.com/metadata')) return { ok: true, status: 200, text: async () => JSON.stringify({ license: 'OFL' }) };
        if (url.includes('raw.githubusercontent.com')) return { ok: true, status: 200, text: async () => 'OFL text' };
        const buf = Buffer.from('wOF2-stub-bytes');
        return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    };
}

function sourcedTokens() {
    const t = goodTokens();
    t.typography.families = [{
        slug: 'serif-display',
        name: 'Serif Display',
        fontFamily: '"Playfair Display", Georgia, serif',
        source: { provider: 'google', family: 'Playfair Display', weights: [400] },
    }];
    return t;
}

test('a sourced family installs BEFORE the real apply, which carries fontFace and never source', async () => {
    const restCalls = [];
    const rest = async (method, route, opts = {}) => {
        restCalls.push([method, route]);
        if (method === 'GET' && route === '/wp/v2/font-families') return [];
        if (method === 'POST' && route === '/wp/v2/font-families') return { id: 5 };
        if (method === 'GET' && route === '/wp/v2/font-families/5/font-faces') return [];
        if (method === 'POST' && route === '/wp/v2/font-families/5/font-faces') {
            return { font_face_settings: { fontWeight: '400', src: 'http://x/wp-content/uploads/fonts/pd-400.woff2' } };
        }
        throw new Error(`unexpected ${method} ${route}`);
    };
    const ctx = makeCtx({ outputs: [JSON.stringify(sourcedTokens())], rest, fetchImpl: fontFetchStub() });
    // isolate the cache per test run
    const { mkdtempSync: mkTmp } = await import('node:fs');
    const cwd = process.cwd();
    process.chdir(mkTmp(join(tmpdir(), 'x-pipeline-fontcwd-')));
    try {
        await s3.run(ctx);
    } finally {
        process.chdir(cwd);
    }

    // dry run happened before the first font REST call; the real apply after the last
    assert.equal(ctx.calls.length, 2);
    assert.ok(restCalls.length > 0, 'the font lane ran');
    const applied = ctx.calls[1][1];
    assert.equal(applied.dry_run, undefined);
    const fam = applied.typography.families[0];
    assert.equal(fam.source, undefined, 'source never reaches the tool');
    assert.deepEqual(fam.fontFace, [{ fontFamily: 'Playfair Display', fontStyle: 'normal', fontWeight: '400', src: ['http://x/wp-content/uploads/fonts/pd-400.woff2'] }]);

    // the record: state.fonts for the report, ZERO font entries in the ledger
    assert.equal(ctx.state.fonts.length, 1);
    assert.equal(ctx.state.fonts[0].family, 'Playfair Display');
    assert.ok(ctx.ledger.entries.every((e) => e.task_type === 'tokens'), 'the ledger contains no font entries');
    // tokens.json (the applied record) carries the activation
    const record = JSON.parse(readFileSync(join(ctx.runDir, 'tokens.json'), 'utf8'));
    assert.ok(record.typography.families[0].fontFace);
});

test('a sourceless run never touches the font lane (byte-identical behavior)', async () => {
    const rest = async () => { throw new Error('the font lane must not run'); };
    const ctx = makeCtx({ outputs: [JSON.stringify(goodTokens())], rest });
    await s3.run(ctx);
    assert.equal(ctx.state.fonts, undefined);
});

test('a font-lane failure fails the run before any apply — the promise is not optional', async () => {
    const rest = async () => { throw new Error('unreachable'); };
    const failingFetch = async () => ({ ok: false, status: 404, text: async () => '' });
    const ctx = makeCtx({ outputs: [JSON.stringify(sourcedTokens())], rest, fetchImpl: failingFetch });
    await assert.rejects(() => s3.run(ctx), (e) => e.code === 'font_failed');
    assert.equal(ctx.calls.length, 1, 'only the dry run happened; the world was never mutated');
});
