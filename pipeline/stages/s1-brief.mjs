import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSchema } from '../lib/schema.mjs';
import { computeBudget } from '../budget.mjs';
import { crossChecks } from '../lib/brief-checks.mjs';

const schema = JSON.parse(readFileSync(new URL('../schemas/brief.schema.json', import.meta.url), 'utf8'));

export const id = 'S1_brief';
export const kind = 'generative';

// --brochure: composition only. The R7 ladder stops at rung 2 — the argument a
// custom_blocks[] or schema_packages[] entry needs to win is ruled out of scope
// before the model gets to make it, and the gate below holds the model to it.
const BROCHURE_NOTE = `BROCHURE MODE — this build ships composition only. custom_blocks and
schema_packages MUST be empty arrays; there is no argument that wins one here. The R7
ladder stops at rung 2: express every section through composition of existing blocks,
block styles and patterns, and design harder instead of reaching for new vocabulary.
Anything interactive or data-backed (stored forms, tickers, schedules, bookings) is out
of scope — a contact section carries the venue's details and links, not a stored-submission
form.`;

function brochureChecks(brief) {
    const issues = [];
    if ((brief.custom_blocks ?? []).length > 0) {
        issues.push({ path: '/custom_blocks', message: `brochure mode: must be an empty array (declared ${brief.custom_blocks.length}) — compose with existing blocks instead` });
    }
    if ((brief.schema_packages ?? []).length > 0) {
        issues.push({ path: '/schema_packages', message: `brochure mode: must be an empty array (declared ${brief.schema_packages.length}) — data-backed features are out of scope` });
    }
    return issues;
}

export async function run(ctx) {
    const brochure = ctx.state.brochure === true;
    const { value: brief } = await ctx.llm.generate({
        task_type: 'brief',
        label: 'brief',
        payload: { prompt: ctx.prompt, contract: schema, mode_note: brochure ? BROCHURE_NOTE : '' },
        validate: (v) => [
            ...validateSchema(schema, v),
            ...crossChecks(v),
            ...(brochure ? brochureChecks(v) : []),
        ],
    });
    writeFileSync(join(ctx.runDir, 'brief.json'), JSON.stringify(brief, null, 2));
    ctx.state.brief = brief;
    // S, B and P are fixed here; M is not knowable until the design kit exists, so
    // the CEILING is set in S3_kit. Until then the meter allows exactly the two
    // calls that precede it (brief, kit) plus their one retry each.
    const plan = computeBudget(brief);
    ctx.state.budget_plan = { S: plan.S, B: plan.B, P: plan.P, I: plan.I };
    ctx.log(`the plan is ${plan.S} section(s), ${plan.B} custom block(s), ${plan.P} data package(s), ${plan.I} image(s)${brochure ? ' — brochure mode, composition only' : ''} — the call ceiling is fixed once the design kit says how many arrangements it needs`);
}
