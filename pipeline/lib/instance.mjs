// Deterministic role -> block-family map: the manifest slice a section's tree
// call receives contains ONLY these families (spec S2: "only the block families
// the section role needs").
const ROLE_FAMILIES = {
    header: ['core/group', 'core/site-title', 'core/navigation', 'core/buttons', 'core/button'],
    hero: ['core/cover', 'core/group', 'core/heading', 'core/paragraph', 'core/buttons', 'core/button', 'core/image', 'core/spacer'],
    features: ['core/columns', 'core/column', 'core/group', 'core/heading', 'core/paragraph', 'core/image', 'core/list', 'core/list-item'],
    gallery: ['core/gallery', 'core/image', 'core/group', 'core/heading'],
    testimonial: ['core/quote', 'core/group', 'core/columns', 'core/column', 'core/paragraph', 'core/image', 'core/heading'],
    pricing: ['core/columns', 'core/column', 'core/group', 'core/heading', 'core/paragraph', 'core/list', 'core/list-item', 'core/buttons', 'core/button', 'core/separator'],
    faq: ['core/details', 'core/group', 'core/heading', 'core/paragraph'],
    cta: ['core/group', 'core/cover', 'core/heading', 'core/paragraph', 'core/buttons', 'core/button'],
    contact: ['core/group', 'core/columns', 'core/column', 'core/heading', 'core/paragraph', 'core/social-links', 'core/social-link'],
    content: ['core/group', 'core/heading', 'core/paragraph', 'core/image', 'core/list', 'core/list-item', 'core/separator', 'core/quote'],
    footer: ['core/group', 'core/columns', 'core/column', 'core/paragraph', 'core/site-title', 'core/social-links', 'core/social-link'],
    section: ['core/group', 'core/columns', 'core/column', 'core/heading', 'core/paragraph', 'core/image', 'core/buttons', 'core/button'],
};

const ROLE_PATTERN_QUERIES = {
    header: ['header'], hero: ['hero', 'cover', 'banner'], features: ['features', 'services', 'columns'],
    gallery: ['gallery'], testimonial: ['testimonial', 'quote'], pricing: ['pricing'],
    faq: ['faq'], cta: ['call to action', 'cta'], contact: ['contact'],
    content: ['text', 'about'], footer: ['footer'], section: ['text'],
};

// Deterministic pick: first query term with matches wins; among matches, the
// alphabetically-first pattern name wins.
export function pickPattern(patterns, role) {
    for (const term of ROLE_PATTERN_QUERIES[role] ?? []) {
        const matches = patterns.filter((p) => {
            const hay = `${p.name} ${p.title ?? ''} ${(p.categories ?? []).join(' ')}`.toLowerCase();
            return hay.includes(term);
        });
        if (matches.length > 0) {
            return [...matches].sort((a, b) => a.name.localeCompare(b.name))[0];
        }
    }
    return null;
}

export function sliceManifest(blocks, section, brief) {
    const families = ROLE_FAMILIES[section.role] ?? ROLE_FAMILIES.section;
    const slice = {};
    for (const name of families) {
        if (blocks[name]) {
            const { attributes, supports, parent, styles, variations } = blocks[name];
            slice[name] = {
                ...(attributes !== undefined ? { attributes } : {}),
                ...(supports !== undefined ? { supports } : {}),
                ...(parent !== undefined ? { parent } : {}),
                ...(styles !== undefined ? { styles } : {}),
                ...(variations !== undefined ? { variations } : {}),
            };
        }
    }
    const result = { blocks: slice };
    if (section.uses_custom_block) {
        const decl = (brief.custom_blocks ?? []).find((b) => b.slug === section.uses_custom_block);
        if (decl) {
            result.declared_custom_block = {
                name: `agent/${decl.slug}`,
                title: decl.title,
                attributes: decl.attributes,
                render_intent: decl.render_intent,
                note: 'This block does not exist yet; it is fabricated in S5 and installed in S8. Build the section around it with exactly these attributes.',
            };
        }
    }
    return result;
}

