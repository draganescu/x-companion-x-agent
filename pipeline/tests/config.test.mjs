import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPipelineConfig, readProviderKeys, TASK_TYPES } from '../lib/config.mjs';

const dir = mkdtempSync(join(tmpdir(), 'x-pipeline-config-'));

function writeConfig(name, obj) {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(obj));
    return p;
}

const fullTasks = Object.fromEntries(TASK_TYPES.map((t) => [t, { provider: 'fake', model: 'fixtures' }]));

test('a full config loads with defaults applied', () => {
    const cfg = loadPipelineConfig(writeConfig('ok.json', { tasks: fullTasks }));
    assert.equal(cfg.concurrency, 3);
    assert.equal(cfg.budget_hard_cap, Infinity);
    assert.ok(cfg.prompts_dir.endsWith('pipeline/prompts'));
});

test('a missing task entry fails preflight NAMING the task', () => {
    const partial = { ...fullTasks };
    delete partial.repair;
    assert.throws(() => loadPipelineConfig(writeConfig('missing.json', { tasks: partial })),
        (e) => e.code === 'preflight_failed' && /repair/.test(e.message));
});

test('a task entry without model fails preflight naming task and field', () => {
    const bad = { ...fullTasks, tree: { provider: 'fake' } };
    assert.throws(() => loadPipelineConfig(writeConfig('nomodel.json', { tasks: bad })),
        (e) => e.code === 'preflight_failed' && /tree/.test(e.message) && /model/.test(e.message));
});

test('a missing config file fails preflight naming the path', () => {
    assert.throws(() => loadPipelineConfig(join(dir, 'nope.json')),
        (e) => e.code === 'preflight_failed' && /nope\.json/.test(e.message));
});

test('provider keys come from .x-agent.json with env fallback', () => {
    writeFileSync(join(dir, '.x-agent.json'), JSON.stringify({ anthropic_api_key: 'sk-file' }));
    const keys = readProviderKeys(dir, { OPENAI_API_KEY: 'sk-env' });
    assert.equal(keys.anthropic_api_key, 'sk-file');
    assert.equal(keys.openai_api_key, 'sk-env');
    assert.equal(keys.cerebras_api_key, undefined);
});

test('an invalid speed fails preflight naming task and the valid levels', () => {
    const tasks = { ...fullTasks, brief: { provider: 'fake', model: 'fixtures', speed: 'ludicrous' } };
    assert.throws(() => loadPipelineConfig(writeConfig('speed.json', { tasks })),
        (e) => e.code === 'preflight_failed' && /brief/.test(e.message) && /fast, standard/.test(e.message));
    // valid values load
    const ok = { ...fullTasks, brief: { provider: 'fake', model: 'fixtures', speed: 'fast' } };
    loadPipelineConfig(writeConfig('speed-ok.json', { tasks: ok }));
});

test('theme is an OPTIONAL task: absent loads fine, malformed fails naming task and field', async () => {
    const { loadPipelineConfig, OPTIONAL_TASK_TYPES, TASK_TYPES } = await import('../lib/config.mjs');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'x-pipeline-config-'));

    assert.deepEqual(OPTIONAL_TASK_TYPES, ['theme']);
    const tasks = Object.fromEntries(TASK_TYPES.map((t) => [t, { provider: 'fake', model: 'm' }]));

    const without = join(dir, 'without-theme.json');
    writeFileSync(without, JSON.stringify({ tasks }));
    assert.equal(loadPipelineConfig(without).tasks.theme, undefined);

    const malformed = join(dir, 'malformed-theme.json');
    writeFileSync(malformed, JSON.stringify({ tasks: { ...tasks, theme: { provider: 'fake' } } }));
    assert.throws(() => loadPipelineConfig(malformed), (e) => e.code === 'preflight_failed' && /"theme".*"model"/.test(e.message));

    const good = join(dir, 'with-theme.json');
    writeFileSync(good, JSON.stringify({ tasks: { ...tasks, theme: { provider: 'fake', model: 'm', effort: 'high' } } }));
    assert.equal(loadPipelineConfig(good).tasks.theme.effort, 'high');
});
