// Dumb pipe to the Anthropic Messages API. No prompt forks, no model fallback.
//
// Streamed on purpose: adaptive thinking is ON by default on claude-opus-5, so a
// single call can run for minutes and a buffered request would hit the socket
// timeout before the first byte. max_tokens is a hard cap on thinking AND text.
import { PipelineError } from '../lib/errors.mjs';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);
const DEFAULT_MAX_TOKENS = 32000;
const DEFAULT_HEARTBEAT_MS = 60_000;

export function create({ keys, options = {} } = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const attempts = options.attempts ?? 3;
    const backoffMs = options.backoff_ms ?? 1500;
    const heartbeatMs = options.heartbeat_ms ?? DEFAULT_HEARTBEAT_MS;

    return {
        id: 'anthropic',
        async complete(_taskType, prompt, _payload, { model, temperature, effort, max_tokens, log }) {
            const body = {
                model,
                max_tokens: max_tokens ?? DEFAULT_MAX_TOKENS,
                stream: true,
                messages: [{ role: 'user', content: prompt }],
                // temperature is REMOVED on claude-opus-5 / opus-4.7+ / fable-5 and
                // rejected for non-default values on sonnet-5 — send it only when the
                // route explicitly asks, so those models can simply omit it.
                ...(temperature !== undefined ? { temperature } : {}),
                ...(effort !== undefined ? { output_config: { effort } } : {}),
            };
            const init = {
                method: 'POST',
                headers: {
                    'x-api-key': keys.anthropic_api_key,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
            };

            // Heartbeat: a long effort-high call is minutes of silence otherwise,
            // indistinguishable from a dead stream. Approximate tokens from the
            // delta characters received (thinking + text), ~4 chars per token.
            const started = Date.now();
            const seen = { thinking: 0, text: 0 };
            const beat = log ? setInterval(() => {
                const tok = (n) => `~${Math.round(n / 4)}`;
                const phase = seen.text > 0 ? `${tok(seen.text)} of them the answer` : 'all of it thinking so far';
                log(`still streaming after ${Math.round((Date.now() - started) / 1000)}s — ${tok(seen.thinking + seen.text)} tokens received (${phase})`);
            }, heartbeatMs) : null;
            let text, usage, stop_reason, error;
            try {
                const res = await requestStream(fetchImpl, 'https://api.anthropic.com/v1/messages', init, { attempts, backoffMs });
                ({ text, usage, stop_reason, error } = await readSseMessage(res, (kind, chars) => { seen[kind] += chars; }));
            } finally {
                if (beat) clearInterval(beat);
            }

            if (error) {
                throw new PipelineError('provider_error', `anthropic stream error: ${error}`);
            }
            if (stop_reason === 'refusal') {
                throw new PipelineError('provider_error', `anthropic ${model} refused the request`,
                    'Safety classifiers declined; the prompt content is the thing to change, not the routing.');
            }
            // Truncation is an artifact failure, not an outage: the stage that owns
            // the artifact catches this and lets it die with its diagnostics, the
            // same as a contract failure. It must never cost the whole run.
            if (stop_reason === 'max_tokens') {
                throw new PipelineError('output_truncated',
                    `anthropic ${model} hit max_tokens (${body.max_tokens}) before finishing its JSON`,
                    'max_tokens caps thinking + text together. Raise "max_tokens" or lower "effort" on this task in pipeline.config.json.',
                    { issues: [{ path: '', message: `output truncated at max_tokens=${body.max_tokens}` }] });
            }
            return { text, usage };
        },
    };
}

// Same retry discipline as _transport.requestJson (transport retries are not new
// budget calls), but hands back the live response so the body can be streamed.
async function requestStream(fetchImpl, url, init, { attempts, backoffMs }) {
    let lastFailure = '';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let res;
        try {
            res = await fetchImpl(url, init);
        } catch (e) {
            lastFailure = `network: ${e.message}`;
            if (attempt < attempts) {
                await new Promise((r) => setTimeout(r, backoffMs * attempt));
                continue;
            }
            break;
        }
        if (res.ok) return res;
        const detail = await res.text();
        lastFailure = `${res.status}: ${detail.slice(0, 300)}`;
        if (!RETRYABLE.has(res.status) || attempt === attempts) {
            throw new PipelineError('provider_error', `${url} -> ${lastFailure}`,
                'Non-transport provider failures are not retried; check the model id and the request.');
        }
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
    throw new PipelineError('provider_error', `${url} failed after ${attempts} transport attempts (${lastFailure})`);
}

// Accumulate one Messages API SSE stream into the {text, usage} shape every
// provider returns. Thinking blocks never reach the contract gate — only
// text_delta does — but their size feeds onDelta so the heartbeat can say
// what the model is spending its silence on.
export async function readSseMessage(res, onDelta) {
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let stop_reason = null;
    let error = null;
    const usage = { input_tokens: 0, output_tokens: 0 };

    for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let ev;
            try {
                ev = JSON.parse(raw);
            } catch {
                continue; // a partial frame; the next chunk completes it
            }
            switch (ev.type) {
                case 'message_start':
                    usage.input_tokens = ev.message?.usage?.input_tokens ?? 0;
                    break;
                case 'content_block_delta':
                    if (ev.delta?.type === 'text_delta') {
                        text += ev.delta.text;
                        onDelta?.('text', ev.delta.text.length);
                    } else if (ev.delta?.type === 'thinking_delta') {
                        onDelta?.('thinking', (ev.delta.thinking ?? '').length);
                    }
                    break;
                case 'message_delta':
                    usage.output_tokens = ev.usage?.output_tokens ?? usage.output_tokens;
                    stop_reason = ev.delta?.stop_reason ?? stop_reason;
                    break;
                case 'error':
                    error = ev.error?.message ?? 'unknown stream error';
                    break;
                default:
                    break;
            }
        }
    }
    return { text, usage, stop_reason, error };
}
