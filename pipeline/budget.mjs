// The bill is a function of the brief: base = 1 (brief) + 1 (tokens) + S + B + P;
// ceiling = 2*base + I. The 2x covers one schema-retry OR one repair per artifact,
// whichever fires. Consulted BEFORE every generative call; a breach is a thrown
// structured error, never a warning (spec operating rule 5).
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from './lib/errors.mjs';

export function computeBudget(brief) {
    const S = brief.pages.reduce((n, p) => n + p.sections.length, 0);
    const B = brief.custom_blocks.length;
    const P = brief.schema_packages.length;
    const I = brief.pages.reduce((n, p) => n + p.sections.filter((s) => s.image_intent).length, 0);
    const base = 1 + 1 + S + B + P;
    return { S, B, P, I, base, ceiling: 2 * base + I };
}

const PRE_CEILING_ALLOWANCE = 2; // S1 + its one schema-retry; nothing else may run before the ceiling exists

export class BudgetMeter {
    #ceiling = null;
    #hardCap;
    #spent = 0;
    #calls = [];

    constructor({ hard_cap = Infinity } = {}) {
        this.#hardCap = hard_cap;
    }

    setCeiling(ceiling) {
        if (ceiling > this.#hardCap) {
            throw new PipelineError('budget_exceeded',
                `this brief costs up to ${ceiling} calls; budget_hard_cap is ${this.#hardCap}`,
                'Raise budget_hard_cap in pipeline.config.json or narrow the prompt.',
                { ceiling, hard_cap: this.#hardCap });
        }
        this.#ceiling = ceiling;
    }

    spend(taskType, label) {
        const limit = this.#ceiling ?? PRE_CEILING_ALLOWANCE;
        if (this.#spent + 1 > limit) {
            throw new PipelineError('budget_exceeded',
                `call ${this.#spent + 1} (${taskType}:${label}) would exceed the ceiling of ${limit}`,
                'The run ends with a report, never with silent extra spending.',
                { spent: this.#spent, ceiling: limit, task_type: taskType, label });
        }
        this.#spent += 1;
        this.#calls.push({ task_type: taskType, label });
    }

    get spent() { return this.#spent; }
    get ceiling() { return this.#ceiling; }
    get calls() { return [...this.#calls]; }
}

export class Ledger {
    constructor(runDir) {
        this.runDir = runDir;
        this.entries = [];
    }

    record(entry) {
        this.entries.push(entry);
        appendFileSync(join(this.runDir, 'ledger.jsonl'), `${JSON.stringify(entry)}\n`);
    }

    flush() {
        const sorted = [...this.entries].sort((a, b) =>
            a.task_type.localeCompare(b.task_type) || a.label.localeCompare(b.label) || a.attempt - b.attempt);
        writeFileSync(join(this.runDir, 'ledger.json'), `${JSON.stringify(sorted, null, 2)}\n`);
        return sorted;
    }
}
