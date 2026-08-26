import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetMeter, Ledger } from '../budget.mjs';
import { createLlm } from '../lib/llm.mjs';
import * as s5 from '../stages/s5-blocks.mjs';
import * as s6 from '../stages/s6-schema-packages.mjs';

const brief = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));
const PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));

const TOKENS = {
    palette: [{ slug: 'base', name: 'B', color: '#ffffff' }],
    spacing: { scale_unit: 'px', steps: [{ slug: '40', size: '1rem' }] },
    typography: { families: [], sizes: [{ slug: 'display', size: '4rem' }] },
    layout: { contentSize: '640px', wideSize: '1200px' },
};

function makeCtx({ taskType, outputs, calls }) {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-fact-'));
    for (const d of ['blocks', 'packages']) mkdirSync(join(runDir, d), { recursive: true });
    writeFileSync(join(runDir, 'tokens.json'), JSON.stringify(TOKENS));
    const budget = new BudgetMeter({});
    budget.setCeiling(16);
    const ledger = new Ledger(runDir);
    const provider = { id: 'scripted', complete: async () => ({ text: outputs.shift(), usage: { input_tokens: 1, output_tokens: 1 } }) };
    const log = [];
    return {
        runDir, budget, ledger, callLog: log,
        config: { concurrency: 2 },
        llm: createLlm({ providers: new Map([[taskType, { provider, model: 'm' }]]), promptsDir: PROMPTS_DIR, budget, ledger }),
        state: { brief: structuredClone(brief), fingerprint: 'f2' },
        log: () => {},
        call: async (name, args) => {
            log.push([name, args]);
            return calls(name, args, runDir);
        },
    };
}

function scaffoldBlockDir(runDir) {
    const dir = join(runDir, 'blocks', 'signup-banner');
    mkdirSync(dir, { recursive: true });
    for (const f of ['render.php', 'view.js', 'style.css', 'block.json', 'edit.js']) {
        writeFileSync(join(dir, f), `// scaffold ${f}`);
    }
    return dir;
}

test('S5: scaffold first, LLM files written into the scaffold, gate pass records zip', async () => {
    // Structural root + an element-level colour moment: the shape the
    // inheritance screen allows (a bare-root color/background is rejected).
    const filesOut = { files: { 'render.php': '<?php echo "hi";', 'view.js': 'console.log(1)', 'style.css': '.x{display:grid;gap:var(--wp--preset--spacing--40)}.x__meter{background-color:var(--wp--preset--color--base)}' } };
    const ctx = makeCtx({
        taskType: 'block',
        outputs: [JSON.stringify(filesOut)],
        calls: (name, args, runDir) => {
            if (name === 'wp_block_scaffold') {
                const dir = scaffoldBlockDir(runDir);
                return { ok: true, data: { dir, name: 'agent/signup-banner', files: ['render.php', 'view.js', 'style.css', 'block.json', 'edit.js'] } };
            }
            if (name === 'wp_block_build_test') {
                assert.deepEqual(args.sample_attributes, { heading: 'Get the weekly bake list', buttonLabel: 'Sign up' });
                return { ok: true, data: { built: true, zip_path: '/tmp/z.zip', smoke: { registered: true, rendered_html: '<x>', front: { console_errors: [], view_ready: true, block_present: true } } } };
            }
            throw new Error(`unexpected ${name}`);
        },
    });
    await s5.run(ctx);
    const art = ctx.state.artifacts.blocks['signup-banner'];
    assert.equal(art.status, 'pass');
    assert.equal(art.zip_path, '/tmp/z.zip');
    assert.equal(readFileSync(join(art.dir, 'render.php'), 'utf8'), '<?php echo "hi";');
    assert.equal(ctx.callLog[0][0], 'wp_block_scaffold'); // scaffold BEFORE the LLM call
    assert.equal(ctx.budget.spent, 1);
});

