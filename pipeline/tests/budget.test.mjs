import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBudget, BudgetMeter, Ledger } from '../budget.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));

test('M1 acceptance: S=3,B=1,P=1,I=2 => ceiling 16', () => {
    const b = computeBudget(fixture);
    assert.deepEqual(b, { S: 3, B: 1, P: 1, I: 2, base: 7, ceiling: 16 });
});

test('M1 acceptance: the 17th generative call throws {code:"budget_exceeded"}', () => {
    const meter = new BudgetMeter({});
    meter.spend('brief', 'brief'); // pre-ceiling call #1 (S1 itself)
    meter.setCeiling(16);
    for (let i = 2; i <= 16; i += 1) meter.spend('tree', `s${i}`);
    assert.equal(meter.spent, 16);
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
