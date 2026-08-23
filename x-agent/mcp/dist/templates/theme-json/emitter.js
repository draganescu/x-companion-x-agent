/** `x-large` -> `X Large`, `step-40` -> `Step 40`. */
export function slugToName(slug) {
    return slug
        .split('-')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}
/** The pure emitter. */
export function emitThemeJsonSettings(tokens) {
    return {
        color: {
            palette: tokens.palette.map((p) => ({ slug: p.slug, name: p.name, color: p.color })),
        },
        spacing: {
            spacingSizes: tokens.spacing.steps.map((s) => ({
                slug: s.slug,
                name: slugToName(s.slug),
                size: s.size,
            })),
        },
        typography: {
            fontSizes: tokens.typography.sizes.map((s) => {
                const entry = { slug: s.slug, name: slugToName(s.slug), size: s.size };
                if (s.fluid !== undefined)
                    entry.fluid = s.fluid;
                return entry;
            }),
            fontFamilies: tokens.typography.families.map((f) => ({
                slug: f.slug,
                name: f.name,
                fontFamily: f.fontFamily,
            })),
        },
        layout: {
            contentSize: tokens.layout.contentSize,
            wideSize: tokens.layout.wideSize,
        },
    };
}
/** Convenience wrapper producing a complete theme.json document. */
export function emitThemeJson(tokens) {
    return {
        $schema: 'https://schemas.wp.org/trunk/theme.json',
        version: 3,
        settings: emitThemeJsonSettings(tokens),
    };
}
/**
 * Diff the emitted settings against `manifest.theme_tokens` (the instance's
 * resolved wp_get_global_settings() subset). Best effort: the instance shape is
 * loose, so anything unrecognised is skipped rather than guessed at.
 */
export function diffAgainstThemeTokens(settings, themeTokens) {
    const diffs = [];
    const t = (themeTokens ?? {});
    const indexBySlug = (v, valueKey) => {
        const m = new Map();
        if (!Array.isArray(v))
            return m;
        for (const e of v) {
            if (e && typeof e === 'object' && typeof e.slug === 'string') {
                const val = e[valueKey];
                m.set(String(e.slug), val === undefined ? '' : String(val));
            }
        }
        return m;
    };
    const compare = (group, expected, actual) => {
        for (const e of expected) {
            const a = actual.get(e.slug);
            if (a === undefined)
                diffs.push({ group, slug: e.slug, kind: 'missing_on_instance', expected: e.value, actual: null });
            else if (a.toLowerCase() !== e.value.toLowerCase())
                diffs.push({ group, slug: e.slug, kind: 'value_differs', expected: e.value, actual: a });
        }
    };
    compare('color.palette', settings.color.palette.map((p) => ({ slug: p.slug, value: p.color })), indexBySlug(t.color?.palette, 'color'));
    compare('spacing.spacingSizes', settings.spacing.spacingSizes.map((s) => ({ slug: s.slug, value: s.size })), indexBySlug(t.spacing?.spacingSizes, 'size'));
    compare('typography.fontSizes', settings.typography.fontSizes.map((s) => ({ slug: s.slug, value: s.size })), indexBySlug(t.typography?.fontSizes, 'size'));
    compare('typography.fontFamilies', settings.typography.fontFamilies.map((f) => ({ slug: f.slug, value: f.fontFamily })), indexBySlug(t.typography?.fontFamilies, 'fontFamily'));
    const layout = (t.layout ?? {});
    for (const key of ['contentSize', 'wideSize']) {
        const actual = layout[key] === undefined ? null : String(layout[key]);
        const expected = settings.layout[key];
        if (actual === null)
            diffs.push({ group: 'layout', slug: key, kind: 'missing_on_instance', expected, actual: null });
        else if (actual !== expected)
            diffs.push({ group: 'layout', slug: key, kind: 'value_differs', expected, actual });
    }
    return diffs;
}
//# sourceMappingURL=emitter.js.map