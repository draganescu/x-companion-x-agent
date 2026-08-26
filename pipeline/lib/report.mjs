// report.md: budget predicted vs spent, per-artifact gate outcomes, dead
// artifacts with diagnostics, the ledger. S9's task fills in the artifact and
// dead sections; failures always land here — the run never dies silently.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PREDICTED = { brief: () => 1, tokens: () => 1, tree: (b) => b.S, block: (b) => b.B, schema: (b) => b.P, image: (b) => b.I, repair: () => 0 };

export function writeReport(runDir, { state, budget, ledger }) {
    const lines = ['# x-pipeline run report', ''];

    lines.push('## Outcome', '');
    if (state.failure) {
        lines.push(`**FAILED** — \`${state.failure.code}\`: ${state.failure.message}`);
        if (state.failure.hint) lines.push(`Hint: ${state.failure.hint}`);
    } else {
        lines.push(`Completed stages: ${state.completed.join(' → ') || '(none)'}`);
    }
    lines.push('');

    lines.push('## Budget — predicted vs spent', '');
    if (state.budget) {
        const b = state.budget;
        lines.push(`Ceiling **${b.ceiling}** (base ${b.base}: 1 brief + 1 tokens + S=${b.S} + B=${b.B} + P=${b.P}; 2x + I=${b.I}). Spent **${budget.spent}**.`, '');
        lines.push('| task | predicted | actual |', '|---|---|---|');
        const byTask = {};
        for (const e of ledger.entries) byTask[e.task_type] = (byTask[e.task_type] ?? 0) + 1;
        for (const [task, predict] of Object.entries(PREDICTED)) {
            lines.push(`| ${task} | ${predict(b)} | ${byTask[task] ?? 0} |`);
        }
    } else {
        lines.push(`No budget fixed (run died before S1 completed). Spent ${budget.spent}.`);
    }
    lines.push('');

    const arts = state.artifacts ?? {};
    const rows = [];
    for (const kind of ['trees', 'blocks', 'packages']) {
        for (const [key, a] of Object.entries(arts[kind] ?? {})) rows.push([kind, key, a.status]);
    }
    if (rows.length > 0) {
        lines.push('## Artifacts', '', '| kind | artifact | gate |', '|---|---|---|');
        for (const [kind, key, status] of rows) lines.push(`| ${kind} | ${key} | ${status} |`);
        lines.push('');
    }

    const dead = state.dead ?? [];
    if (dead.length > 0) {
        lines.push('## Dead artifacts', '');
        for (const d of dead) {
            lines.push(`### ${d.kind}/${d.key}`, '', '```json', JSON.stringify(d.diagnostics, null, 2), '```', '');
        }
    } else if (state.completed?.includes('S9_verify')) {
        lines.push('## Dead artifacts', '', 'None.', '');
    }

    lines.push('## Ledger', '');
    if (ledger.entries.length > 0) {
        lines.push('| task | label | provider | model | attempt | outcome | tokens in/out |', '|---|---|---|---|---|---|---|');
        for (const e of [...ledger.entries].sort((a, z) => a.task_type.localeCompare(z.task_type) || a.label.localeCompare(z.label) || a.attempt - z.attempt)) {
            lines.push(`| ${e.task_type} | ${e.label} | ${e.provider} | ${e.model} | ${e.attempt} | ${e.outcome} | ${e.usage?.input_tokens ?? 0}/${e.usage?.output_tokens ?? 0} |`);
        }
    } else {
        lines.push('No calls.');
    }
    lines.push('');

    writeFileSync(join(runDir, 'report.md'), lines.join('\n'));
}
