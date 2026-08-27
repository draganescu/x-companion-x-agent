// The surface lane's pipeline-side brain — pure functions, no I/O. S8 mints
// metadata.surfaceIntent markers onto the assembled trees the way it mints
// placeholder pixels and injects nav links: deterministically, from the
// brief's own dictionary, gated by the same validate/compile lane as
// everything else. The scan on the instance then finds the markers exactly
// like it finds placeholder urls.
import { PipelineError } from './errors.mjs';
import { resolveBandColors } from './tokens.mjs';

// What lands on one section, derived from the dictionary. A field/pattern at
// intensity 'loud' is the loud_band mechanism (core/cover + veil); anything
// quieter is a group skin. Friezes are edges; spots are spots.
export function pageSurfacePlan(brief, pageSlug, { groupSupport = true } = {}) {
    const plans = new Map();
    const degraded = [];
    const planFor = (id) => {
        if (!plans.has(id)) plans.set(id, { skin: null, edge: null, spots: [], loud: null });
        return plans.get(id);
    };
    for (const entry of brief.surfaces ?? []) {
        if (entry.class === 'canvas') continue; // site-wide, ships with the tokens
        const isLoud = entry.intensity === 'loud' && (entry.class === 'field' || entry.class === 'pattern');
        for (const ref of entry.attach ?? []) {
            const [page, sectionId] = ref.split('/');
            if (page !== pageSlug) continue;
            // The cover mechanism (loud_band) shares attributes with the
            // content lane and needs no group support; everything else is a
            // group background and degrades to the flat band without it.
            if (!groupSupport && !isLoud) {
                degraded.push({ asset_id: entry.id, section: sectionId, reason: 'core/group has no background support on this instance — the flat band ships' });
                continue;
            }
            const plan = planFor(sectionId);
            if (entry.class === 'frieze') {
                plan.edge = { id: entry.id, position: entry.position ?? entry.edge ?? 'top' };
            } else if (entry.class === 'spot') {
                plan.spots.push({ id: entry.id, position: entry.position ?? 'top right', size: entry.size });
            } else if (isLoud) {
                plan.loud = { id: entry.id, coverOnly: !groupSupport };
            } else {
                plan.skin = { id: entry.id };
            }
        }
    }
    return { plans, degraded };
}

const marker = (node, assetId) => {
    node.attributes = node.attributes ?? {};
    node.attributes.metadata = { ...(node.attributes.metadata ?? {}), surfaceIntent: assetId };
};

const findCover = (node) => {
    if (node.name === 'core/cover') return node;
    for (const child of node.innerBlocks ?? []) {
        const hit = findCover(child);
        if (hit) return hit;
    }
    return null;
};

/**
 * Mint surfaceIntent markers onto one assembled page tree. tree.blocks[i] is
 * the i-th section's root group (the band_root gate guarantees one root per
 * section). One group, one layer: when a band carries more than one surface,
 * every layer after the first wraps the content in ONE nested group carrying
 * the next marker — each layer individually admin-editable.
 */
export function mintSurfaceMarkers(tree, sections, plans) {
    let minted = 0;
    let wrapped = 0;
    const degraded = [];
    sections.forEach((sec, i) => {
        const plan = plans.get(sec.id);
        if (!plan) return;
        const wants = (plan.skin ? 1 : 0) + (plan.edge ? 1 : 0) + plan.spots.length + (plan.loud ? 1 : 0);
        if (wants === 0) return;
        const root = tree.blocks[i];
        if (!root || root.name !== 'core/group' || sec.dead) {
            degraded.push({ section: sec.id, reason: sec.dead ? 'section shipped its pattern baseline — the flat band stays' : 'no root group to carry the surface' });
            return;
        }
        const layers = [];
        if (plan.loud) {
            const cover = findCover(root);
            if (cover && !cover.attributes?.metadata?.imageIntent && !cover.attributes?.metadata?.surfaceIntent) {
                marker(cover, plan.loud.id);
                minted += 1;
            } else if (plan.loud.coverOnly) {
                // No cover AND no group support to fall back on: flat band.
                degraded.push({ section: sec.id, asset_id: plan.loud.id, reason: 'loud surface found no core/cover and this instance has no group background support — the flat band ships' });
            } else {
                // No cover to veil it — the material still lands, as a group
                // skin the pixel oracle will rate. Loud but legal.
                layers.push({ id: plan.loud.id });
                degraded.push({ section: sec.id, asset_id: plan.loud.id, reason: 'loud surface found no core/cover — applied as a group skin instead' });
            }
        }
        if (plan.skin) layers.push(plan.skin);
        if (plan.edge) layers.push(plan.edge);
        layers.push(...plan.spots);
        if (layers.length === 0) return;
        marker(root, layers[0].id);
        minted += 1;
        let host = root;
        for (const layer of layers.slice(1)) {
            const wrapper = {
                name: 'core/group',
                attributes: { align: 'full', layout: { type: 'constrained' }, metadata: { surfaceIntent: layer.id } },
                innerBlocks: host.innerBlocks ?? [],
            };
            host.innerBlocks = [wrapper];
            host = wrapper;
            minted += 1;
            wrapped += 1;
        }
    });
    return { minted, wrapped, degraded };
}

/**
 * The exact hexes of every band an asset touches — mandatory prompt material.
 * A ground-baked spot's FIRST hex is the band it is baked onto. The canvas
 * anchors on the site's base ground. Throws rather than prompting hexless.
 */
export function surfaceHexes(entry, brief, appliedPalette) {
    const bySlug = new Map(appliedPalette.map((p) => [p.slug, p.color]));
    const bandOf = new Map((brief.pages ?? []).flatMap((p) => (p.sections ?? []).map((s) => [`${p.slug}/${s.id}`, s.design?.band ?? 'base'])));
    const hexes = [];
    const push = (band) => {
        const pair = resolveBandColors(band === 'canvas' ? 'base' : band, brief.palette, appliedPalette);
        const hex = bySlug.get(pair.background);
        if (hex && !hexes.includes(hex)) hexes.push(hex);
    };
    if (entry.class === 'canvas') push('base');
    else for (const ref of entry.attach ?? []) { if (bandOf.has(ref)) push(bandOf.get(ref)); }
    if (hexes.length === 0) {
        throw new PipelineError('internal', `surface "${entry.id}" resolved no band hexes — a surface prompt without its hexes is a bug`,
            'Every attach ref must name a real page/section whose band maps to an applied palette slug.');
    }
    return hexes;
}

/** The dictionary entries whose attach touches one page, shaped for the
 *  wp_images_generate surfaces input (hexes resolved, knobs carried). */
export function pageSurfaceDict(brief, pageSlug, appliedPalette) {
    const out = [];
    for (const entry of brief.surfaces ?? []) {
        if (entry.class === 'canvas') continue;
        if (!(entry.attach ?? []).some((ref) => ref.startsWith(`${pageSlug}/`))) continue;
        out.push({
            id: entry.id,
            class: entry.class,
            prompt_seed: entry.prompt_seed,
            intensity: entry.intensity,
            hexes: surfaceHexes(entry, brief, appliedPalette),
            ...(entry.ground_baked !== undefined ? { ground_baked: entry.ground_baked } : {}),
            ...(entry.position !== undefined ? { position: entry.position } : {}),
            ...(entry.edge !== undefined && entry.position === undefined ? { position: entry.edge } : {}),
            ...(entry.size !== undefined ? { size: entry.size } : {}),
        });
    }
    return out;
}
