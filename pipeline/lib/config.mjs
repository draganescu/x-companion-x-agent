import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineError } from './errors.mjs';

// The 7 text task types. The 'image' task is routed by the existing Gemini
// client via .x-agent.json (gemini_api_key / image_model), not by this config.
//
// 'tokens' is gone: it is subsumed by 'kit', because a token system decided apart
// from the concept that motivates it is the failure the kit stage exists to fix.
export const TASK_TYPES = ['brief', 'kit', 'molecule', 'tree', 'block', 'schema', 'repair'];

// Reasoning depth, for providers that expose it. Optional everywhere: a task that
// omits it takes the provider's own default.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));

export function loadPipelineConfig(configPath) {
    let raw;
    try {
        raw = readFileSync(configPath, 'utf8');
    } catch {
        throw new PipelineError('preflight_failed', `pipeline config not found at ${configPath}`,
            'Copy pipeline/config.example.json to pipeline.config.json and route the tasks.');
    }
    let cfg;
    try {
        cfg = JSON.parse(raw);
    } catch (e) {
        throw new PipelineError('preflight_failed', `pipeline config at ${configPath} is not valid JSON: ${e.message}`);
    }
    if (!cfg.tasks || typeof cfg.tasks !== 'object') {
        throw new PipelineError('preflight_failed', `pipeline config at ${configPath} has no "tasks" object`);
    }
    for (const task of TASK_TYPES) {
        const entry = cfg.tasks[task];
        if (!entry) {
            throw new PipelineError('preflight_failed', `pipeline config is missing the "${task}" task entry`,
                'Every task type needs {provider, model} before the run starts, not mid-run.');
        }
        for (const field of ['provider', 'model']) {
            if (typeof entry[field] !== 'string' || entry[field].length === 0) {
                throw new PipelineError('preflight_failed', `task "${task}" is missing "${field}"`);
            }
        }
        if (entry.temperature !== undefined && typeof entry.temperature !== 'number') {
            throw new PipelineError('preflight_failed', `task "${task}" temperature must be a number`);
        }
        if (entry.max_tokens !== undefined && (!Number.isInteger(entry.max_tokens) || entry.max_tokens <= 0)) {
            throw new PipelineError('preflight_failed', `task "${task}" max_tokens must be a positive integer`);
        }
        if (entry.effort !== undefined && !EFFORT_LEVELS.includes(entry.effort)) {
            throw new PipelineError('preflight_failed',
                `task "${task}" effort must be one of ${EFFORT_LEVELS.join(', ')}`);
        }
    }
    return {
        tasks: cfg.tasks,
        concurrency: cfg.concurrency ?? 3,
        budget_hard_cap: cfg.budget_hard_cap ?? Infinity,
        prompts_dir: cfg.prompts_dir ?? DEFAULT_PROMPTS_DIR,
    };
}

const KEY_FIELDS = [
    ['cerebras_api_key', 'CEREBRAS_API_KEY'],
    ['anthropic_api_key', 'ANTHROPIC_API_KEY'],
    ['openai_api_key', 'OPENAI_API_KEY'],
    ['gemini_api_key', 'GEMINI_API_KEY'],
];

// The toolchain's own resolveConfig does not surface these keys, so the
// pipeline reads the same .x-agent.json file itself (companion gains no surface).
export function readProviderKeys(cwd, env = process.env) {
    let file = {};
    try {
        file = JSON.parse(readFileSync(join(cwd, '.x-agent.json'), 'utf8'));
    } catch {
        // no config file is fine — env may carry the keys
    }
    const keys = {};
    for (const [field, envName] of KEY_FIELDS) {
        const v = file[field] ?? env[envName];
        if (typeof v === 'string' && v.length > 0) keys[field] = v;
    }
    return keys;
}
