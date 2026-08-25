// The design kit: one master call, one lean envelope — {tokens, molecules}.
//
// tokens is a DesignTokens document (the M2 contract, gated by the M2 tokens
// gate unchanged). molecules is the reusable-arrangement inventory S3b turns
// into saved patterns. That is the whole kit: the two parts that carry the
// design value and have never flaked.
//
// It used to also carry a full DesignSpecIR — regions with pixel boxes, a
// byte-exact quantization ledger, content copy, wp_spec_validate — apparatus
// built for MEASURING existing designs, imported wholesale for an INVENTED
// one. Field evidence (five kit incidents in three evenings, two dead runs)
// showed the bookkeeping made the one unsubstitutable call fragile while
// nothing from-prompt consumed it beyond a never-fatal S9 diff. Recorded in
// PROGRESS.pipeline.json; the owner's rule: better design, never at the
// expense of normal operation.
//
// Everything below the kit instantiates; nothing below it designs.
import { readFileSync } from 'node:fs';
import { validateSchema } from './schema.mjs';
import { contrastRatio } from './tokens.mjs';

const contractUrl = (name) => new URL(`../../contract/schemas/${name}`, import.meta.url);

export const designTokensSchema = JSON.parse(readFileSync(contractUrl('design-tokens.schema.json'), 'utf8'));
export const moleculesSchema = JSON.parse(readFileSync(new URL('../schemas/molecules.schema.json', import.meta.url), 'utf8'));

// The {tokens, molecules} envelope as ONE schema — what the kit call may emit.
export const kitEnvelopeSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['tokens', 'molecules'],
    properties: {
        tokens: designTokensSchema,
        molecules: moleculesSchema.properties.molecules,
    },
};

/**
 * The pre-call screen for the kit envelope. Shape first, then the semantic
 * checks a schema cannot express — each one earned by a field bug.
 */
export function kitChecks(value, { briefPalette = [], sectionRoles = [] } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return [{ path: '', message: 'expected {"tokens": DesignTokens, "molecules": [...]}' }];
    }
    const issues = [];
    for (const key of Object.keys(value)) {
        if (!['tokens', 'molecules'].includes(key)) {
            issues.push({ path: `/${key}`, message: 'the envelope is {tokens, molecules} — nothing else' });
        }
    }
    const tokens = value.tokens;
    if (!tokens || typeof tokens !== 'object') {
        return [{ path: '/tokens', message: 'tokens must be a DesignTokens object' }];
    }
    issues.push(...validateSchema(designTokensSchema, tokens, '/tokens'));
    issues.push(...validateSchema(moleculesSchema, { molecules: value.molecules }, ''));
    if (issues.length > 0) return issues; // shape first; the checks below assume it

    // The brief's palette is the client's, not the designer's to drop.
    const declared = (tokens.palette ?? []).map((p) => String(p.color).toLowerCase());
    for (const p of briefPalette) {
        if (!declared.includes(String(p.color).toLowerCase())) {
            issues.push({ path: '/tokens/palette', message: `the brief's ${p.name} ${p.color} is missing from the palette` });
        }
    }

    // The theme wires body text straight to `contrast` on `base` (field bug:
    // a dark brief once aliased contrast to a near-black "high-contrast dark"
    // on a near-black ground and the header vanished at 1.06:1). base is the
    // ground, contrast is the INK — the pair must exist and must read.
    const bySlug = Object.fromEntries((tokens.palette ?? []).map((p) => [p.slug, String(p.color)]));
    for (const slug of ['base', 'contrast']) {
        if (!bySlug[slug]) {
            issues.push({ path: '/tokens/palette', message: `the theme's reserved "${slug}" slug is missing — the theme's own template parts resolve base (the ground) and contrast (the ink)` });
        }
    }
    if (bySlug.base && bySlug.contrast) {
        const ratio = contrastRatio(bySlug.base, bySlug.contrast);
        if (ratio < 4.5) {
            issues.push({
                path: '/tokens/palette',
                message: `contrast ${bySlug.contrast} on base ${bySlug.base} reads at ${ratio.toFixed(2)}:1 — body text needs at least 4.5:1. "contrast" means the ink colour against the ground, not a high-contrast-looking dark; on a dark base it must be LIGHT`,
            });
        }
    }

    // Every section the brief will build needs vocabulary to build it from.
    const covered = new Set((value.molecules ?? []).map((m) => m.role));
    for (const role of new Set(sectionRoles)) {
        if (!covered.has(role)) {
            issues.push({ path: '/molecules', message: `no molecule for the "${role}" sections the brief declares — every role the brief uses needs at least one arrangement` });
        }
    }

    // Slugs below the kit resolve to slugs the kit declares.
    const slugs = {
        palette: new Set((tokens.palette ?? []).map((p) => p.slug)),
        spacing: new Set(((tokens.spacing ?? {}).steps ?? []).map((s) => s.slug)),
        font: new Set(((tokens.typography ?? {}).sizes ?? []).map((s) => s.slug)),
    };
    const seen = new Set();
    for (const m of value.molecules ?? []) {
        if (seen.has(m.id)) issues.push({ path: `/molecules (${m.id})`, message: 'duplicate molecule id' });
        seen.add(m.id);
        const refs = m.style_refs ?? {};
        for (const [field, set, kind] of [
            ['palette_slug', slugs.palette, 'palette'],
            ['background_palette_slug', slugs.palette, 'palette'],
            ['font_size_slug', slugs.font, 'font size'],
        ]) {
            if (refs[field] !== undefined && !set.has(refs[field])) {
                issues.push({ path: `/molecules (${m.id})/style_refs/${field}`, message: `"${refs[field]}" is not a ${kind} slug this kit declares` });
            }
        }
        for (const s of refs.spacing_slugs ?? []) {
            if (!slugs.spacing.has(s)) {
                issues.push({ path: `/molecules (${m.id})/style_refs/spacing_slugs`, message: `"${s}" is not a spacing slug this kit declares` });
            }
        }
    }
    return issues;
}

/**
 * The kit's tokens, shaped for wp_tokens_apply. The tool's input validation is
 * its own (a fourth copy of the shape, in TypeScript) and rejects keys the
 * contract tolerates — a live kit died on sizes[].name. Strip to exactly what
 * the tool accepts; the kit.json on disk keeps the model's full output.
 */
export function tokensFromKit(kit) {
    const { palette, spacing, typography, layout } = kit.tokens ?? {};
    return {
        palette,
        spacing,
        typography: typography ? {
            ...typography,
            sizes: (typography.sizes ?? []).map(({ slug, size, fluid }) => ({
                slug, size, ...(fluid !== undefined ? { fluid } : {}),
            })),
        } : typography,
        layout,
    };
}

/** agent/<kit_id>-<molecule_id>, inside the companion's 64-char slug window. */
export function kitId(brief) {
    const raw = String(brief?.identity?.site_title ?? 'kit')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return (raw || 'kit').slice(0, 20).replace(/-$/, '');
}

export function patternSlug(kit_id, moleculeId) {
    return `agent/${kit_id}-${moleculeId}`.slice(0, 64).replace(/-$/, '');
}
