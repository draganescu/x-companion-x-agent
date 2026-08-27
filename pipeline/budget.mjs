// The bill is a function of the brief: base = 1 (brief) + 1 (tokens) + F (furniture) + S + B + P;
// ceiling = 2*base + I. The 2x covers one schema-retry OR one repair per artifact,
// whichever fires. Consulted BEFORE every generative call; a breach is a thrown
// structured error, never a warning (spec operating rule 5).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from './lib/errors.mjs';

/** A section's image intents, normalized: image_intent may be one string or an array. */
export function sectionImageIntents(section) {
    const v = section.image_intent;
    if (Array.isArray(v)) return v;
    return v ? [v] : [];
}

export function computeBudget(brief) {
    const S = brief.pages.reduce((n, p) => n + p.sections.length, 0);
    const B = brief.custom_blocks.length;
    const P = brief.schema_packages.length;
    // I = C + U (x-surfaces): C content intents as always, one call per slot;
    // U unique surface dictionary assets, one call per asset however many
    // bands it lands on. Applications are free; only births are metered.
    const C = brief.pages.reduce((n, p) => n + p.sections.reduce((m, s) => m + sectionImageIntents(s).length, 0), 0);
    const U = new Set((brief.surfaces ?? []).map((s) => s.id)).size;
    const I = C + U;
    // F: the site furniture — header and footer template parts, one tree call
    // each through the same lane as the sections. They bookend every page.
    const F = 2;
    const base = 1 + 1 + F + S + B + P;
    return { S, B, P, C, U, I, F, base, ceiling: 2 * base + I };
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

    // A resumed run is the SAME bill, continued. The meter lives in memory, so
    // without this a resume restarts at zero: the ceiling stops binding and the
    // report claims a spend of 0 against a ledger holding every real call.
    rehydrate(calls) {
        for (const c of calls) {
            this.#spent += 1;
            this.#calls.push({ task_type: c.task_type, label: c.label });
        }
    }

    get spent() { return this.#spent; }
    get ceiling() { return this.#ceiling; }
    get calls() { return [...this.#calls]; }
}

export class Ledger {
    // ledger.jsonl is append-only across resumes, so the file — not this
    // process — is the record of what the run has spent. Read it back in, or
    // every derived number (report totals, per-task actuals) counts only the
    // calls this process happened to make.
    constructor(runDir) {
        this.runDir = runDir;
        this.entries = [];
        try {
            this.entries = readFileSync(join(runDir, 'ledger.jsonl'), 'utf8')
                .split('\n').filter((l) => l.trim().length > 0)
                .map((l) => JSON.parse(l));
        } catch {
            // no prior ledger — a fresh run
        }
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
