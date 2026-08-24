import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from './errors.mjs';

// Templates declare their required payload fields in frontmatter (spec file_layout).
// Frontmatter is YAML-lite on purpose: `key: value` lines plus one bracketed list.
export function loadTemplate(promptsDir, taskType) {
    const file = join(promptsDir, `${taskType}.md`);
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        throw new PipelineError('preflight_failed', `no prompt template for task "${taskType}" at ${file}`);
    }
    const lines = raw.split('\n');
    if (lines[0]?.trim() !== '---') {
        throw new PipelineError('preflight_failed', `template ${file} has no frontmatter (must start with ---)`);
    }
    const close = lines.indexOf('---', 1);
    if (close === -1) {
        throw new PipelineError('preflight_failed', `template ${file} frontmatter never closes`);
    }
    const meta = {};
    for (const line of lines.slice(1, close)) {
        const m = line.match(/^([a-z_]+):\s*(.*)$/);
        if (m) meta[m[1]] = m[2].trim();
    }
    if (meta.task_type !== taskType) {
        throw new PipelineError('preflight_failed',
            `template ${file} declares task_type "${meta.task_type}", expected "${taskType}"`);
    }
    const listMatch = (meta.required ?? '').match(/^\[(.*)\]$/);
    if (!listMatch) {
        throw new PipelineError('preflight_failed', `template ${file} must declare required: [field, ...]`);
    }
    const required = listMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
    return { task_type: taskType, required, body: lines.slice(close + 1).join('\n') };
}

export function renderPrompt(template, payload) {
    for (const field of template.required) {
        if (!(field in payload)) {
            throw new PipelineError('prompt_payload_missing',
                `template "${template.task_type}" requires payload field "${field}"`);
        }
    }
    return template.body.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
        if (!(key in payload)) {
            throw new PipelineError('prompt_payload_missing',
                `template "${template.task_type}" references {{${key}}} which is not in the payload`);
        }
        const v = payload[key];
        return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    });
}
