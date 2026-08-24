import { PipelineError } from '../lib/errors.mjs';
import { TASK_TYPES } from '../lib/config.mjs';

const KEY_FOR = { anthropic: 'anthropic_api_key', openai: 'openai_api_key', cerebras: 'cerebras_api_key', gemini: 'gemini_api_key' };

// Routing is config, never code: task_type -> {provider instance, model, temperature}.
export async function createProviders({ config, keys }) {
    const routed = new Map();
    const instances = new Map();
    for (const task of TASK_TYPES) {
        const entry = config.tasks[task];
        if (!entry) continue; // loadPipelineConfig already enforces completeness for full runs
        const { provider: id, model, temperature, options } = entry;
        if (!instances.has(id)) {
            const keyName = KEY_FOR[id];
            if (keyName && !keys[keyName]) {
                throw new PipelineError('preflight_failed',
                    `task "${task}" routes to provider "${id}" but ${keyName} is not in .x-agent.json (or env)`);
            }
            let mod;
            try {
                mod = await import(`./${id}.mjs`);
            } catch (e) {
                throw new PipelineError('preflight_failed',
                    `task "${task}" routes to provider "${id}" but pipeline/providers/${id}.mjs does not load: ${e.message}`);
            }
            instances.set(id, mod.create({ keys, options }));
        }
        routed.set(task, { provider: instances.get(id), model, temperature });
    }
    return routed;
}
