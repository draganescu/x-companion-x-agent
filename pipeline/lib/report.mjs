// report.md: budget predicted vs spent, per-artifact gate outcomes, dead
// artifacts with diagnostics, the ledger. S9's task fills in the artifact and
// dead sections; failures always land here — the run never dies silently.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PREDICTED = { brief: () => 1, kit: () => 1, molecule: (b) => b.M ?? 0, tree: (b) => b.S, block: (b) => b.B, schema: (b) => b.P, image: (b) => b.I, repair: () => 0 };

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
        lines.push(`Ceiling **${b.ceiling}** (base ${b.base}: 1 brief + 1 kit + M=${b.M ?? 0} + S=${b.S} + B=${b.B} + P=${b.P}; 2x + I=${b.I}). Spent **${budget.spent}**.`, '');
        lines.push('', 'The ceiling is fixed after the design kit, not after the brief: S, B and P come from the brief, M comes from the kit.', '');
        lines.push('| task | predicted | actual |', '|---|---|---|');
        const byTask = {};
        for (const e of ledger.entries) byTask[e.task_type] = (byTask[e.task_type] ?? 0) + 1;
        for (const [task, predict] of Object.entries(PREDICTED)) {
            lines.push(`| ${task} | ${predict(b)} | ${byTask[task] ?? 0} |`);
        }
    } else if (state.budget_plan) {
        const p = state.budget_plan;
        lines.push(`No ceiling fixed — the run died before the design kit. The brief planned S=${p.S}, B=${p.B}, P=${p.P}, I=${p.I}. Spent ${budget.spent}.`);
    } else {
        lines.push(`No budget fixed (run died before S1 completed). Spent ${budget.spent}.`);
    }
    lines.push('');

    const conf = state.design_conformance;
    if (conf) {
        lines.push('## Design conformance', '');
        lines.push(`The finished page measured against \`kit.json\`: **${conf.within_tolerance} of ${conf.regions}** planned region(s) within tolerance.`, '');
        lines.push('A synthesized kit is inference, not measurement, so this is diffed at region granularity with widened tolerances and never fails the run. Every drift below is attributable: a kit decision, a mapping approximation, or a gap in the available blocks.', '');
        if (conf.drift.length === 0) {
            lines.push('No region drifted.', '');
        } else {
            lines.push('| region | role | from molecule | kind | expected | actual | delta |', '|---|---|---|---|---|---|---|');
            for (const d of conf.drift) {
                const fmt = (v) => (v === null || v === undefined ? '—' : `\`${JSON.stringify(v)}\``);
                lines.push(`| ${d.region_id} | ${d.role ?? '—'} | ${d.molecule ?? '—'} | ${d.kind} | ${fmt(d.expected)} | ${fmt(d.actual)} | ${fmt(d.delta)} |`);
            }
            lines.push('');
        }
    }

    const arts = state.artifacts ?? {};
    const rows = [];
    for (const kind of ['molecules', 'trees', 'blocks', 'packages']) {
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
