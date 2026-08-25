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
    // S, B and P are fixed here; M is not knowable until the design kit exists, so
    // the CEILING is set in S3_kit. Until then the meter allows exactly the two
    // calls that precede it (brief, kit) plus their one retry each.
    const plan = computeBudget(brief);
    ctx.state.budget_plan = { S: plan.S, B: plan.B, P: plan.P, I: plan.I };
    ctx.log(`the plan is ${plan.S} section(s), ${plan.B} custom block(s), ${plan.P} data package(s), ${plan.I} image(s) — the call ceiling is fixed once the design kit says how many arrangements it needs`);
}
