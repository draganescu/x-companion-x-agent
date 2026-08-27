import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { deriveThemeSpacing, deriveThemeLayout, tokenChecks } from '../lib/tokens.mjs';
import { renderStyleNote } from '../lib/styles.mjs';
import { createRest, readConnection } from '../lib/rest.mjs';
import { enrichFamilies, installFontFamilies } from '../lib/fonts.mjs';

const contract = JSON.parse(readFileSync(new URL('../../contract/schemas/design-tokens.schema.json', import.meta.url), 'utf8'));

export const id = 'S3_tokens';
export const kind = 'generative';

export async function run(ctx) {
    const brief = ctx.state.brief;
    const themeTokens = ctx.state.instance.theme_tokens;
    const theme_spacing = deriveThemeSpacing(themeTokens);
    const theme_layout = deriveThemeLayout(themeTokens);

    // No core default backs constrained layout: when a theme declares neither
    // contentSize nor wideSize, WordPress omits the max-width from
    // `.is-layout-constrained > *` entirely — "constrained" constrains nothing
    // and every centered section silently runs full width. We pass the theme's
    // own values through verbatim (R9), so assert there is something to pass.
    if (!theme_layout.contentSize || !theme_layout.wideSize) {
        throw new PipelineError('gate_failed',
            `the theme declares no settings.layout.${theme_layout.contentSize ? 'wideSize' : 'contentSize'} — constrained layout would constrain nothing and every "centered" section would silently run full width`,
            'Declare both contentSize and wideSize in the theme\'s theme.json; the pipeline passes them through, it never invents them.',
            { theme_layout });
    }

    const payload = {
        identity: brief.identity,
        art_direction: brief.art_direction,
        // Empty string on a pre-style run dir — resumes stay whole (axis precedent).
        style_note: renderStyleNote(brief.style) && `${renderStyleNote(brief.style)}
The token system is where the combo becomes real: the palette carries the artistic style's color story; the type scale carries its typographic attitude filtered through the UI style's discipline. A token set that could belong to any other combo is not done.`,
        palette: brief.palette,
        theme_spacing,
        theme_layout,
        contract_note: { note: 'Your output must validate against this JSON Schema (design-tokens.schema.json):', schema: contract },
    };
    const { value: raw } = await ctx.llm.generate({
        task_type: 'tokens',
        label: 'tokens',
        payload,
        validate: (v) => tokenChecks(v, { theme_spacing, theme_layout, briefPalette: brief.palette, bespoke: ctx.state.bespoke === true }),
    });
    // wp_tokens_apply's input validation is its own copy of the shape and
    // rejects keys the contract tolerates (a live run died on sizes[].name).
    // Strip to exactly what the tool accepts; tokens.json keeps the strip too —
    // it is the applied record. `source` is the font lane's DOWNLOAD
    // instruction (agent-side only) and gets the same strip; the lane below
    // merges the constructed fontFace back in before the real apply.
    const sourced = (raw.typography?.families ?? []).filter((f) => f.source);
    const tokens = {
        ...raw,
        typography: raw.typography ? {
            ...raw.typography,
            families: (raw.typography.families ?? []).map(({ source: _source, ...keep }) => keep),
            sizes: (raw.typography.sizes ?? []).map(({ slug, size, fluid }) => ({
                slug, size, ...(fluid !== undefined ? { fluid } : {}),
            })),
        } : raw.typography,
    };

    // One deliberate seam reset, stage-authored like the R9 passthrough (never
    // the model's to write). Core injects margin-block-start:
    // var(--wp--style--block-gap) between top-level blocks — header, every
    // section, footer — even when the theme declares no blockGap at all (TT5
    // declares none; the seams measured 19px of page background, core's 1.2rem
    // default). Bands own their vertical rhythm through their own padding, so
    // the seams are pure leakage, reset once here. Rung 5 citation: rungs 1-4
    // cannot reach the space BETWEEN template-level blocks (no block owns it),
    // and zeroing global blockGap instead would collapse rhythm inside every
    // layout site-wide. Inner layouts keep their default gap untouched.
    const SEAM_RESET = '.wp-site-blocks > * + * { margin-block-start: 0; }\n'
        + '.wp-block-post-content > * + * { margin-block-start: 0; }';
    tokens.css = { ...(tokens.css ?? {}), global: [tokens.css?.global, SEAM_RESET].filter(Boolean).join('\n') };

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

    // The Font Library lane (theme-factory s3_fonts): a family with a source
    // is a PROMISE. The agent downloads the faces (hash-pinned cache), installs
    // them through core's own wp/v2/font-families + font-faces REST, and the
    // constructed fontFace entries ride the ONE real apply below into the user
    // global styles — which is what makes wp_print_font_faces serve them
    // (installing alone renders nothing; activation is the tokens write).
    // Never metered, never in the ledger; the report reads state.fonts.
    if (sourced.length > 0) {
        const rest = ctx.rest ?? createRest(readConnection(process.cwd()));
        const { entries, fontFacesBySlug } = await installFontFamilies({
            families: sourced,
            rest,
            cacheDir: join(process.cwd(), 'tools', '.runtime', 'fonts'),
            ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
            log: ctx.log,
        });
        tokens.typography.families = enrichFamilies(raw.typography.families, fontFacesBySlug);
        ctx.state.fonts = entries;
    }

    // Gate, part 2: the real apply. The epoch moves; every later stage uses the new world.
    const applied = await ctx.call('wp_tokens_apply', { ...tokens });
    if (!applied.ok) {
        throw new PipelineError(applied.data.code ?? 'companion_error',
            `wp_tokens_apply failed: ${applied.data.message}`, applied.data.hint ?? '', { envelope: applied.data });
    }
    // The sanitizer never silently drops css; a rejected seam reset means the
    // seams are back on every page — that is a gate failure, not a footnote.
    if ((applied.data.css_rejected ?? []).length > 0) {
        throw new PipelineError('gate_failed',
            `the css sanitizer rejected part of the token css (${applied.data.css_rejected.join(' | ')}) — the seam reset must land whole`,
            '', { css_rejected: applied.data.css_rejected });
    }
    writeFileSync(join(ctx.runDir, 'tokens.json'), JSON.stringify(tokens, null, 2));
    ctx.state.fingerprint = applied.data.fingerprint;
    ctx.state.instance.fingerprint = applied.data.fingerprint;
    writeFileSync(join(ctx.runDir, 'instance.json'), JSON.stringify(ctx.state.instance, null, 2));
    const fontNote = (ctx.state.fonts ?? []).length > 0
        ? `, ${ctx.state.fonts.length} of them installed locally (${ctx.state.fonts.map((f) => `${f.family} ${f.version} ${f.cache}`).join('; ')})`
        : '';
    ctx.log(`design tokens applied to the theme — ${tokens.palette.length} colours, ${tokens.typography.families.length} font families${fontNote}; the site fingerprint moved to ${String(applied.data.fingerprint).slice(0, 8)}…`);
}
