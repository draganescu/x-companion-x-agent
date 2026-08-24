import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create as anthropic } from '../providers/anthropic.mjs';
import { create as openai } from '../providers/openai.mjs';
import { create as cerebras } from '../providers/cerebras.mjs';

function fetchStub(responses) {
    const calls = [];
    return {
        calls,
        fetch: async (url, init) => {
            calls.push({ url, init: JSON.parse(init.body), headers: init.headers });
            const next = responses.shift();
            if (next instanceof Error) throw next;
            return { ok: next.status < 400, status: next.status, json: async () => next.body, text: async () => JSON.stringify(next.body) };
        },
    };
}

test('anthropic: request shape and usage mapping', async () => {
    const stub = fetchStub([{ status: 200, body: { content: [{ type: 'text', text: 'OUT' }], usage: { input_tokens: 11, output_tokens: 3 } } }]);
    const p = anthropic({ keys: { anthropic_api_key: 'sk-a' }, options: { fetch: stub.fetch } });
    const out = await p.complete('tree', 'PROMPT', {}, { model: 'claude-opus-5', temperature: 0.3 });
    assert.equal(out.text, 'OUT');
    assert.deepEqual(out.usage, { input_tokens: 11, output_tokens: 3 });
    const call = stub.calls[0];
    assert.match(call.url, /api\.anthropic\.com\/v1\/messages/);
    assert.equal(call.headers['x-api-key'], 'sk-a');
    assert.equal(call.init.model, 'claude-opus-5');
    assert.equal(call.init.temperature, 0.3);
    assert.deepEqual(call.init.messages, [{ role: 'user', content: 'PROMPT' }]);
});

test('openai + cerebras: chat-completions shape', async () => {
    for (const [make, host, key] of [[openai, 'api.openai.com', 'openai_api_key'], [cerebras, 'api.cerebras.ai', 'cerebras_api_key']]) {
        const stub = fetchStub([{ status: 200, body: { choices: [{ message: { content: 'OUT' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } } }]);
        const p = make({ keys: { [key]: 'sk-x' }, options: { fetch: stub.fetch } });
        const out = await p.complete('block', 'PROMPT', {}, { model: 'm1', temperature: 0 });
        assert.equal(out.text, 'OUT');
        assert.deepEqual(out.usage, { input_tokens: 7, output_tokens: 2 });
        assert.match(stub.calls[0].url, new RegExp(host));
        assert.equal(stub.calls[0].headers.Authorization, 'Bearer sk-x');
    }
});

test('transport errors retry 3x then throw provider_error; 4xx does not retry', async () => {
    const stub = fetchStub([{ status: 500, body: {} }, { status: 500, body: {} }, { status: 200, body: { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }]);
    const p = openai({ keys: { openai_api_key: 'k' }, options: { fetch: stub.fetch, backoff_ms: 1 } });
    assert.equal((await p.complete('tree', 'P', {}, { model: 'm' })).text, 'OK');
    assert.equal(stub.calls.length, 3);

    const bad = fetchStub([{ status: 400, body: { error: 'bad request' } }]);
    const p2 = openai({ keys: { openai_api_key: 'k' }, options: { fetch: bad.fetch, backoff_ms: 1 } });
    await assert.rejects(p2.complete('tree', 'P', {}, { model: 'm' }), (e) => e.code === 'provider_error');
    assert.equal(bad.calls.length, 1);
});
