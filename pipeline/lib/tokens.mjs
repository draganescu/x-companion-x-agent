// The R9 discipline, mechanically: the theme's own spacing/layout pass through
// the token set verbatim. These derivations feed the PAYLOAD (context the model
// must echo — R13: the token set is still authored by the model); tokenChecks
// then asserts the echo byte-for-byte.
import { readFileSync } from 'node:fs';
import { validateSchema } from './schema.mjs';
import { canonicalJson } from './hash.mjs';

const contract = JSON.parse(readFileSync(new URL('../../contract/schemas/design-tokens.schema.json', import.meta.url), 'utf8'));

// wp_get_global_settings() serves origin-keyed arrays ({default, theme, custom})
// on real instances; the companion passes them through verbatim. The theme's own
// scale wins; core defaults are the fallback.
export function originArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
        return value.theme ?? value.default ?? value.custom ?? [];
    }
    return [];
}

export function deriveThemeSpacing(themeTokens) {
    const sizes = originArray(themeTokens?.spacing?.spacingSizes);
    return { scale_unit: 'px', steps: sizes.map((s) => ({ slug: String(s.slug), size: String(s.size) })) };
}

export function deriveThemeLayout(themeTokens) {
    return { contentSize: String(themeTokens?.layout?.contentSize ?? ''), wideSize: String(themeTokens?.layout?.wideSize ?? '') };
}

export function tokenChecks(tokens, { theme_spacing, theme_layout, briefPalette }) {
    const issues = validateSchema(contract, tokens);
    if (issues.length > 0) return issues; // contract first; the rest assumes shape

    if (canonicalJson(tokens.spacing) !== canonicalJson(theme_spacing)) {
        issues.push({ path: '/spacing', message: 'R9 violation: spacing must be byte-equal to the theme\'s own (copy theme_spacing verbatim)' });
    }
    if (canonicalJson(tokens.layout) !== canonicalJson(theme_layout)) {
        issues.push({ path: '/layout', message: 'R9 violation: layout must be byte-equal to the theme\'s own (copy theme_layout verbatim)' });
    }
    const have = new Set(tokens.palette.map((p) => p.color.toLowerCase()));
    for (const p of briefPalette) {
        if (!have.has(p.color.toLowerCase())) {
            issues.push({ path: '/palette', message: `brief color ${p.color} (${p.name}) is missing from the palette` });
        }
    }
    const slugs = new Set(tokens.palette.map((p) => p.slug));
    for (const required of ['base', 'contrast']) {
        if (!slugs.has(required)) {
            issues.push({ path: '/palette', message: `palette must keep the theme slug "${required}" (mapped onto this world) so theme template parts keep resolving` });
        }
    }
    return issues;
}

// Resolve a brief-level band name ('base'|'surface'|'contrast'|'accent') into
// the APPLIED palette slugs the tree may spend: brief roles are matched to
// applied entries by hex. Advisory for the model, deterministic for the ledger.
export function resolveBandColors(band, briefPalette, appliedPalette) {
    const slugs = new Set(appliedPalette.map((p) => p.slug));
    const byColor = new Map(appliedPalette.map((p) => [p.color.toLowerCase(), p.slug]));
    const roleSlug = (role) => {
        const entry = (briefPalette ?? []).find((p) => p.role === role);
        return entry ? byColor.get(entry.color.toLowerCase()) : undefined;
    };
    const base = slugs.has('base') ? 'base' : appliedPalette[0]?.slug;
    const contrast = slugs.has('contrast') ? 'contrast' : appliedPalette[1]?.slug;
    const text = roleSlug('text') ?? contrast;
    switch (band) {
        case 'contrast': return { background: contrast, text: base };
        case 'accent': return { background: roleSlug('accent') ?? roleSlug('primary') ?? contrast, text: base };
        case 'surface': return { background: roleSlug('surface') ?? roleSlug('background') ?? base, text };
        default: return { background: base, text };
    }
}
