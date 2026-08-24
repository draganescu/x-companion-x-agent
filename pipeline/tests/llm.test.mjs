import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetMeter, Ledger } from '../budget.mjs';
import { createLlm, extractJson } from '../lib/llm.mjs';

test('extractJson: plain, fenced, and prose-wrapped', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('Here you go:\n{"a":1}\nHope that helps!'), { a: 1 });
    assert.throws(() => extractJson('not json at all'));
});

function harness({ outputs }) {
    const dir = mkdtempSync(join(tmpdir(), 'x-pipeline-llm-'));
    writeFileSync(join(dir, 'tree.md'), '---\ntask_type: tree\nrequired: [section]\n---\nDo {{section}}.');
    const calls = [];
    const provider = {
        id: 'scripted',
        complete: async (t, prompt) => { calls.push(prompt); return { text: outputs.shift(), usage: { input_tokens: 1, output_tokens: 1 } }; },
    };
    const providers = new Map([['tree', { provider, model: 'm', temperature: 0 }]]);
    const budget = new BudgetMeter({});
    budget.setCeiling(10);
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-llm-run-'));
    const ledger = new Ledger(runDir);
    return { llm: createLlm({ providers, promptsDir: dir, budget, ledger }), calls, budget, ledger };
}

test('clean call: 1 spend, 1 ledger entry, outcome ok', async () => {
    const h = harness({ outputs: ['{"n":1}'] });
    const out = await h.llm.generate({ task_type: 'tree', label: 'home/hero', payload: { section: 'hero' }, validate: () => [] });
    assert.deepEqual(out, { value: { n: 1 }, attempts: 1 });
    assert.equal(h.budget.spent, 1);
    assert.equal(h.ledger.entries.length, 1);
    assert.equal(h.ledger.entries[0].outcome, 'ok');
    assert.equal(h.ledger.entries[0].label, 'home/hero');
});

test('contract failure retries EXACTLY once with issues in the prompt, both metered', async () => {
    const h = harness({ outputs: ['{"bad":true}', '{"good":true}'] });
    const validate = (v) => (v.good ? [] : [{ path: '/bad', message: 'not allowed' }]);
    const out = await h.llm.generate({ task_type: 'tree', label: 'l', payload: { section: 's' }, validate });
    assert.equal(out.attempts, 2);
    assert.equal(h.budget.spent, 2);
    assert.match(h.calls[1], /CONTRACT FAILURE/);
    assert.match(h.calls[1], /\/bad: not allowed/);
    assert.deepEqual(h.ledger.entries.map((e) => e.outcome), ['schema_failed', 'ok']);
});

test('second contract failure throws contract_failed with issues attached', async () => {
    const h = harness({ outputs: ['nonsense', 'still nonsense'] });
    await assert.rejects(
        h.llm.generate({ task_type: 'tree', label: 'l', payload: { section: 's' }, validate: () => [] }),
        (e) => e.code === 'contract_failed' && e.extra.issues.length > 0);
    assert.equal(h.budget.spent, 2);
    assert.deepEqual(h.ledger.entries.map((e) => e.outcome), ['invalid_json', 'invalid_json']);
});

test('maxAttempts 1 (repair mode) never retries', async () => {
    const h = harness({ outputs: ['nonsense'] });
    await assert.rejects(h.llm.generate({ task_type: 'tree', label: 'l', payload: { section: 's' }, validate: () => [], maxAttempts: 1 }));
    assert.equal(h.budget.spent, 1);
});

test('budget is consulted BEFORE the provider call', async () => {
    const h = harness({ outputs: ['{"n":1}'] });
    for (let i = 0; i < 9; i += 1) h.budget.spend('x', `pre${i}`);
    await assert.rejects(async () => {
        await h.llm.generate({ task_type: 'tree', label: 'a', payload: { section: 's' }, validate: () => [] });
        await h.llm.generate({ task_type: 'tree', label: 'b', payload: { section: 's' }, validate: () => [] });
    }, (e) => e.code === 'budget_exceeded');
    assert.equal(h.calls.length, 1);
});
