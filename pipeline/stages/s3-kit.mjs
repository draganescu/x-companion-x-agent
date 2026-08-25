// S3 — the master designer. ONE call decides everything about how the site
// looks: the token system, the page rhythm, and the inventory of reusable
// arrangements every later call instantiates. Nothing below this stage designs.
//
// It replaces S3_tokens rather than sitting beside it: a token system decided
// apart from the concept that motivates it is the failure this stage exists to
// fix, so the two calls became one.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { deriveThemeSpacing, deriveThemeLayout, tokenChecks } from '../lib/tokens.mjs';
import { kitChecks, tokensFromKit, kitId, moleculesSchema } from '../lib/kit.mjs';
import { computeBudget } from '../budget.mjs';

const specContract = JSON.parse(readFileSync(new URL('../../contract/schemas/design-spec.schema.json', import.meta.url), 'utf8'));

export const id = 'S3_kit';
export const kind = 'generative';

// wp_spec_validate warnings the pipeline promotes to failures. A synthesized
// kit is inference; an unlogged value or an unstated breakpoint is not an
// honest snap, it is a decision nobody made.
const WARNING_FAILS = new Set(['W_UNQUANTIZED', 'W_NO_RESPONSIVE']);

export async function run(ctx) {
    const brief = ctx.state.brief;
    const themeTokens = ctx.state.instance.theme_tokens;
    const theme_spacing = deriveThemeSpacing(themeTokens);
    const theme_layout = deriveThemeLayout(themeTokens);
    const sectionRoles = brief.pages.flatMap((p) => p.sections.map((s) => s.role));

    const payload = {
        identity: brief.identity,
        art_direction: brief.art_direction,
        palette: brief.palette,
        page_plan: brief.pages.map((p) => ({
            slug: p.slug,
            sections: p.sections.map((s) => ({ id: s.id, role: s.role, band: s.design?.band ?? 'base', layout: s.design?.layout ?? 'centered', copy_notes: s.copy_notes })),
        })),
        section_roles: [...new Set(sectionRoles)],
        theme_spacing,
        theme_layout,
        available_blocks: ctx.state.instance.block_names ?? [],
        spec_contract: specContract,
        molecules_contract: moleculesSchema,
    };

    const { value: kit } = await ctx.llm.generate({
        task_type: 'kit',
        label: 'kit',
        payload,
        validate: (v) => {
            const issues = kitChecks(v, { briefPalette: brief.palette, sectionRoles });
            if (issues.length > 0) return issues;
            return tokenChecks(tokensFromKit(v.spec), { theme_spacing, theme_layout, briefPalette: brief.palette })
                .map((i) => ({ ...i, path: `/spec/tokens_candidates${i.path}` }));
        },
    });

    const spec = kit.spec;
    const molecules = kit.molecules;
    writeFileSync(join(ctx.runDir, 'kit.json'), JSON.stringify(spec, null, 2));
    writeFileSync(join(ctx.runDir, 'molecules.json'), JSON.stringify({ molecules }, null, 2));

    // Gate 1 — the toolchain's own spec gate, unmodified. This is the same call
    // from-design mode makes on a lifted spec; that it now also runs on an
    // invented one is the whole point of the stage.
    const specGate = await ctx.call('wp_spec_validate', spec);
    if (!specGate.ok) {
        throw new PipelineError(specGate.data.code ?? 'companion_error',
            `wp_spec_validate errored: ${specGate.data.message}`, specGate.data.hint ?? '');
    }
    const specFailures = (specGate.data.diagnostics ?? [])
        .filter((d) => d.severity === 'error' || WARNING_FAILS.has(d.code));
    if (specFailures.length > 0) {
        throw new PipelineError('gate_failed',
            `the design kit failed wp_spec_validate: ${specFailures.map((d) => `${d.code} ${d.path ?? ''} ${d.message}`).join(' | ')}`,
            'The kit is the artifact everything else is measured against; it is never shipped unvalidated.',
            { diagnostics: specGate.data.diagnostics });
    }

    // The bill is knowable NOW and not before: S, B and P come from the brief,
    // M comes from the kit. The ceiling is hard from here on.
    const budget = computeBudget(brief, { M: molecules.length });
    ctx.budget.setCeiling(budget.ceiling);
    ctx.state.budget = budget;
    ctx.state.kit = { kit_id: kitId(brief), molecules: molecules.map((m) => ({ id: m.id, role: m.role })) };
    ctx.log(`this build costs at most ${budget.ceiling} calls (M=${budget.M}, S=${budget.S}, B=${budget.B}, P=${budget.P}, I=${budget.I})`);

    // Gate 2 — the tokens gate that shipped in M2, unchanged. tokens_candidates
    // IS a DesignTokens document: the spec contract $refs the same four
    // properties, so nothing here had to be re-proven.
    const tokens = tokensFromKit(spec);
    const dry = await ctx.call('wp_tokens_apply', { ...tokens, dry_run: true });
    if (!dry.ok) {
        throw new PipelineError(dry.data.code ?? 'companion_error',
            `wp_tokens_apply dry_run refused the kit's token set: ${dry.data.message}`, dry.data.hint ?? '', { envelope: dry.data });
    }
    const passThroughDrift = (dry.data.diff_against_instance ?? [])
        .filter((d) => (d.group === 'spacing.spacingSizes' || d.group === 'layout') && d.kind === 'value_differs');
    if (passThroughDrift.length > 0) {
        throw new PipelineError('gate_failed',
            'R9 violation surfaced by the dry-run diff: theme spacing/layout moved',
            'The theme\'s own spacing and layout pass through verbatim; nothing may redesign them.',
            { diffs: passThroughDrift });
    }
    const previewText = JSON.stringify(dry.data.theme_json_preview ?? {}).toLowerCase();
    const missing = brief.palette.filter((p) => !previewText.includes(p.color.toLowerCase()));
    if (missing.length > 0) {
        throw new PipelineError('gate_failed',
            `brief palette entr${missing.length === 1 ? 'y' : 'ies'} missing from the compiled preview: ${missing.map((m) => `${m.name} ${m.color}`).join(', ')}`,
            '', { missing });
    }
    writeFileSync(join(ctx.runDir, 'tokens-dry-run.json'),
        JSON.stringify({ preview: dry.data.theme_json_preview, diff: dry.data.diff_against_instance }, null, 2));

    const applied = await ctx.call('wp_tokens_apply', { ...tokens });
    if (!applied.ok) {
        throw new PipelineError(applied.data.code ?? 'companion_error',
            `wp_tokens_apply failed: ${applied.data.message}`, applied.data.hint ?? '', { envelope: applied.data });
    }
    writeFileSync(join(ctx.runDir, 'tokens.json'), JSON.stringify(tokens, null, 2));
    ctx.state.fingerprint = applied.data.fingerprint;
    ctx.state.instance.fingerprint = applied.data.fingerprint;
    writeFileSync(join(ctx.runDir, 'instance.json'), JSON.stringify(ctx.state.instance, null, 2));
    ctx.log(`design kit accepted — ${tokens.palette.length} colours, ${tokens.typography.families.length} font families, ${spec.regions.length} page region(s), ${molecules.length} reusable arrangement(s); tokens applied and the site fingerprint moved to ${String(applied.data.fingerprint).slice(0, 8)}…`);
}
