// Mechanical cross-checks beyond the JSON Schema — violations ride the same
// validate() lane so they trigger the one metered schema-retry.
export function crossChecks(brief) {
    const issues = [];
    const blockSlugs = new Set((brief.custom_blocks ?? []).map((b) => b.slug));
    const pageSlugs = new Set((brief.pages ?? []).map((p) => p.slug));
    (brief.pages ?? []).forEach((p, pi) => {
        const seen = new Set();
        (p.sections ?? []).forEach((s, si) => {
            if (s.uses_custom_block && !blockSlugs.has(s.uses_custom_block)) {
                issues.push({ path: `/pages/${pi}/sections/${si}/uses_custom_block`, message: `no custom_blocks entry "${s.uses_custom_block}"` });
            }
            if (seen.has(s.id)) issues.push({ path: `/pages/${pi}/sections/${si}/id`, message: `duplicate section id "${s.id}"` });
            seen.add(s.id);
        });
    });
    for (const [field, items] of [['navigation', brief.navigation?.items], ['footer', brief.footer?.items]]) {
        (items ?? []).forEach((it, i) => {
            if (!pageSlugs.has(it.page_slug)) issues.push({ path: `/${field}/items/${i}/page_slug`, message: `no page "${it.page_slug}"` });
        });
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
