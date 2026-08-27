import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from '../run.mjs';
import { TASK_TYPES } from '../lib/config.mjs';

function setup() {
    const cwd = mkdtempSync(join(tmpdir(), 'x-pipeline-run-'));
    const tasks = Object.fromEntries(TASK_TYPES.map((t) => [t, { provider: 'fake', model: 'fixtures' }]));
    writeFileSync(join(cwd, 'pipeline.config.json'), JSON.stringify({ tasks }));
    return cwd;
}

test('stages run in order, state persists, --until stops, resume skips', async () => {
    const cwd = setup();
    const ran = [];
    const mk = (id) => ({ id, kind: 'deterministic', run: async (ctx) => { ran.push(id); ctx.state[id] = true; } });
    const stages = [mk('S1_brief'), mk('S2_read_instance'), mk('S3_tokens')];

    const { runDir } = await runPipeline({ prompt: 'p', cwd, until: 'S2_read_instance', stages, skipToolchain: true });
    assert.deepEqual(ran, ['S1_brief', 'S2_read_instance']);
    const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    assert.deepEqual(state.completed, ['S1_brief', 'S2_read_instance']);
    assert.ok(existsSync(join(runDir, 'trees')));

    await runPipeline({ prompt: 'p', cwd, resumeDir: runDir, stages, skipToolchain: true });
    assert.deepEqual(ran, ['S1_brief', 'S2_read_instance', 'S3_tokens']);
});

test('a stage failure still flushes ledger and report, and the error surfaces', async () => {
    const cwd = setup();
    const boom = { id: 'S1_brief', kind: 'generative', run: async () => { const e = new Error('gate dead'); e.code = 'contract_failed'; throw e; } };
    let thrown;
    try {
        await runPipeline({ prompt: 'p', cwd, stages: [boom], skipToolchain: true });
    } catch (e) { thrown = e; }
    assert.equal(thrown.code, 'contract_failed');
    const runs = join(cwd, 'runs');
    const dir = join(runs, readdirSync(runs)[0]);
    assert.ok(existsSync(join(dir, 'ledger.json')));
    assert.ok(existsSync(join(dir, 'report.md')));
    assert.match(readFileSync(join(dir, 'report.md'), 'utf8'), /contract_failed/);
});

test('--until binds a resumed run: completed stages up to it are skipped and it still stops there', async () => {
    const cwd = setup();
    const ran = [];
    const mk = (id) => ({ id, kind: 'deterministic', run: async () => { ran.push(id); } });
    const stages = [mk('S1_brief'), mk('S1T_theme'), mk('S2_read_instance')];

    const first = await runPipeline({ prompt: 'p', cwd, until: 'S1T_theme', stages, skipToolchain: true });
    assert.deepEqual(ran, ['S1_brief', 'S1T_theme']);

    ran.length = 0;
    await runPipeline({ prompt: 'p', cwd, resumeDir: first.runDir, until: 'S1T_theme', stages, skipToolchain: true });
    assert.deepEqual(ran, [], 'everything up to --until was already done; NOTHING past it may run');
});
