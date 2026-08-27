// The SECTION GRAMMAR: the shared composition rules every S4 call obeys, so
// twenty independent model calls read as one designed site instead of a
// hotch-potch (the Vienna field bug: h2s rendered at 52, 34 and 14px, h3s at
// 12, 18, 24 and 104px, and band content alternated 645/1340px at random).
// Derived DETERMINISTICALLY once per run from the applied type scale — the
// menus constrain, then the gates verify (the ink-menu pattern, applied to
// type and width).

// '4rem' -> 64, '52px' -> 52; a fluid size is judged by its widest rendering.
function sizeToPx(entry) {
    const parse = (v) => {
        if (typeof v !== 'string') return NaN;
        const m = /^([\d.]+)(px|rem|em)?/.exec(v.trim());
        if (!m) return NaN;
        const n = Number.parseFloat(m[1]);
        return m[2] === 'px' ? n : n * 16;
    };
    const fluidMax = entry.fluid && typeof entry.fluid === 'object' ? parse(entry.fluid.max) : NaN;
    return Number.isFinite(fluidMax) ? fluidMax : parse(entry.size);
}

/**
 * The level -> fontSize-slug map (plus the kicker slug), from the applied
 * typography. h1 = the largest step (display), h2/h3 the next steps down,
 * kicker = the smallest. Returns null when the scale is unparseable — the
 * gates then stand down rather than guessing.
 */
export function sectionGrammar(typography) {
    const sizes = (typography?.sizes ?? [])
        .map((s) => ({ slug: s.slug, px: sizeToPx(s) }))
        .filter((s) => typeof s.slug === 'string' && Number.isFinite(s.px));
    if (sizes.length === 0) return null;
    const desc = [...sizes].sort((a, b) => b.px - a.px);
    return {
        h1: desc[0].slug,
        h2: (desc[1] ?? desc[0]).slug,
        h3: (desc[2] ?? desc[1] ?? desc[0]).slug,
        kicker: desc[desc.length - 1].slug,
    };
}

/** The width recipe per brief layout value: which align a section's content
 *  containers may carry. stack reads at content width; the composed layouts
 *  get EXACTLY ONE alignwide container. Full-bleed belongs to the band root
 *  (and a loud cover), never to arbitrary children. */
export function widthRecipe(layout) {
    if (layout === 'split' || layout === 'asymmetric' || layout === 'grid') {
        return { alignwide_children: 1 };
    }
    return { alignwide_children: 0 };
}
