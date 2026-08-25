import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create as anthropic } from '../providers/anthropic.mjs';
import { create as openai } from '../providers/openai.mjs';
import { create as cerebras } from '../providers/cerebras.mjs';
import { create as gemini } from '../providers/gemini.mjs';

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

// The Messages API is streamed, so the stub hands back an async-iterable body of
// SSE frames rather than a parsed JSON envelope.
function sseStub(events, { status = 200 } = {}) {
    const calls = [];
    const frames = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    return {
        calls,
        fetch: async (url, init) => {
            calls.push({ url, init: JSON.parse(init.body), headers: init.headers });
            return {
                ok: status < 400,
                status,
                text: async () => frames.join(''),
                body: (async function* () {
                    const enc = new TextEncoder();
                    for (const f of frames) yield enc.encode(f);
                })(),
            };
        },
    };
}

const sseOk = (text, { stop_reason = 'end_turn' } = {}) => [
    { type: 'message_start', message: { usage: { input_tokens: 11 } } },
    ...[...text].map((ch) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text: ch } })),
    { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 3 } },
];

test('anthropic: streamed request shape and usage mapping', async () => {
    const stub = sseStub(sseOk('OUT'));
    const p = anthropic({ keys: { anthropic_api_key: 'sk-a' }, options: { fetch: stub.fetch } });
    const out = await p.complete('tree', 'PROMPT', {}, { model: 'claude-opus-5', effort: 'high' });
    assert.equal(out.text, 'OUT');
    assert.deepEqual(out.usage, { input_tokens: 11, output_tokens: 3 });
    const call = stub.calls[0];
    assert.match(call.url, /api\.anthropic\.com\/v1\/messages/);
    assert.equal(call.headers['x-api-key'], 'sk-a');
    assert.equal(call.init.model, 'claude-opus-5');
    assert.equal(call.init.stream, true);
    assert.deepEqual(call.init.output_config, { effort: 'high' });
    assert.deepEqual(call.init.messages, [{ role: 'user', content: 'PROMPT' }]);
    // The knob current Anthropic models reject must be absent unless asked for.
    assert.ok(!('temperature' in call.init), 'temperature must not be sent when the route omits it');
});

test('anthropic: temperature and max_tokens ride through only when routed', async () => {
    const stub = sseStub(sseOk('OUT'));
    const p = anthropic({ keys: { anthropic_api_key: 'sk-a' }, options: { fetch: stub.fetch } });
    await p.complete('tree', 'P', {}, { model: 'claude-sonnet-5', temperature: 1, max_tokens: 4096 });
    assert.equal(stub.calls[0].init.temperature, 1);
    assert.equal(stub.calls[0].init.max_tokens, 4096);
    assert.ok(!('output_config' in stub.calls[0].init), 'effort must not be sent when the route omits it');
});

test('anthropic: fast mode sends the speed param AND its beta header together, or neither', async () => {
    const fast = sseStub(sseOk('OUT'));
    const p1 = anthropic({ keys: { anthropic_api_key: 'sk-a' }, options: { fetch: fast.fetch } });
    await p1.complete('brief', 'P', {}, { model: 'claude-opus-5', speed: 'fast' });
    assert.equal(fast.calls[0].init.speed, 'fast');
    assert.equal(fast.calls[0].headers['anthropic-beta'], 'fast-mode-2026-02-01');

    const std = sseStub(sseOk('OUT'));
    const p2 = anthropic({ keys: { anthropic_api_key: 'sk-a' }, options: { fetch: std.fetch } });
    await p2.complete('brief', 'P', {}, { model: 'claude-opus-5' });
    assert.ok(!('speed' in std.calls[0].init), 'speed must not be sent when the route omits it');
    assert.ok(!('anthropic-beta' in std.calls[0].headers), 'the fast-mode beta header rides only with speed');
});

test('anthropic: heartbeat reports thinking-vs-answer progress during a slow stream', async () => {
    // A stream that thinks, stalls long enough for two beats, then answers.
    const enc = new TextEncoder();
    const frame = (e) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const slowFetch = async () => ({
        ok: true, status: 200, text: async () => '',
        body: (async function* () {
            yield frame({ type: 'message_start', message: { usage: { input_tokens: 5 } } });
            yield frame({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x'.repeat(400) } });
            await sleep(45); // silence: only the heartbeat speaks here
            yield frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '"ok"' } });
            await sleep(25);
            yield frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 101 } });
        })(),
    });
    const lines = [];
    const p = anthropic({ keys: { anthropic_api_key: 'k' }, options: { fetch: slowFetch, heartbeat_ms: 20 } });
    const out = await p.complete('brief', 'P', {}, { model: 'claude-opus-5', log: (m) => lines.push(m) });
    assert.equal(out.text, '"ok"');
    assert.ok(lines.length >= 1, 'expected at least one heartbeat line');
    assert.match(lines[0], /still streaming after \d+s — ~100 tokens received \(all of it thinking so far\)/);
    // Without a log sink there is no heartbeat and nothing leaks to the console.
    const silent = anthropic({ keys: { anthropic_api_key: 'k' }, options: { fetch: slowFetch, heartbeat_ms: 20 } });
    assert.equal((await silent.complete('brief', 'P', {}, { model: 'claude-opus-5' })).text, '"ok"');
});

test('anthropic: truncation and refusal fail loudly, naming the fix', async () => {
    // Truncation carries its own code so the owning stage can let the artifact die
    // with diagnostics instead of propagating and ending the run.
    const trunc = sseStub(sseOk('{"partial":', { stop_reason: 'max_tokens' }));
    const p1 = anthropic({ keys: { anthropic_api_key: 'k' }, options: { fetch: trunc.fetch } });
    await assert.rejects(
        p1.complete('tree', 'P', {}, { model: 'claude-opus-5' }),
        (e) => e.code === 'output_truncated' && /max_tokens/.test(e.message) && e.extra.issues.length === 1,
    );

    const refused = sseStub(sseOk('', { stop_reason: 'refusal' }));
    const p2 = anthropic({ keys: { anthropic_api_key: 'k' }, options: { fetch: refused.fetch } });
    await assert.rejects(
        p2.complete('tree', 'P', {}, { model: 'claude-opus-5' }),
        (e) => e.code === 'provider_error' && /refused/.test(e.message),
    );
});

test('openai + cerebras: chat-completions shape', async () => {
    for (const [make, host, key] of [[openai, 'api.openai.com', 'openai_api_key'], [cerebras, 'api.cerebras.ai', 'cerebras_api_key'], [gemini, 'generativelanguage.googleapis.com', 'gemini_api_key']]) {
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
