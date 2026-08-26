import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleAll, pLimit } from '../lib/limit.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('settleAll: values in order on success', async () => {
    assert.deepEqual(await settleAll([Promise.resolve(1), sleep(5).then(() => 2)]), [1, 2]);
});

test('settleAll: the first rejection (by position) propagates', async () => {
    await assert.rejects(
        () => settleAll([sleep(10).then(() => { throw new Error('slow-first'); }), Promise.reject(new Error('fast-second'))]),
        /slow-first/,
    );
});

test('settleAll: every lane settles BEFORE the failure is rethrown — no orphans', async () => {
    let slowFinished = false;
    await assert.rejects(() => settleAll([
        Promise.reject(new Error('fatal')),
        sleep(20).then(() => { slowFinished = true; }),
    ]), /fatal/);
    assert.equal(slowFinished, true, 'the slow lane must have completed before the throw — an orphan here is the zombie-run bug');
});

test('settleAll composes with pLimit: queued thunks still run to completion after a sibling fails', async () => {
    const limiter = pLimit(1);
    const done = [];
    await assert.rejects(() => settleAll([
        limiter(async () => { throw new Error('lane 1 dies'); }),
        limiter(async () => { await sleep(5); done.push(2); }),
        limiter(async () => { done.push(3); }),
    ]), /lane 1 dies/);
    assert.deepEqual(done, [2, 3]);
});
