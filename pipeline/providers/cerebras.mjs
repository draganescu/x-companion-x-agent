// Dumb pipe to the Cerebras inference API (OpenAI-compatible chat completions).
import { createChatCompletions } from './openai.mjs';

export function create({ keys, options = {} } = {}) {
    return createChatCompletions({ id: 'cerebras', baseUrl: 'https://api.cerebras.ai', apiKey: keys.cerebras_api_key, options });
}
