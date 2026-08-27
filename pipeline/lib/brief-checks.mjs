import { isTextureNone } from './styles.mjs';

// Mechanical cross-checks beyond the JSON Schema — violations ride the same
// validate() lane so they trigger the one metered schema-retry.
// opts.textures, when provided by S1, carries the chosen combo's texture cues
// ({artistic, ui}) so the flatness rule can be enforced mechanically.
export function crossChecks(brief, { textures } = {}) {
    const issues = [];
    issues.push(...surfaceChecks(brief, textures));
    const blockSlugs = new Set((brief.custom_blocks ?? []).map((b) => b.slug));
    const pageSlugs = new Set((brief.pages ?? []).map((p) => p.slug));
    (brief.pages ?? []).forEach((p, pi) => {
        const seen = new Set();
        let accentBands = 0;
        let axisBreaks = 0;
        (p.sections ?? []).forEach((s, si) => {
            if (s.design?.axis_break === true) {
                axisBreaks += 1;
                if (!s.design.notes) {
                    issues.push({ path: `/pages/${pi}/sections/${si}/design/notes`, message: `section "${s.id}" breaks the site axis without arguing it — an axis break carries its reason in design.notes or it is scattering, not design` });
                }
            }
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
        if (axisBreaks > 1) {
            issues.push({ path: `/pages/${pi}/sections`, message: `${axisBreaks} axis breaks on one page — the axis is one site-wide decision (§2, One axis): at most one section per page may break it, the way at most one band is accent` });
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

// The x-surfaces sequencing rules: the dictionary is fixed BEFORE section
// trees are authored, so every violation here is caught while it is still one
// schema-retry away from correct — never a runtime surprise on a published page.
function surfaceChecks(brief, textures) {
    const issues = [];
    const surfaces = brief.surfaces ?? [];
    const sectionKeys = new Set((brief.pages ?? []).flatMap((p) => (p.sections ?? []).map((s) => `${p.slug}/${s.id}`)));
    const roleByKey = new Map((brief.pages ?? []).flatMap((p) => (p.sections ?? []).map((s) => [`${p.slug}/${s.id}`, s.role])));
    const attachedBy = (predicate) => {
        const keys = new Set();
        for (const s of surfaces) {
            if (!predicate(s)) continue;
            for (const ref of s.attach ?? []) keys.add(ref);
        }
        return keys;
    };
    // skinned = a field or pattern lands on the band; the sequencing anchor.
    const skinned = attachedBy((s) => s.class === 'field' || s.class === 'pattern');
    const decorated = attachedBy((s) => s.class === 'frieze' || s.class === 'field');

    surfaces.forEach((s, i) => {
        for (const ref of s.attach ?? []) {
            if (!sectionKeys.has(ref)) {
                issues.push({ path: `/surfaces/${i}/attach`, message: `surface "${s.id}" attaches to "${ref}" but no page/section matches — attach refs are "page_slug/section_id"` });
            }
        }
        if (s.class === 'canvas' && (s.attach ?? []).length > 0) {
            issues.push({ path: `/surfaces/${i}/attach`, message: `the canvas asset is site-wide — it sits behind every canvas band; attach must be empty` });
        }
        if (s.class === 'spot' && s.ground_baked === true) {
            for (const ref of s.attach ?? []) {
                if (skinned.has(ref)) {
                    issues.push({ path: `/surfaces/${i}/ground_baked`, message: `spot "${s.id}" is ground-baked onto "${ref}", which carries a skin — ground-baked decor is only legal on skin-less flat bands; drop ground_baked (true-alpha spot) or attach it to an unskinned band` });
                }
            }
        }
        // A frieze is ornamental SEPARATION: it lives on dividers (and hero/cta
        // edges), never behind a content band's copy — the Vienna strapline
        // shipped small caps over the frieze and read as nothing at all.
        if (s.class === 'frieze') {
            for (const ref of s.attach ?? []) {
                const role = roleByKey.get(ref);
                if (role !== undefined && role !== 'divider' && role !== 'hero' && role !== 'cta') {
                    issues.push({ path: `/surfaces/${i}/attach`, message: `frieze "${s.id}" attaches to "${ref}" (role ${role}) — a frieze is ornamental separation and lives on a divider band (or a hero/cta edge); declare a role "divider" section for it, or attach it there` });
                }
            }
        }
    });

    // Texture is SUPPORT, not wallpaper: decoration lives first in dividers,
    // edge friezes and spot ornaments; full-band skins are the exception.
    // Cap them per page, and on text-heavy bands allow only a whisper —
    // louder material belongs to heroes, ctas, galleries and dividers.
    const TEXT_HEAVY_ROLES = new Set(['features', 'pricing', 'faq', 'content', 'contact', 'testimonial']);
    const roleOf = new Map((brief.pages ?? []).flatMap((p) => (p.sections ?? []).map((s) => [`${p.slug}/${s.id}`, s.role])));
    (brief.pages ?? []).forEach((p, pi) => {
        const skinnedHere = new Set([...skinned].filter((key) => key.startsWith(`${p.slug}/`)));
        if (skinnedHere.size > 2) {
            issues.push({ path: '/surfaces', message: `${skinnedHere.size} skinned bands on page "${p.slug}" — texture is support, not wallpaper: at most 2 full-band skins per page; move the rest of the decoration to dividers, edge friezes and spot ornaments` });
        }
    });
    surfaces.forEach((s, i) => {
        if (s.class !== 'field' && s.class !== 'pattern') return;
        if (s.intensity === 'whisper') return;
        for (const ref of s.attach ?? []) {
            if (TEXT_HEAVY_ROLES.has(roleOf.get(ref))) {
                issues.push({ path: `/surfaces/${i}/intensity`, message: `surface "${s.id}" (${s.intensity}) skins "${ref}", a ${roleOf.get(ref)} band that carries body text — only a whisper skin is legal there; lower the intensity to whisper, or attach it to a hero, cta, gallery or divider band` });
            }
        }
    });

    const hasCanvasAsset = surfaces.some((s) => s.class === 'canvas');
    (brief.pages ?? []).forEach((p, pi) => {
        (p.sections ?? []).forEach((s, si) => {
            const key = `${p.slug}/${s.id}`;
            if (s.design?.band === 'canvas') {
                if (!hasCanvasAsset) {
                    issues.push({ path: `/pages/${pi}/sections/${si}/design/band`, message: `section "${s.id}" plans a canvas band but a canvas band needs a canvas asset in surfaces[] — declare one (class "canvas", attach []) or use band "base"` });
                }
                if (skinned.has(key)) {
                    issues.push({ path: `/pages/${pi}/sections/${si}/design/band`, message: `section "${s.id}" is a canvas band AND carries a skin — canvas bands sit bare on the page canvas; move the skin to a flat band or change the band` });
                }
            }
            if (s.role === 'divider' && !decorated.has(key)) {
                issues.push({ path: `/pages/${pi}/sections/${si}/role`, message: `divider "${s.id}" has no frieze or field surface attached — a divider's only job is its skin; attach one in surfaces[] or use role "section"` });
            }
        });
    });
    if (hasCanvasAsset) {
        const anyCanvasBand = (brief.pages ?? []).some((p) => (p.sections ?? []).some((s) => s.design?.band === 'canvas'));
        if (!anyCanvasBand) {
            const i = surfaces.findIndex((s) => s.class === 'canvas');
            issues.push({ path: `/surfaces/${i}`, message: `a canvas asset is invisible without at least one canvas band (flush opaque bands hide the page ground) — remove it or declare a canvas band` });
        }
    }

    if (textures && surfaces.length > 0 && (isTextureNone(textures.artistic) || isTextureNone(textures.ui))) {
        issues.push({ path: '/surfaces', message: `the chosen style's texture cue is "none" — flatness honored IS the style; surfaces must be an empty array (an empty dictionary is the correct, complete realization)` });
    }
    return issues;
}
