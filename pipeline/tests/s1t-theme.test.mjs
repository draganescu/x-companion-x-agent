import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../stages/s1t-theme.mjs';
import { createLlm } from '../lib/llm.mjs';
import { BudgetMeter, Ledger } from '../budget.mjs';

const PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));

const themeSpec = (over = {}) => ({
    version: 1,
    identity: {
        name: 'Salon Regale Theme',
        slug: 'salon-regale',
        description: 'A bespoke ground for the Salon Regale — gilt editorial calm.',
    },
    skeleton: 'stacked',
    measure: { contentSize: '680px', wideSize: '1080px' },
    physics: { blockGap: '1.5rem', rootPadding: { top: '0px', right: '24px', bottom: '0px', left: '24px' } },
    presets: { shadows: [], gradients: [], duotones: [], custom: {} },
    ...over,
});

const brief = {
    identity: { site_title: 'Salon Regale', tagline: 'gilt calm' },
    art_direction: 'Gilt editorial calm over deep aubergine.',
    style: { artistic: 'Art Deco', ui: 'Editorial Magazine', rationale: 'gilt lines meet reading columns' },
    pages: [{ title: 'Home', slug: 'home', sections: [{ role: 'hero' }, { role: 'features' }] }],
    custom_blocks: [],
    schema_packages: [],
};

function makeCtx({ outputs = [], buildResults = [], bespoke = true, budgetPlan } = {}) {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s1t-'));
    mkdirSync(join(runDir, 'theme'), { recursive: true });
    const budget = new BudgetMeter({});
    budget.setCeiling(budgetPlan?.ceiling ?? 20);
    const ledger = new Ledger(runDir);
    const provider = {
        id: 'scripted',
        complete: async () => ({ text: outputs.shift(), usage: { input_tokens: 1, output_tokens: 1 } }),
    };
    const calls = [];
    const logs = [];
    let builds = 0;
    return {
        runDir,
        budget,
        ledger,
        calls,
        logs,
        llm: createLlm({ providers: new Map([['theme', { provider, model: 'm' }]]), promptsDir: PROMPTS_DIR, budget, ledger, log: () => {} }),
        state: {
            bespoke,
            brief: structuredClone(brief),
            ...(budgetPlan ? { budget: structuredClone(budgetPlan) } : {}),
        },
        log: (m) => logs.push(m),
        call: async (name, args) => {
            calls.push([name, args]);
            if (name === 'wp_theme_scaffold') {
                const spec = args.spec;
                return { ok: true, data: { dir: join(args.dir, spec.identity.slug), slug: spec.identity.slug, name: spec.identity.name, files: [], ...(spec.skeleton === 'rail' ? { rail_width: '20rem' } : {}) } };
            }
            if (name === 'wp_theme_build_test') {
                const result = buildResults[builds] ?? { built: true };
                builds += 1;
                return { ok: true, data: { ...result, ...(result.built ? { zip_path: join(args.dir, '.x-agent-build', 'theme.zip') } : {}) } };
            }
            if (name === 'wp_theme_install') {
                return { ok: true, data: { installed: { slug: 'salon-regale', name: 'Salon Regale Theme', version: '1.0.0' }, fingerprint: 'f'.repeat(64), replaced_previous: false } };
            }
            throw new Error(`unexpected tool ${name}`);
        },
    };
}

test('a non-bespoke run inherits the ground: zero calls, zero ledger entries, one notice', async () => {
    const ctx = makeCtx({ bespoke: false });
    await run(ctx);
    assert.deepEqual(ctx.calls, []);
    assert.equal(ctx.ledger.entries.length, 0);
    assert.equal(ctx.budget.spent, 0);
    assert.equal(ctx.logs.length, 1);
    assert.match(ctx.logs[0], /inherited theme/);
});

