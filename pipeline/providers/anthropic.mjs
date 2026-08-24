// Dumb pipe to the Anthropic Messages API. No prompt forks, no model fallback.
import { requestJson } from './_transport.mjs';

export function create({ keys, options = {} } = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    return {
        id: 'anthropic',
        async complete(_taskType, prompt, _payload, { model, temperature }) {
            const body = {
                model,
                max_tokens: 16000,
                messages: [{ role: 'user', content: prompt }],
                ...(temperature !== undefined ? { temperature } : {}),
            };
            const data = await requestJson(fetchImpl, 'https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': keys.anthropic_api_key,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
            }, options);
            return {
                text: (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''),
                usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
            };
        },
    };
}
