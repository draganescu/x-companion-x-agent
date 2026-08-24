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

test('deriveThemeSpacing/Layout map global-settings shapes into DesignTokens shapes', () => {
    assert.deepEqual(deriveThemeSpacing(THEME_TOKENS),
        { scale_unit: 'px', steps: [{ slug: '40', size: '1rem' }, { slug: '50', size: 'clamp(2rem, 4vw, 3rem)' }] });
    assert.deepEqual(deriveThemeLayout(THEME_TOKENS), { contentSize: '640px', wideSize: '1200px' });
});
