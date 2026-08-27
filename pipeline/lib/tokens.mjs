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

export function tokenChecks(tokens, { theme_spacing, theme_layout, briefPalette, bespoke = false }) {
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
    // The theme wires body text straight to `contrast` on `base` (field bug: a
    // dark brief once aliased contrast to a near-black "high-contrast dark" on
    // a near-black ground and the header vanished at 1.06:1). base is the
    // ground, contrast is the INK — the pair must read.
    const bySlug = Object.fromEntries(tokens.palette.map((p) => [p.slug, String(p.color)]));
    if (bySlug.base && bySlug.contrast) {
        const ratio = contrastRatio(bySlug.base, bySlug.contrast);
        if (ratio < 4.5) {
            issues.push({
                path: '/palette',
                message: `contrast ${bySlug.contrast} on base ${bySlug.base} reads at ${ratio.toFixed(2)}:1 — body text needs at least 4.5:1. "contrast" means the ink colour against the ground, not a high-contrast-looking dark; on a dark base it must be LIGHT`,
            });
        }
    }
    // The bespoke ground wires body text and headings to the token family
    // slugs 'body' and 'heading' (the base/contrast convention, typographic):
    // a bespoke run whose tokens skip those slugs would render browser
    // defaults and any sourced face would sit unloaded forever.
    if (bespoke) {
        const familySlugs = new Set((tokens.typography?.families ?? []).map((f) => f.slug));
        for (const required of ['body', 'heading']) {
            if (!familySlugs.has(required)) {
                issues.push({ path: '/typography/families', message: `this is a BESPOKE-ground run: the theme wires ${required === 'body' ? 'body text' : 'headings'} to the family slug "${required}" — a family with that slug must exist (it may also carry a source)` });
            }
        }
    }
    // The font lane (theme-factory): a family MAY declare `source` (the agent
    // downloads and installs it); `fontFace` is PIPELINE-CONSTRUCTED from the
    // uploaded files and never the model's to write.
    for (const [i, family] of (tokens.typography?.families ?? []).entries()) {
        if (family.fontFace !== undefined) {
            issues.push({ path: `/typography/families/${i}/fontFace`, message: 'fontFace is pipeline-owned — declare source: {provider:"google", family, weights} and the font lane constructs fontFace from the uploaded files' });
        }
        if (family.source && !family.fontFamily.toLowerCase().includes(family.source.family.toLowerCase().split(' ')[0])) {
            issues.push({ path: `/typography/families/${i}/fontFamily`, message: `fontFamily must LEAD with the sourced family — "${family.source.family}" first, then the fallback stack (it is both the rendered promise and the fallback)` });
        }
    }
    return issues;
}

// Resolve a brief-level band name ('base'|'surface'|'contrast'|'accent') into
// the APPLIED palette slugs the tree may spend: brief roles are matched to
// applied entries by hex, and the TEXT slug is chosen by measured contrast
// against the band's actual color — a bright accent band gets dark ink, a dark
// one gets light ink, regardless of which slug is named what.
function relativeLuminance(hex) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const [r, g, b] = [0, 2, 4].map((i) => {
        const v = parseInt(full.slice(i, i + 2), 16) / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(hexA, hexB) {
    const [hi, lo] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
}

// Which ink reads on this colour: 'light' means black ink wins, i.e. the colour
// itself is light. The tree prompt ships this with every slug — a model that
// only ever saw slug NAMES guessed lightness from vocabulary ("contrast must
// be dark") and produced cream-on-cream text on sites whose base is dark.
export function toneOf(hex) {
    return contrastRatio(hex, '#000000') >= contrastRatio(hex, '#ffffff') ? 'light' : 'dark';
}

export function annotatePalette(palette) {
    return palette.map((p) => ({ slug: p.slug, color: p.color, tone: toneOf(p.color) }));
}

export function mixHex(hexA, hexB, t) {
    const parse = (hex) => {
        const h = hex.replace('#', '');
        const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
        return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    };
    const a = parse(hexA);
    const b = parse(hexB);
    return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

// The band's measured ink menus: which palette slugs may carry text on this
// ground. safe_inks clear 4.5:1 (any text); display_only_inks clear 3:1 — legal
// only for large ornamental display text, and S9 still logs them as advisory.
// A slug in neither menu is rejected mechanically at S4 (the brass-on-bone
// field bug: an accent spent as body ink on a light band read at 2.74:1,
// passed every markup-level gate, and killed the run at S9 after publish).
export function resolveInkMenus(background, appliedPalette) {
    const bySlug = new Map(appliedPalette.map((p) => [p.slug, p.color]));
    const bgHex = bySlug.get(background);
    const safe_inks = [];
    const display_only_inks = [];
    if (!bgHex) return { safe_inks, display_only_inks };
    for (const p of appliedPalette) {
        if (p.slug === background) continue;
        const r = contrastRatio(bgHex, p.color);
        if (r >= 4.5) safe_inks.push(p.slug);
        else if (r >= 3) display_only_inks.push(p.slug);
    }
    return { safe_inks, display_only_inks };
}

export function resolveBandColors(band, briefPalette, appliedPalette) {
    const slugs = new Set(appliedPalette.map((p) => p.slug));
    const bySlug = new Map(appliedPalette.map((p) => [p.slug, p.color]));
    const byColor = new Map(appliedPalette.map((p) => [p.color.toLowerCase(), p.slug]));
    const roleSlug = (role) => {
        const entry = (briefPalette ?? []).find((p) => p.role === role);
        return entry ? byColor.get(entry.color.toLowerCase()) : undefined;
    };
    const base = slugs.has('base') ? 'base' : appliedPalette[0]?.slug;
    const contrast = slugs.has('contrast') ? 'contrast' : appliedPalette[1]?.slug;

    let background;
    switch (band) {
        case 'contrast': background = contrast; break;
        case 'accent': background = roleSlug('accent') ?? roleSlug('primary') ?? contrast; break;
        case 'surface': background = roleSlug('surface') ?? roleSlug('background') ?? base; break;
        default: background = base;
    }

    const bgHex = bySlug.get(background);
    const candidates = [...new Set([roleSlug('text'), contrast, base].filter((s) => s && s !== background && bySlug.has(s)))];
    let text = candidates[0] ?? contrast;
    if (bgHex && candidates.length > 1) {
        text = candidates.reduce((best, s) =>
            (contrastRatio(bgHex, bySlug.get(s)) > contrastRatio(bgHex, bySlug.get(best)) ? s : best), candidates[0]);
    }
    return { background, text };
}
