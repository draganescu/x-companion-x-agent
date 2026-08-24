import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineError } from '../lib/errors.mjs';
import { canonicalJson, sha256 } from '../lib/hash.mjs';
import { pLimit } from '../lib/limit.mjs';

test('PipelineError carries code, hint, extra', () => {
    const e = new PipelineError('budget_exceeded', 'over', 'stop', { spent: 17 });
    assert.equal(e.code, 'budget_exceeded');
    assert.equal(e.message, 'over');
    assert.equal(e.hint, 'stop');
    assert.deepEqual(e.extra, { spent: 17 });
    assert.ok(e instanceof Error);
});

test('canonicalJson sorts keys recursively; sha256 is stable', () => {
    const a = canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 });
    assert.equal(a, b);
    assert.equal(sha256('x'), '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
});

test('pLimit runs at most n thunks concurrently and preserves results', async () => {
    const limit = pLimit(2);
    let active = 0;
    let peak = 0;
    const job = (v) => async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return v;
    };
    const out = await Promise.all([1, 2, 3, 4, 5].map((v) => limit(job(v))));
    assert.deepEqual(out, [1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
});

test('pLimit propagates rejections without jamming the queue', async () => {
    const limit = pLimit(1);
    await assert.rejects(limit(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await limit(async () => 'ok'), 'ok');
});
