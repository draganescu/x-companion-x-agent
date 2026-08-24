// Dumb pipe to Gemini's OpenAI-compatible chat-completions endpoint. The text
// sibling of the image client (images/gemini.ts) — same key, no SDK.
import { createChatCompletions } from './openai.mjs';

export function create({ keys, options = {} } = {}) {
    return createChatCompletions({
        id: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: keys.gemini_api_key,
        options,
        path: '/chat/completions',
    });
}
