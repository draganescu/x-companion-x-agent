import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
