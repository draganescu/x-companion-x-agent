import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { sha256 } from '../lib/hash.mjs';
import { deriveThemeSpacing, deriveThemeLayout, tokenChecks } from '../lib/tokens.mjs';
import { surfaceHexes } from '../lib/surfaces.mjs';
import { renderStyleNote } from '../lib/styles.mjs';

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
    ctx.log(`design tokens applied to the theme — ${tokens.palette.length} colours, ${tokens.typography.families.length} font families; the site fingerprint moved to ${String(applied.data.fingerprint).slice(0, 8)}…`);

    // The canvas is born HERE, with the tokens (x-surfaces M6): its measured
    // luminance range constrains every canvas band's ink menus at S4, so the
    // asset must exist before any tree does. Born on-palette against the
    // final applied hexes; metered like every birth; a failed birth degrades
    // to the flat ground with a LOUD report entry — the run never dies for a
    // texture. S8 uploads the file and ships styles.background.
    const canvasEntry = (brief.surfaces ?? []).find((s) => s.class === 'canvas');
    if (canvasEntry && !ctx.state.no_images) {
        ctx.state.surface_report = ctx.state.surface_report ?? { assets: [], degraded: [], refusals: [] };
        ctx.budget.spend('image', canvasEntry.id);
        const started = Date.now();
        const born = await ctx.call('wp_images_generate', {
            assets_only: true,
            surfaces: [{
                id: canvasEntry.id,
                class: 'canvas',
                prompt_seed: canvasEntry.prompt_seed,
                intensity: canvasEntry.intensity,
                hexes: surfaceHexes(canvasEntry, brief, tokens.palette),
            }],
            style: brief.art_direction,
            out_dir: join(ctx.runDir, 'images'),
        });
        const asset = born.ok ? (born.data.surfaces ?? []).find((s) => s.asset_id === canvasEntry.id) : null;
        ctx.ledger.record({
            task_type: 'image',
            label: canvasEntry.id,
            provider: 'gemini',
            model: 'wp_images_generate',
            prompt_hash: sha256(canvasEntry.id),
            payload_hash: sha256(canvasEntry.id),
            usage: { input_tokens: 0, output_tokens: 0 },
            attempt: 1,
            outcome: asset?.file ? 'ok' : 'error',
            started_at: started,
            ms: asset?.ms ?? 0,
        });
        if (asset?.file) {
            ctx.state.canvas = { asset_id: canvasEntry.id, file: asset.file, lum_min: asset.lum_min, lum_max: asset.lum_max };
            ctx.log(`page canvas "${canvasEntry.id}" born with the tokens — luminance ${asset.lum_min}..${asset.lum_max} constrains every canvas band's ink`);
        } else {
            const reason = born.ok ? 'the canvas birth returned no asset' : `the canvas birth failed (${born.data.message})`;
            ctx.state.surface_report.degraded.push({ asset_id: canvasEntry.id, reason: `${reason} — canvas bands ship on the flat page ground` });
            ctx.log(`surface degraded: ${reason} — canvas bands ship on the flat page ground`);
        }
    }
}
