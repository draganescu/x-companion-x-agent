import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSchema } from '../lib/schema.mjs';
import { computeBudget } from '../budget.mjs';
import { crossChecks } from '../lib/brief-checks.mjs';

const schema = JSON.parse(readFileSync(new URL('../schemas/brief.schema.json', import.meta.url), 'utf8'));

export const id = 'S1_brief';
export const kind = 'generative';


export async function run(ctx) {
    const { value: brief } = await ctx.llm.generate({
        task_type: 'brief',
        label: 'brief',
        payload: { prompt: ctx.prompt, contract: schema },
        validate: (v) => [...validateSchema(schema, v), ...crossChecks(v)],
    });
    writeFileSync(join(ctx.runDir, 'brief.json'), JSON.stringify(brief, null, 2));
    ctx.state.brief = brief;
    const budget = computeBudget(brief);
    ctx.budget.setCeiling(budget.ceiling); // throws budget_exceeded if > hard cap — before call #2
    ctx.state.budget = budget;
    ctx.log(`this brief costs at most ${budget.ceiling} calls (S=${budget.S}, B=${budget.B}, P=${budget.P}, I=${budget.I})`);
}
