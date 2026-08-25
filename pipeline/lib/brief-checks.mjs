// Mechanical cross-checks beyond the JSON Schema — violations ride the same
// validate() lane so they trigger the one metered schema-retry.
export function crossChecks(brief) {
    const issues = [];
    const blockSlugs = new Set((brief.custom_blocks ?? []).map((b) => b.slug));
    const pageSlugs = new Set((brief.pages ?? []).map((p) => p.slug));
    (brief.pages ?? []).forEach((p, pi) => {
        const seen = new Set();
        let accentBands = 0;
        (p.sections ?? []).forEach((s, si) => {
            if (s.uses_custom_block && !blockSlugs.has(s.uses_custom_block)) {
                issues.push({ path: `/pages/${pi}/sections/${si}/uses_custom_block`, message: `no custom_blocks entry "${s.uses_custom_block}"` });
            }
            if (seen.has(s.id)) issues.push({ path: `/pages/${pi}/sections/${si}/id`, message: `duplicate section id "${s.id}"` });
            seen.add(s.id);
            if (s.design?.band === 'accent') accentBands += 1;
            if (s.role === 'gallery' && !Array.isArray(s.image_intent)) {
                issues.push({ path: `/pages/${pi}/sections/${si}/image_intent`, message: 'a gallery section must carry an ARRAY of image_intent entries (3-6) — a gallery without images is an empty frame' });
            }
        });
        if (accentBands > 1) {
            issues.push({ path: `/pages/${pi}/sections`, message: `${accentBands} accent bands on one page — exactly one bright moment (§2): at most one section may sit on the accent band` });
        }
    });
    for (const [field, items] of [['navigation', brief.navigation?.items], ['footer', brief.footer?.items]]) {
        (items ?? []).forEach((it, i) => {
            if (!pageSlugs.has(it.page_slug)) issues.push({ path: `/${field}/items/${i}/page_slug`, message: `no page "${it.page_slug}"` });
        });
    }
    // Planned bands must be expressible in the palette, or alternation silently
    // collapses (a surface band falling back to base merges adjacent sections).
    const roles = new Set((brief.palette ?? []).map((p) => p.role));
    const planned = new Set((brief.pages ?? []).flatMap((p) => (p.sections ?? []).map((s) => s.design?.band)));
    if (planned.has('surface') && !roles.has('surface') && !roles.has('background')) {
        issues.push({ path: '/palette', message: 'a section plans a "surface" band but the palette has no role "surface" (or "background") entry — add a tint one step off the background, or plan "base"' });
    }
    if (planned.has('accent') && !roles.has('accent') && !roles.has('primary')) {
        issues.push({ path: '/palette', message: 'a section plans an "accent" band but the palette has no role "accent" (or "primary") entry' });
    }
    const fronts = (brief.pages ?? []).filter((p) => p.front_page).length;
    if (fronts !== 1) issues.push({ path: '/pages', message: `exactly one page must set front_page:true (got ${fronts})` });
    const dupSlugs = (list, where) => {
        const seen = new Set();
        (list ?? []).forEach((x, i) => {
            if (seen.has(x.slug)) issues.push({ path: `/${where}/${i}/slug`, message: `duplicate slug "${x.slug}"` });
            seen.add(x.slug);
        });
    };
    dupSlugs(brief.custom_blocks, 'custom_blocks');
    dupSlugs(brief.schema_packages, 'schema_packages');
    return issues;
}
