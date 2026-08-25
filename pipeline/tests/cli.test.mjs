import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../cli.mjs';
import {
    mergeConnection, scrubConnection, readAgentConfig, storeProviderKey,
    defaultBuildConfig, pickProvider, writeBuildConfig,
} from '../lib/site.mjs';
import { loadPipelineConfig, TASK_TYPES } from '../lib/config.mjs';

test('parseArgs: flags, booleans, positionals', () => {
    const { flags, positionals } = parseArgs(['a bakery site', '--until', 'S3_tokens', '--new-site', '--port', '9431'], { booleans: ['new-site'] });
    assert.deepEqual(positionals, ['a bakery site']);
    assert.equal(flags.until, 'S3_tokens');
    assert.equal(flags['new-site'], true);
    assert.equal(flags.port, '9431');
});

test('mergeConnection preserves provider keys; scrubConnection removes only the connection', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'x-pipeline-cli-'));
    writeFileSync(join(cwd, '.x-agent.json'), JSON.stringify({ cerebras_api_key: 'sk-c' }));
    mergeConnection(cwd, { url: 'http://127.0.0.1:9430', user: 'admin', app_password: 'pw' });
    let cfg = readAgentConfig(cwd);
    assert.equal(cfg.cerebras_api_key, 'sk-c');
    assert.equal(cfg.url, 'http://127.0.0.1:9430');

    // wrong-url scrub is a no-op
    assert.equal(scrubConnection(cwd, { onlyUrl: 'http://elsewhere' }), false);
    assert.equal(readAgentConfig(cwd).url, 'http://127.0.0.1:9430');

    assert.equal(scrubConnection(cwd, { onlyUrl: 'http://127.0.0.1:9430' }), true);
    cfg = readAgentConfig(cwd);
    assert.equal(cfg.url, undefined);
    assert.equal(cfg.app_password, undefined);
    assert.equal(cfg.cerebras_api_key, 'sk-c');
});

test('storeProviderKey writes into .x-agent.json without touching the rest', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'x-pipeline-cli-'));
    mergeConnection(cwd, { url: 'http://x', user: 'u', app_password: 'p' });
    storeProviderKey(cwd, 'gemini_api_key', 'sk-g');
    const cfg = readAgentConfig(cwd);
    assert.equal(cfg.gemini_api_key, 'sk-g');
    assert.equal(cfg.url, 'http://x');
});

test('defaultBuildConfig routes every task and passes the pipeline preflight', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'x-pipeline-cli-'));
    const config = defaultBuildConfig({ provider: 'cerebras', model: 'gpt-oss-120b' });
    for (const t of TASK_TYPES) {
        assert.equal(config.tasks[t].provider, 'cerebras');
        assert.equal(typeof config.tasks[t].temperature, 'number');
    }
    const file = writeBuildConfig(cwd, config);
    assert.ok(existsSync(file));
    const loaded = loadPipelineConfig(file); // throws if the written config is invalid
    assert.equal(loaded.concurrency, 3);
    assert.equal(loaded.budget_hard_cap, 80);
});

test('pickProvider prefers cerebras, then gemini, then anthropic; null with no keys', () => {
    assert.equal(pickProvider({}), null);
    assert.equal(pickProvider({ gemini_api_key: 'g' }), 'gemini');
    assert.equal(pickProvider({ gemini_api_key: 'g', cerebras_api_key: 'c' }), 'cerebras');
    assert.equal(pickProvider({ anthropic_api_key: 'a' }), 'anthropic');
});

test('listBuilds reads every run newest-first with title, url and status', async () => {
    const { listBuilds } = await import('../lib/site.mjs');
    const cwd = mkdtempSync(join(tmpdir(), 'x-pipeline-builds-'));
    const mkRun = (stamp, state, brief) => {
        const dir = join(cwd, 'runs', stamp);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
        if (brief) writeFileSync(join(dir, 'brief.json'), JSON.stringify(brief));
    };
    mkRun('20260101-090000', {
        completed: ['S1_brief', 'S2_read_instance'],
        prompt: 'a bindery',
        budget: { S: 2, B: 0, P: 0, I: 1 },
    }, { identity: { site_title: 'Stitch & Bind' } });
    mkRun('20260102-101500', {
        completed: ['S1_brief', 'S8_publish', 'S9_verify'],
        published: { pages: [{ slug: 'home', front_page: true, link: 'http://127.0.0.1:9430/home/' }] },
        budget: { S: 5, B: 1, P: 1, I: 3 },
    }, { identity: { site_title: 'Beer Station' } });
    mkRun('20260103-120000', {
        completed: ['S1_brief', 'S4_sections'],
        failure: { code: 'gate_failed', message: 'nope' },
    }, { identity: { site_title: 'Broken Co' } });
    mkdirSync(join(cwd, 'runs', 'not-a-run'), { recursive: true });   // ignored

    const builds = listBuilds(cwd);
    assert.deepEqual(builds.map((b) => b.run), ['20260103-120000', '20260102-101500', '20260101-090000']);

    const [broken, published, partial] = builds;
    assert.equal(broken.status, 'failed at S4_sections: gate_failed');
    assert.equal(broken.url, null);

    assert.equal(published.title, 'Beer Station');
    assert.equal(published.status, 'verified');
    assert.equal(published.url, 'http://127.0.0.1:9430/');          // normalized to the site root
    assert.deepEqual(published.budget, { S: 5, B: 1, P: 1, I: 3 });

    assert.equal(partial.status, 'stopped after S2_read_instance');
    assert.equal(partial.prompt, 'a bindery');

    assert.deepEqual(listBuilds(mkdtempSync(join(tmpdir(), 'x-pipeline-empty-'))), []);
});
