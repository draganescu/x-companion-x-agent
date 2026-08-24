// Dumb pipe to the OpenAI chat-completions API.
import { requestJson } from './_transport.mjs';

export function createChatCompletions({ id, baseUrl, apiKey, options = {}, path = '/v1/chat/completions' }) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    return {
        id,
        async complete(_taskType, prompt, _payload, { model, temperature }) {
            const body = {
                model,
                messages: [{ role: 'user', content: prompt }],
                ...(temperature !== undefined ? { temperature } : {}),
            };
            const data = await requestJson(fetchImpl, `${baseUrl}${path}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
            }, options);
            return {
                text: data.choices?.[0]?.message?.content ?? '',
                usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
            };
        },
    };
}

export function create({ keys, options = {} } = {}) {
    return createChatCompletions({ id: 'openai', baseUrl: 'https://api.openai.com', apiKey: keys.openai_api_key, options });
}
