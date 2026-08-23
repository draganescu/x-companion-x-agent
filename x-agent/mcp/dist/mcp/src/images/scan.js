import { ASPECT_RATIOS } from './gemini.js';
const PLACEHOLDER_URL = /\/x-pixel-[0-9a-f]{6,8}\.(gif|png)$/i;
/** Which attributes hold the image URL/id, per block. Default fits core/image
 *  and core/cover; core/media-text names its media differently. */
function attrNames(blockName) {
    if (blockName === 'core/media-text')
        return { url: 'mediaUrl', id: 'mediaId' };
    return { url: 'url', id: 'id' };
}
/** "3/4" -> "3:4"; "1" -> "1:1"; anything the API does not accept -> 16:9. */
export function toApiAspect(attr) {
    if (typeof attr === 'string' && attr.trim() !== '') {
        const mapped = attr.trim() === '1' ? '1:1' : attr.trim().replace('/', ':');
        if (ASPECT_RATIOS.has(mapped))
            return mapped;
    }
    return '16:9';
}
export function findPlaceholders(blocks) {
    const out = [];
    const walk = (nodes, prefix) => {
        nodes.forEach((node, i) => {
            const path = `${prefix}/${i}`;
            const attrs = (node.attributes ?? {});
            const meta = attrs.metadata;
            const intent = typeof meta?.imageIntent === 'string' ? meta.imageIntent.trim() : '';
            const names = attrNames(node.name);
            const url = typeof attrs[names.url] === 'string' ? attrs[names.url] : '';
            if (intent !== '' && PLACEHOLDER_URL.test(url)) {
                out.push({
                    path,
                    block_name: node.name,
                    intent,
                    url_attr: names.url,
                    id_attr: names.id,
                    url,
                    id: typeof attrs[names.id] === 'number' ? attrs[names.id] : undefined,
                    aspect_ratio: toApiAspect(attrs.aspectRatio),
                });
            }
            if (Array.isArray(node.innerBlocks) && node.innerBlocks.length)
                walk(node.innerBlocks, `${path}/innerBlocks`);
        });
    };
    walk(blocks, '/blocks');
    return out;
}
/** Resolve a /blocks/... pointer back to its node, or undefined. */
export function nodeAt(blocks, path) {
    const segs = path.split('/').filter(Boolean);
    if (segs[0] !== 'blocks')
        return undefined;
    let nodes = blocks;
    let node;
    for (let i = 1; i < segs.length; i++) {
        const seg = segs[i];
        if (seg === 'innerBlocks') {
            nodes = node?.innerBlocks;
            continue;
        }
        const idx = Number(seg);
        if (!Number.isInteger(idx) || !nodes || !nodes[idx])
            return undefined;
        node = nodes[idx];
        nodes = undefined;
    }
    return node;
}
/**
 * Swap a generated attachment into the node a ref points at. The node must
 * still be the same placeholder (same URL) — a page edited since the scan
 * fails the match instead of overwriting someone's real photo. The intent
 * stays on the node as provenance.
 */
export function applyImage(blocks, ref, media) {
    const node = nodeAt(blocks, ref.path);
    if (!node || node.name !== ref.block_name)
        return false;
    const attrs = (node.attributes ?? {});
    if (attrs[ref.url_attr] !== ref.url)
        return false;
    attrs[ref.url_attr] = media.url;
    attrs[ref.id_attr] = media.id;
    node.attributes = attrs;
    return true;
}
//# sourceMappingURL=scan.js.map