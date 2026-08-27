// Mechanical cross-checks beside theme-spec.schema.json — the parts of the
// spec gate the draft-07 subset cannot express. Pure; returns the same
// {path, message} issue shape as validateSchema so both ride one validate().

const MEASURE_RE = /^([0-9]+(?:\.[0-9]+)?)(px|ch|rem)$/;

// A bespoke theme must never shadow a bundled theme or the toolchain's own
// plugin: `twenty*` is core's naming ground, and an `x-companion` theme dir
// would make wp-admin ambiguous about what the companion is.
const RESERVED_SLUG_RE = /^(twenty|x-companion$)/;

export function themeSpecChecks(spec) {
    const issues = [];
    if (!spec || typeof spec !== 'object') return issues; // the schema reports shape

    const measure = spec.measure;
    if (measure && typeof measure.contentSize === 'string' && typeof measure.wideSize === 'string') {
        const content = MEASURE_RE.exec(measure.contentSize);
        const wide = MEASURE_RE.exec(measure.wideSize);
        if (content && wide) {
            if (content[2] !== wide[2]) {
                issues.push({
                    path: '/measure',
                    message: `contentSize ${measure.contentSize} and wideSize ${measure.wideSize} use different units — use the same unit for both so the measure is mechanically comparable`,
                });
            } else if (Number(content[1]) >= Number(wide[1])) {
                issues.push({
                    path: '/measure',
                    message: `contentSize ${measure.contentSize} must be strictly under wideSize ${measure.wideSize}`,
                });
            }
        }
    }

    for (const group of ['shadows', 'gradients', 'duotones']) {
        const entries = spec.presets?.[group];
        if (!Array.isArray(entries)) continue;
        const seen = new Set();
        for (const entry of entries) {
            const slug = entry?.slug;
            if (typeof slug !== 'string') continue;
            if (seen.has(slug)) {
                issues.push({ path: `/presets/${group}`, message: `duplicate slug "${slug}" — preset slugs are addresses and must be unique within ${group}` });
            }
            seen.add(slug);
        }
    }

    const slug = spec.identity?.slug;
    if (typeof slug === 'string' && RESERVED_SLUG_RE.test(slug)) {
        issues.push({ path: '/identity/slug', message: `"${slug}" is reserved — bespoke themes never shadow core's twenty* namespace or the companion` });
    }

    return issues;
}
