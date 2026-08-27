import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSchema } from '../lib/schema.mjs';
import { computeBudget } from '../budget.mjs';
import { crossChecks } from '../lib/brief-checks.mjs';
import { loadStyles, matchPinnedStyles, seededShuffle, styleChecks, renderPinNote } from '../lib/styles.mjs';

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
form.

This constrains only WHAT MAY BE BUILT, never how much. Plan the same pages and the
same sections you would plan without this note, at the same design ambition — do not
fold pages away or shrink the plan because the vocabulary is smaller. Content that
would have been a custom block or a data feature becomes a fully designed static
section carrying the same information (a beer list is a designed grid with styles and
prices written in; a schedule is a designed table; a booking is the phone number,
set beautifully).`;

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
    // The style combo: both rosters ride into the one high-effort call, order
    // shuffled deterministically per prompt (a fixed order would let position
    // bias the choice; Math.random() would break same-prompt determinism and
    // resume). User-named styles are detected HERE, in code — set in stone.
    const styles = loadStyles();
    const pins = matchPinnedStyles(ctx.prompt, styles);
    if (pins.artistic || pins.ui || pins.flexible) {
        const named = [pins.artistic, pins.ui, pins.flexible?.artistic].filter(Boolean).join('", "');
        ctx.log(`the request names "${named}" — pinned; the brief chooses only what is missing`);
    }
    // The style seed (--vary / --style-seed): a temperature-less model over a
    // prompt-seeded shuffle picks the SAME combo for the same prompt forever —
    // deterministic by design, conservative by consequence (the pairing that
    // names itself from the subject wins every time). The seed reshuffles the
    // rosters and arms the exploration push; recorded in state.style_seed so
    // a resume replays the same exploration, and ABSENT it every byte below
    // is identical to today — the determinism claim holds unless summoned.
    const styleSeed = ctx.state.style_seed ? `:${ctx.state.style_seed}` : '';
    const explorePush = ctx.state.style_seed
        ? `\nEXPLORATION RUN (style seed ${ctx.state.style_seed}): the pairing that names itself instantly from the subject is the BASELINE TO BEAT, never the answer — name that obvious pairing in your head, discard it, and choose a pairing from elsewhere in the lists that still genuinely serves this site. Surprise chosen FOR the brief reads as taste; the on-the-nose pick reads as a template.`
        : '';
    const { value: brief } = await ctx.llm.generate({
        task_type: 'brief',
        label: 'brief',
        payload: {
            prompt: ctx.prompt,
            contract: schema,
            mode_note: brochure ? BROCHURE_NOTE : '',
            artistic_styles: seededShuffle(styles.artistic.map((e) => e.name), `${ctx.prompt}${styleSeed}:artistic`).join(', '),
            ui_styles: seededShuffle(styles.ui.map((e) => e.name), `${ctx.prompt}${styleSeed}:ui`).join(', '),
            style_pin_note: renderPinNote(pins) + explorePush,
        },
        // NOT passed as a structured-outputs contract: this schema compiles to
        // a grammar the API rejects as too large (field-tested 2026-08-25,
        // req_011CeQ6s…). The generate() contract knob works only for schemas
        // far smaller than the pipeline's real ones.
        validate: (v) => [
            ...validateSchema(schema, v),
            ...crossChecks(v),
            ...styleChecks(v, { styles, pins }),
            ...(brochure ? brochureChecks(v) : []),
        ],
    });
    writeFileSync(join(ctx.runDir, 'brief.json'), JSON.stringify(brief, null, 2));
    ctx.state.brief = brief;
    if (brief.style) ctx.log(`style combo: ${brief.style.artistic} × ${brief.style.ui} — ${brief.style.rationale}`);
    const budget = computeBudget(brief, { bespoke: ctx.state.bespoke === true });
    if (ctx.state.no_images) {
        // --no-images: the placeholder pixels still ship (minted free in S8, each
        // carrying its written imageIntent for a later fill); the metered
        // generation pass is skipped, so its calls leave the bill.
        budget.I = 0;
        budget.ceiling = 2 * budget.base;
    }
    ctx.budget.setCeiling(budget.ceiling); // throws budget_exceeded if > hard cap — before call #2
    ctx.state.budget = budget;
    const modes = [ctx.state.bespoke ? 'bespoke ground' : '', brochure ? 'brochure mode, composition only' : '', ctx.state.no_images ? 'images skipped, placeholders stay' : ''].filter(Boolean).join('; ');
    const terms = `${ctx.state.bespoke ? `T=${budget.T}, ` : ''}S=${budget.S}, B=${budget.B}, P=${budget.P}, I=${budget.I}`;
    ctx.log(`this brief costs at most ${budget.ceiling} calls (${terms})${modes ? ` — ${modes}` : ''}`);
}
