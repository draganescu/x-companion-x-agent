// Transport-level retry shared by the real providers — mirrors the Gemini image
// client's discipline (3 attempts, linear backoff). Transport retries are NOT
// new budget calls (spec call_budget.formula note).
import { PipelineError } from '../lib/errors.mjs';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export async function requestJson(fetchImpl, url, init, { attempts = 3, backoff_ms = 1500 } = {}) {
    let lastFailure = '';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let res;
        try {
            res = await fetchImpl(url, init);
        } catch (e) {
            lastFailure = `network: ${e.message}`;
            if (attempt < attempts) {
                await new Promise((r) => setTimeout(r, backoff_ms * attempt));
                continue;
            }
            break;
        }
        if (res.ok) return res.json();
        const body = await res.text();
        lastFailure = `${res.status}: ${body.slice(0, 300)}`;
        if (!RETRYABLE.has(res.status) || attempt === attempts) {
            throw new PipelineError('provider_error', `${url} -> ${lastFailure}`,
                'Non-transport provider failures are not retried; check the model id and the request.');
        }
        await new Promise((r) => setTimeout(r, backoff_ms * attempt));
    }
    throw new PipelineError('provider_error', `${url} failed after ${attempts} transport attempts (${lastFailure})`);
}