test('S5: a style literal fails the artifact; no zip recorded; stage completes', async () => {
    // Element-level literal: passes the inheritance screen so the BUILD TEST's
    // style_warnings lane is the one exercised here.
    const filesOut = { files: { 'render.php': '<?php', 'view.js': '', 'style.css': '.x__label{color:#c8102e}' } };
    const ctx = makeCtx({
        taskType: 'block',
        outputs: [JSON.stringify(filesOut)],
        calls: (name, _args, runDir) => {
            if (name === 'wp_block_scaffold') {
                const dir = scaffoldBlockDir(runDir);
                return { ok: true, data: { dir, name: 'agent/signup-banner', files: ['render.php'] } };
            }
            return { ok: true, data: { built: true, zip_path: '/z.zip', smoke: { registered: true, rendered_html: '' }, style_warnings: [{ line: 1, literal: '#c8102e', text: 'color:#c8102e' }] } };
        },
    });
    await s5.run(ctx);
    const art = ctx.state.artifacts.blocks['signup-banner'];
    assert.equal(art.status, 'fail');
    assert.equal(art.zip_path, undefined);
    assert.match(art.failures[0].message, /#c8102e/);
});

test('S6: URL-map warnings fail preflight BEFORE any LLM call', async () => {
    const ctx = makeCtx({
        taskType: 'schema',
        outputs: [JSON.stringify({ files: {} })],
        calls: (name) => {
            assert.equal(name, 'wp_schema_scaffold');
            return { ok: true, data: { dir: '/nowhere', slug: 'newsletter', files: [], warnings: ['public type claims /news which page 12 serves'] } };
        },
    });
    await assert.rejects(s6.run(ctx), (e) => e.code === 'preflight_failed' && /URL-map/.test(e.message));
    assert.equal(ctx.ledger.entries.filter((e) => e.task_type === 'schema').length, 0);
    assert.equal(ctx.budget.spent, 0);
});

test('S6: clean scaffold -> LLM handlers -> schema gate pass; thrown gate envelope -> fail artifact', async () => {
    const mkScaffold = (runDir) => {
        const dir = join(runDir, 'packages', 'newsletter');
        mkdirSync(dir, { recursive: true });
        for (const f of ['newsletter.php', 'routes.php', 'uninstall.php']) writeFileSync(join(dir, f), `<?php // ${f}`);
        return dir;
    };
    const good = makeCtx({
        taskType: 'schema',
        outputs: [JSON.stringify({ files: { 'routes.php': '<?php // handlers implemented' } })],
        calls: (name, args, runDir) => {
            if (name === 'wp_schema_scaffold') {
                assert.equal(args.post_types[0].meta[0].key, 'email'); // hyphens -> underscores mapping lane
                return { ok: true, data: { dir: mkScaffold(runDir), slug: 'newsletter', files: ['newsletter.php', 'routes.php', 'uninstall.php'], warnings: [] } };
            }
            return { ok: true, data: { built: true, zip_path: '/tmp/s.zip', smoke: { booted: true, types_registered: { subscriber: true }, meta_in_rest: { 'subscriber:email': true }, taxonomies_registered: {}, routes: [{ path: '/subscribe', status: 200 }], bindings_registered: {}, uninstall_clean: true } } };
        },
    });
    await s6.run(good);
    assert.equal(good.state.artifacts.packages.newsletter.status, 'pass');
    assert.equal(good.state.artifacts.packages.newsletter.zip_path, '/tmp/s.zip');

    const bad = makeCtx({
        taskType: 'schema',
        outputs: [JSON.stringify({ files: { 'routes.php': '<?php global $wpdb;' } })],
        calls: (name, _args, runDir) => {
            if (name === 'wp_schema_scaffold') {
                return { ok: true, data: { dir: mkScaffold(runDir), slug: 'newsletter', files: ['newsletter.php', 'routes.php', 'uninstall.php'], warnings: [] } };
            }
            return { ok: false, data: { code: 'schema_policy', message: 'routes.php:1 — direct $wpdb use', hint: 'core APIs only' } };
        },
    });
    await s6.run(bad);
    assert.equal(bad.state.artifacts.packages.newsletter.status, 'fail');
    assert.equal(bad.state.artifacts.packages.newsletter.failures[0].code, 'schema_policy');
});
