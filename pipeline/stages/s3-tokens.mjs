import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { deriveThemeSpacing, deriveThemeLayout, tokenChecks } from '../lib/tokens.mjs';

const contract = JSON.parse(readFileSync(new URL('../../contract/schemas/design-tokens.schema.json', import.meta.url), 'utf8'));

export const id = 'S3_tokens';
export const kind = 'generative';

export async function run(ctx) {
    const brief = ctx.state.brief;
    const themeTokens = ctx.state.instance.theme_tokens;
    const theme_spacing = deriveThemeSpacing(themeTokens);
    const theme_layout = deriveThemeLayout(themeTokens);

    const payload = {
        identity: brief.identity,
        art_direction: brief.art_direction,
        palette: brief.palette,
        theme_spacing,
        theme_layout,
        contract_note: { note: 'Your output must validate against this JSON Schema (design-tokens.schema.json):', schema: contract },
    };
    const { value: raw } = await ctx.llm.generate({
        task_type: 'tokens',
        label: 'tokens',
        payload,
        validate: (v) => tokenChecks(v, { theme_spacing, theme_layout, briefPalette: brief.palette }),
    });
    // wp_tokens_apply's input validation is its own copy of the shape and
    // rejects keys the contract tolerates (a live run died on sizes[].name).
    // Strip to exactly what the tool accepts; tokens.json keeps the strip too —
    // it is the applied record.
    const tokens = {
        ...raw,
        typography: raw.typography ? {
            ...raw.typography,
            sizes: (raw.typography.sizes ?? []).map(({ slug, size, fluid }) => ({
                slug, size, ...(fluid !== undefined ? { fluid } : {}),
            })),
        } : raw.typography,
    };

    // Gate, part 1: the free rehearsal. Deterministic sanity on the compiled diff.
    const dry = await ctx.call('wp_tokens_apply', { ...tokens, dry_run: true });
    if (!dry.ok) {
        throw new PipelineError(dry.data.code ?? 'companion_error',
            `wp_tokens_apply dry_run refused the token set: ${dry.data.message}`, dry.data.hint ?? '', { envelope: dry.data });
    }
    // Only value_differs is drift: our applied value would CHANGE an instance
    // value. missing_on_instance in these groups is index noise — the differ
    // indexes arrays while real instances serve origin-keyed spacingSizes.
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

    // Gate, part 2: the real apply. The epoch moves; every later stage uses the new world.
    const applied = await ctx.call('wp_tokens_apply', { ...tokens });
    if (!applied.ok) {
        throw new PipelineError(applied.data.code ?? 'companion_error',
            `wp_tokens_apply failed: ${applied.data.message}`, applied.data.hint ?? '', { envelope: applied.data });
    }
    writeFileSync(join(ctx.runDir, 'tokens.json'), JSON.stringify(tokens, null, 2));
    ctx.state.fingerprint = applied.data.fingerprint;
    ctx.state.instance.fingerprint = applied.data.fingerprint;
    writeFileSync(join(ctx.runDir, 'instance.json'), JSON.stringify(ctx.state.instance, null, 2));
    ctx.log(`design tokens applied to the theme — ${tokens.palette.length} colours, ${tokens.typography.families.length} font families; the site fingerprint moved to ${String(applied.data.fingerprint).slice(0, 8)}…`);
}
