// Deterministic tree normalization, applied between the model's output and the
// gates (S4 sections + furniture, S7 tree repairs). One rule so far:
//
// The flat-borderColor footgun. A tree that sets the flat `borderColor` preset
// attribute alongside a PER-SIDE style.border ships borders nobody designed:
// WordPress emits `has-border-color`, whose CSS paints border-style solid on
// ALL FOUR sides, and every side without a declared width then renders at the
// browser's default `medium` (3px). The model's intent — a colored rule on the
// declared side(s) only — is recoverable mechanically: fold the colour into
// each declared side and drop the flat attribute. A flat borderColor WITHOUT
// per-side entries is left alone: there the all-sides box is the intent.
const SIDES = ['top', 'right', 'bottom', 'left'];

export function normalizeTreeBorders(tree) {
    let folded = 0;
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        const attrs = node.attributes;
        const border = attrs?.style?.border;
        if (attrs?.borderColor && border && SIDES.some((s) => border[s] && typeof border[s] === 'object')) {
            for (const s of SIDES) {
                if (border[s] && typeof border[s] === 'object') {
                    border[s] = { style: 'solid', ...border[s], color: border[s].color ?? `var:preset|color|${attrs.borderColor}` };
                }
            }
            delete attrs.borderColor;
            folded += 1;
        }
        (node.innerBlocks ?? []).forEach(walk);
    };
    (tree?.blocks ?? []).forEach(walk);
    return folded;
}

/**
 * The furniture rescue: drop the attributes W_ATTR_UNKNOWN diagnostics point
 * at. Losing one undeclared textAlign is strictly less destructive than
 * throwing the whole designed part away for it (the Vienna field bug: a
 * designed footer died on a single unknown attribute and the unstyled floor
 * shipped). Deterministic, path-driven, one pass — the caller re-gates the
 * result whole. Returns the attribute paths actually removed.
 */
export function stripUnknownAttrs(tree, diagnostics) {
    const removed = [];
    for (const d of diagnostics ?? []) {
        if (d.code !== 'W_ATTR_UNKNOWN' || typeof d.path !== 'string') continue;
        const m = /^\/blocks(.*)\/attributes\/([^/]+)$/.exec(d.path);
        if (!m) continue;
        const segs = (m[1] ?? '').split('/').filter(Boolean);
        let nodes = tree?.blocks;
        let node = null;
        let ok = true;
        for (const seg of segs) {
            if (seg === 'innerBlocks') {
                nodes = node?.innerBlocks;
                continue;
            }
            const idx = Number(seg);
            if (!Number.isInteger(idx) || !nodes?.[idx]) { ok = false; break; }
            node = nodes[idx];
        }
        if (!ok || !node?.attributes || !(m[2] in node.attributes)) continue;
        delete node.attributes[m[2]];
        removed.push(d.path);
    }
    return removed;
}
