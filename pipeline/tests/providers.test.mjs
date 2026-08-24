import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createFake } from '../providers/fake.mjs';
import { createProviders } from '../providers/index.mjs';

const dir = mkdtempSync(join(tmpdir(), 'x-pipeline-fixtures-'));
writeFileSync(join(dir, 'tree.home-hero.json'), JSON.stringify({ text: '{"version":1}', usage: { input_tokens: 5, output_tokens: 7 } }));

test('fake provider replays a fixture keyed by task_type + label', async () => {
    const fake = createFake({ options: { fixtures_dir: dir } });
    const out = await fake.complete('tree', 'PROMPT', { any: 'payload' }, { model: 'fixtures', label: 'home/hero' });
    assert.equal(out.text, '{"version":1}');
    assert.deepEqual(out.usage, { input_tokens: 5, output_tokens: 7 });
});

test('a missing fixture throws fixture_missing naming the path', async () => {
    const fake = createFake({ options: { fixtures_dir: dir } });
    await assert.rejects(fake.complete('tree', 'P', {}, { model: 'fixtures', label: 'nope' }),
        (e) => e.code === 'fixture_missing' && /tree\.nope\.json/.test(e.message));
});

test('createProviders routes every task and rejects unknown provider modules', async () => {
    const tasks = Object.fromEntries(['brief', 'tokens', 'tree', 'block', 'schema', 'repair']
        .map((t) => [t, { provider: 'fake', model: 'fixtures' }]));
    const routed = await createProviders({ config: { tasks }, keys: {} });
    assert.equal(routed.get('tree').provider.id, 'fake');
    assert.equal(routed.get('brief').model, 'fixtures');

    tasks.tree = { provider: 'no-such-provider', model: 'x' };
    await assert.rejects(createProviders({ config: { tasks }, keys: {} }),
        (e) => e.code === 'preflight_failed' && /tree/.test(e.message) && /no-such-provider/.test(e.message));
});

test('a real provider without its key fails preflight naming the key', async () => {
    const tasks = { brief: { provider: 'anthropic', model: 'claude-opus-5' } };
    await assert.rejects(createProviders({ config: { tasks: { ...tasks } }, keys: {} }),
        (e) => e.code === 'preflight_failed' && /anthropic_api_key/.test(e.message));
});