test('the bespoke happy path: one theme call, scaffold -> build test -> install, state adopted', async () => {
    const ctx = makeCtx({ outputs: [JSON.stringify(themeSpec())] });
    await run(ctx);

    assert.deepEqual(ctx.calls.map(([n]) => n), ['wp_theme_scaffold', 'wp_theme_build_test', 'wp_theme_install']);
    assert.equal(ctx.calls[0][1].dir, join(ctx.runDir, 'theme'));
    assert.equal(ctx.ledger.entries.length, 1);
    assert.equal(ctx.ledger.entries[0].task_type, 'theme');
    assert.equal(ctx.ledger.entries[0].outcome, 'ok');
    assert.equal(ctx.state.theme.slug, 'salon-regale');
    assert.equal(ctx.state.theme.skeleton, 'stacked');
    assert.deepEqual(ctx.state.theme.measure, { contentSize: '680px', wideSize: '1080px' });
    assert.equal(ctx.state.fingerprint, 'f'.repeat(64));
    assert.ok(existsSync(join(ctx.runDir, 'theme', 'theme-spec.json')));
    assert.deepEqual(JSON.parse(readFileSync(join(ctx.runDir, 'theme', 'theme-spec.json'), 'utf8')), themeSpec());
});

test('a failed build gate gets ONE spec repair, recompiled whole, then succeeds', async () => {
    const ctx = makeCtx({
        outputs: [JSON.stringify(themeSpec()), JSON.stringify(themeSpec({ measure: { contentSize: '640px', wideSize: '1080px' } }))],
        buildResults: [{ built: false, failure: { code: 'smoke_failed', message: 'content clamps wrong' } }, { built: true }],
    });
    await run(ctx);

    assert.deepEqual(ctx.calls.map(([n]) => n), [
        'wp_theme_scaffold', 'wp_theme_build_test',
        'wp_theme_scaffold', 'wp_theme_build_test',
        'wp_theme_install',
    ]);
    const labels = ctx.ledger.entries.map((e) => e.label);
    assert.deepEqual(labels, ['theme', 'theme/repair']);
    assert.equal(ctx.state.theme.measure.contentSize, '640px');
});

test('a second build failure aborts the run at preflight depth — no ground, no site', async () => {
    const ctx = makeCtx({
        outputs: [JSON.stringify(themeSpec()), JSON.stringify(themeSpec())],
        buildResults: [
            { built: false, failure: { code: 'smoke_failed', message: 'root seams 19px' } },
            { built: false, failure: { code: 'smoke_failed', message: 'root seams 19px' } },
        ],
    });
    await assert.rejects(() => run(ctx), (e) => e.code === 'preflight_failed' && /no ground, no site/.test(e.message));
    assert.equal(ctx.ledger.entries.length, 2);
    assert.equal(ctx.calls.filter(([n]) => n === 'wp_theme_install').length, 0);
});

test('a rail skeleton bumps F to 3 and re-issues the ceiling (M3)', async () => {
    const plan = { S: 3, B: 1, P: 1, I: 2, T: 1, F: 2, base: 10, ceiling: 22 };
    const ctx = makeCtx({ outputs: [JSON.stringify(themeSpec({ skeleton: 'rail' }))], budgetPlan: plan });
    await run(ctx);

    assert.equal(ctx.state.budget.F, 3);
    assert.equal(ctx.state.budget.base, 11);
    assert.equal(ctx.state.budget.ceiling, 24);
    assert.equal(ctx.budget.ceiling, 24);
    assert.equal(ctx.state.theme.rail_width, '20rem');
    assert.ok(ctx.logs.some((m) => /rail.*ceiling is now 24/.test(m)));
});

test('a contract-violating spec burns the schema retry with the exact issues in the retry prompt', async () => {
    const bad = themeSpec({ skeleton: 'floating' });
    const ctx = makeCtx({ outputs: [JSON.stringify(bad), JSON.stringify(themeSpec())] });
    await run(ctx);

    assert.equal(ctx.ledger.entries.length, 2);
    assert.equal(ctx.ledger.entries[0].outcome, 'schema_failed');
    assert.equal(ctx.ledger.entries[1].outcome, 'ok');
});
