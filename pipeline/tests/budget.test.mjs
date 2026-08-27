import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBudget, BudgetMeter, Ledger } from '../budget.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));

test('M1 acceptance: S=3,B=1,P=1,I=2 => base 9 with F=2 furniture, ceiling 20', () => {
    const b = computeBudget(fixture);
    assert.deepEqual(b, { S: 3, B: 1, P: 1, C: 2, U: 0, I: 2, F: 2, base: 9, ceiling: 20 });
});

test('I = C + U: surface births are metered once per unique dictionary asset', () => {
    const brief = structuredClone(fixture);
    brief.surfaces = [
        { id: 'linen-wash', class: 'field', prompt_seed: 'Woven linen texture', intensity: 'whisper', attach: ['home/hero'] },
        { id: 'deco-frieze', class: 'frieze', prompt_seed: 'Deco border strip', intensity: 'present', attach: ['home/what-we-bake'], edge: 'top' },
        { id: 'deco-frieze', class: 'frieze', prompt_seed: 'Deco border strip', intensity: 'present', attach: ['home/signup'], edge: 'bottom' },
    ];
    const b = computeBudget(brief);
    assert.equal(b.C, 2);
    assert.equal(b.U, 2);
    assert.equal(b.I, 4);
    assert.equal(b.ceiling, 2 * 9 + 4);
});

test('M1 acceptance: the 21st generative call throws {code:"budget_exceeded"}', () => {
    const meter = new BudgetMeter({});
    meter.spend('brief', 'brief'); // pre-ceiling call #1 (S1 itself)
    meter.setCeiling(20);
    for (let i = 2; i <= 20; i += 1) meter.spend('tree', `s${i}`);
    assert.equal(meter.spent, 20);
    assert.throws(() => meter.spend('tree', 'one-too-many'), (e) => e.code === 'budget_exceeded');
});

test('pre-ceiling spending is capped at 2 (S1 + its schema retry)', () => {
    const meter = new BudgetMeter({});
    meter.spend('brief', 'brief');
    meter.spend('brief', 'brief');
    assert.throws(() => meter.spend('brief', 'brief'), (e) => e.code === 'budget_exceeded');
});

test('hard cap refuses a too-expensive brief at setCeiling time', () => {
    const meter = new BudgetMeter({ hard_cap: 10 });
    meter.spend('brief', 'brief');
    assert.throws(() => meter.setCeiling(16), (e) => e.code === 'budget_exceeded');
});

test('ledger: jsonl appended live, ledger.json flushed in deterministic order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-pipeline-ledger-'));
    const ledger = new Ledger(dir);
    ledger.record({ task_type: 'tree', label: 'home/features', provider: 'fake', model: 'f', prompt_hash: 'p2', payload_hash: 'q2', usage: { input_tokens: 1, output_tokens: 1 }, attempt: 1, outcome: 'ok', started_at: 5, ms: 1 });
    ledger.record({ task_type: 'tree', label: 'home/hero', provider: 'fake', model: 'f', prompt_hash: 'p1', payload_hash: 'q1', usage: { input_tokens: 1, output_tokens: 1 }, attempt: 1, outcome: 'ok', started_at: 9, ms: 1 });
    ledger.flush();
    const arr = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
    assert.deepEqual(arr.map((e) => e.label), ['home/features', 'home/hero']);
    const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).label, 'home/features');
});

test('array image_intent counts every entry: features with 2 intents => I=3, ceiling 21', async () => {
    const { sectionImageIntents } = await import('../budget.mjs');
    const brief = structuredClone(fixture);
    brief.pages[0].sections[1].image_intent = ['intent one is long enough', 'intent two is long enough'];
    const b = computeBudget(brief);
    assert.equal(b.I, 3);
    assert.equal(b.ceiling, 2 * 9 + 3);
    assert.deepEqual(sectionImageIntents({ image_intent: 'x' }), ['x']);
    assert.deepEqual(sectionImageIntents({}), []);
});

test('Ledger reads an existing ledger.jsonl back so a resume knows its own spend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-ledger-'));
    const first = new Ledger(dir);
    first.record({ task_type: 'tree', label: 'a/one', attempt: 1, outcome: 'ok', usage: {} });
    first.record({ task_type: 'tree', label: 'a/two', attempt: 1, outcome: 'ok', usage: {} });
    assert.equal(first.entries.length, 2);

    // A second process over the same run dir — this is what --resume does.
    const resumed = new Ledger(dir);
    assert.equal(resumed.entries.length, 2);
    resumed.record({ task_type: 'block', label: 'b/one', attempt: 1, outcome: 'ok', usage: {} });
    assert.equal(resumed.entries.length, 3);
    assert.deepEqual(resumed.entries.map((e) => e.label), ['a/one', 'a/two', 'b/one']);
});

test('a resumed budget carries prior spend, so the ceiling still binds', () => {
    const meter = new BudgetMeter({ hard_cap: 100 });
    meter.setCeiling(4);
    meter.rehydrate([
        { task_type: 'tree', label: 'a' },
        { task_type: 'tree', label: 'b' },
        { task_type: 'tree', label: 'c' },
    ]);
    assert.equal(meter.spent, 3);
    assert.equal(meter.calls.length, 3);
    meter.spend('tree', 'd'); // the 4th is the last one the ceiling allows
    assert.equal(meter.spent, 4);
    assert.throws(() => meter.spend('tree', 'e'), (e) => e.code === 'budget_exceeded');
});
