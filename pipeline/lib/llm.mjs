// The one lane every generative call goes through: budget check -> render ->
// provider -> JSON extraction -> contract validation -> at most ONE metered
// schema-retry -> a ledger entry per attempt. No free-text output anywhere.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from './errors.mjs';
import { canonicalJson, sha256 } from './hash.mjs';
import { loadTemplate, renderPrompt } from './prompts.mjs';
import { fmtDur } from './clock.mjs';

// wpforge-style defensive parse, minus the LLM-repair fallback — our repair
// lane is the metered schema-retry, never a hidden extra call.
export function extractJson(text) {
    let t = String(text).trim();
    const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
    if (fence) t = fence[1].trim();
    try {
        return JSON.parse(t);
    } catch {
        const first = Math.min(...['{', '['].map((c) => (t.indexOf(c) === -1 ? Infinity : t.indexOf(c))));
        const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
        if (first === Infinity || last <= first) throw new SyntaxError('no JSON found in output');
        return JSON.parse(t.slice(first, last + 1));
    }
}

export function createLlm({ providers, promptsDir, budget, ledger, log }) {
    const templates = new Map();
    const template = (taskType) => {
        if (!templates.has(taskType)) templates.set(taskType, loadTemplate(promptsDir, taskType));
        return templates.get(taskType);
    };

    async function generate({ task_type, label, payload, validate, maxAttempts = 2 }) {
        const route = providers.get(task_type);
        if (!route) {
            throw new PipelineError('preflight_failed', `no provider routed for task "${task_type}"`);
        }
        const basePrompt = renderPrompt(template(task_type), payload);
        const payloadHash = sha256(canonicalJson(payload));
        let prompt = basePrompt;
        let lastIssues = [];

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            budget.spend(task_type, label);
            // The spend counter doubles as live progress: "call 12/60" says how
            // far through the fixed bill the run is while a slow model thinks.
            const callNo = `call ${budget.spent}${budget.ceiling ? `/${budget.ceiling}` : ''}`;
            log?.(`${callNo} · ${task_type} ${label} → ${route.provider.id}/${route.model}${attempt > 1 ? ' (schema retry)' : ''}`);
            const startedAt = Date.now();
            const { text, usage } = await route.provider.complete(task_type, prompt, payload, {
                model: route.model,
                ...(route.temperature !== undefined ? { temperature: route.temperature } : {}),
                ...(route.effort !== undefined ? { effort: route.effort } : {}),
                ...(route.max_tokens !== undefined ? { max_tokens: route.max_tokens } : {}),
                ...(route.speed !== undefined ? { speed: route.speed } : {}),
                label,
                // Providers with long silent calls heartbeat through this; the
                // prefix keeps their lines attributable under concurrency.
                ...(log ? { log: (m) => log(`${callNo} · ${task_type} ${label} ${m}`) } : {}),
            });
            const ms = Date.now() - startedAt;
            let value;
            let outcome = 'ok';
            try {
                value = extractJson(text);
            } catch (e) {
                outcome = 'invalid_json';
                lastIssues = [{ path: '', message: `output is not valid JSON: ${e.message}` }];
            }
            if (outcome === 'ok') {
                const issues = validate(value);
                if (issues.length > 0) {
                    outcome = 'schema_failed';
                    lastIssues = issues;
                }
            }
            ledger.record({
                task_type, label,
                provider: route.provider.id, model: route.model,
                prompt_hash: sha256(prompt), payload_hash: payloadHash,
                usage, attempt, outcome, started_at: startedAt, ms,
            });
            if (outcome === 'ok') {
                log?.(`${callNo} · ${task_type} ${label} ✓ in ${fmtDur(ms)}${attempt > 1 ? ' (retry succeeded)' : ''}`);
                capture(task_type, label, text, usage);
                return { value, attempts: attempt };
            }
            log?.(`${callNo} · ${task_type} ${label} came back ${outcome === 'invalid_json' ? 'as non-JSON' : 'off-contract'} after ${fmtDur(ms)}: ${lastIssues.slice(0, 3).map((i) => `${i.path} ${i.message}`).join(' | ')}`);
            prompt = `${basePrompt}\n\nCONTRACT FAILURE — your previous output did not satisfy the contract:\n${lastIssues.map((i) => `${i.path}: ${i.message}`).join('\n')}\nReturn ONLY corrected JSON.`;
        }
        throw new PipelineError('contract_failed',
            `task ${task_type}:${label} failed its contract after ${maxAttempts} attempt(s)`,
            'The artifact is dead unless S7 repairs it; diagnostics are attached.',
            { task_type, label, issues: lastIssues });
    }

    // Fixture capture for the fake provider (M6): env-gated, no behavior change otherwise.
    function capture(taskType, label, text, usage) {
        if (!process.env.X_PIPELINE_CAPTURE) return;
        const dir = process.env.X_PIPELINE_CAPTURE_DIR
            ?? join(promptsDir, '..', 'fixtures', 'fake');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${taskType}.${String(label).replaceAll('/', '-')}.json`);
        writeFileSync(file, `${JSON.stringify({ text, usage }, null, 2)}\n`);
    }

    return { generate };
}
