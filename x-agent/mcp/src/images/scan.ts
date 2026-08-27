/**
 * Pure tree work for the asset pass: find every placeholder image that carries
 * an imageIntent brief (the content lane), find every group or cover that
 * carries a surfaceIntent (the surface lane), and later swap generated assets
 * into their nodes — url/id for content, style.background for surfaces.
 *
 * A "placeholder" is what wp_placeholder minted: an attachment whose filename
 * is x-pixel-<hex>.<gif|png>, stretched by block attributes. The brief lives on
 * the same node at attributes.metadata.imageIntent (wp-blocks R5). Both must be
 * present — a placeholder without a brief has nothing to generate from, and a
 * brief on a real photo is provenance, not a work order.
 *
 * A surface marker is metadata.surfaceIntent: a STRING naming the run's
 * dictionary asset id. Legal only on core/group (mechanism group_background)
 * and core/cover (mechanism cover). The scan never gets clever: an image node
 * inside a surface-carrying group is still a content slot.
 */
import type { BlockNode } from '../schemas.js';
import { ASPECT_RATIOS } from './gemini.js';

export interface PlaceholderRef {
  /** RFC 6901 pointer into the tree, e.g. /blocks/2/innerBlocks/1 */
  path: string;
  block_name: string;
  intent: string;
  url_attr: string;
  id_attr: string;
  url: string;
  id?: number;
  /** API-ready aspect ratio derived from the block's own aspectRatio. */
  aspect_ratio: string;
}

export type SurfaceMechanism = 'group_background' | 'cover';

export interface SurfaceRef {
  kind: 'surface';
  path: string;
  block_name: string;
  /** The dictionary asset id this node references (metadata.surfaceIntent). */
  asset_id: string;
  mechanism: SurfaceMechanism;
  /** The flat band underneath: the group's backgroundColor slug, or null. */
  reservation: string | null;
}

export interface ContentRef extends PlaceholderRef {
  kind: 'content';
}

export interface ScanResult {
  content: ContentRef[];
  surfaces: SurfaceRef[];
  errors: string[];
}

const PLACEHOLDER_URL = /\/x-pixel-[0-9a-f]{6,8}\.(gif|png)$/i;

/** Which attributes hold the image URL/id, per block. Default fits core/image
 *  and core/cover; core/media-text names its media differently. */
function attrNames(blockName: string): { url: string; id: string } {
  if (blockName === 'core/media-text') return { url: 'mediaUrl', id: 'mediaId' };
  return { url: 'url', id: 'id' };
}

/** "3/4" -> "3:4"; "1" -> "1:1"; anything the API does not accept -> 16:9. */
export function toApiAspect(attr: unknown): string {
  if (typeof attr === 'string' && attr.trim() !== '') {
    const mapped = attr.trim() === '1' ? '1:1' : attr.trim().replace('/', ':');
    if (ASPECT_RATIOS.has(mapped)) return mapped;
  }
  return '16:9';
}

/** Blocks whose background a surface may become, per mechanism. */
const SURFACE_BLOCKS: Record<string, SurfaceMechanism> = {
  'core/group': 'group_background',
  'core/cover': 'cover',
};

/**
 * ONE walk returning typed refs for both lanes. Content refs are exactly what
 * findPlaceholders always returned; surface refs are surfaceIntent markers on
 * groups and covers. A cover carrying both intent kinds is a schema error, not
 * a runtime surprise — it lands in errors and joins neither lane.
 */
export function scanRefs(blocks: BlockNode[]): ScanResult {
  const content: ContentRef[] = [];
  const surfaces: SurfaceRef[] = [];
  const errors: string[] = [];
  const walk = (nodes: BlockNode[], prefix: string): void => {
    nodes.forEach((node, i) => {
      const path = `${prefix}/${i}`;
      const attrs = (node.attributes ?? {}) as Record<string, unknown>;
      const meta = attrs.metadata as Record<string, unknown> | undefined;
      const intent = typeof meta?.imageIntent === 'string' ? meta.imageIntent.trim() : '';
      const surfaceIntent = typeof meta?.surfaceIntent === 'string' ? meta.surfaceIntent.trim() : '';
      const names = attrNames(node.name);
      const url = typeof attrs[names.url] === 'string' ? (attrs[names.url] as string) : '';
      const contentMatch = intent !== '' && PLACEHOLDER_URL.test(url);
      if (surfaceIntent !== '' && intent !== '') {
        errors.push(`${path}: carries both imageIntent and surfaceIntent — one intent kind per node`);
      } else if (surfaceIntent !== '') {
        const mechanism = SURFACE_BLOCKS[node.name];
        if (!mechanism) {
          errors.push(`${path}: surfaceIntent on ${node.name} — a surface lands only on core/group or core/cover`);
        } else {
          const reservation = typeof attrs.backgroundColor === 'string' ? attrs.backgroundColor : null;
          surfaces.push({ kind: 'surface', path, block_name: node.name, asset_id: surfaceIntent, mechanism, reservation });
        }
      } else if (contentMatch) {
        content.push({
          kind: 'content',
          path,
          block_name: node.name,
          intent,
          url_attr: names.url,
          id_attr: names.id,
          url,
          id: typeof attrs[names.id] === 'number' ? (attrs[names.id] as number) : undefined,
          aspect_ratio: toApiAspect(attrs.aspectRatio),
        });
      }
      if (Array.isArray(node.innerBlocks) && node.innerBlocks.length) walk(node.innerBlocks, `${path}/innerBlocks`);
    });
  };
  walk(blocks, '/blocks');
  return { content, surfaces, errors };
}

export function findPlaceholders(blocks: BlockNode[]): PlaceholderRef[] {
  return scanRefs(blocks).content.map(({ kind: _kind, ...ref }) => ref);
}

/** Resolve a /blocks/... pointer back to its node, or undefined. */
export function nodeAt(blocks: BlockNode[], path: string): BlockNode | undefined {
  const segs = path.split('/').filter(Boolean);
  if (segs[0] !== 'blocks') return undefined;
  let nodes: BlockNode[] | undefined = blocks;
  let node: BlockNode | undefined;
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg === 'innerBlocks') {
      nodes = node?.innerBlocks;
      continue;
    }
    const idx = Number(seg);
    if (!Number.isInteger(idx) || !nodes || !nodes[idx]) return undefined;
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
export function applyImage(blocks: BlockNode[], ref: PlaceholderRef, media: { id: number; url: string }): boolean {
  const node = nodeAt(blocks, ref.path);
  if (!node || node.name !== ref.block_name) return false;
  const attrs = (node.attributes ?? {}) as Record<string, unknown>;
  if (attrs[ref.url_attr] !== ref.url) return false;
  attrs[ref.url_attr] = media.url;
  attrs[ref.id_attr] = media.id;
  node.attributes = attrs;
  return true;
}

export interface SurfaceStyleOpts {
  class: 'field' | 'pattern' | 'frieze' | 'spot' | 'canvas';
  position?: string;
  size?: string;
}

interface SurfaceTargetRef {
  path: string;
  block_name: string;
  mechanism: SurfaceMechanism;
}

/** The exact style.background object per asset class — a genuine block
 *  support, visible in the core Background inspector panel. */
function backgroundFor(media: { id: number; url: string }, opts: SurfaceStyleOpts): Record<string, unknown> {
  const image = { backgroundImage: { url: media.url, id: media.id } };
  switch (opts.class) {
    case 'pattern':
      return { ...image, backgroundRepeat: 'repeat', backgroundSize: opts.size ?? 'auto' };
    case 'frieze':
      return { ...image, backgroundRepeat: 'repeat-x', backgroundPosition: opts.position ?? 'top', backgroundSize: opts.size ?? 'auto' };
    case 'spot':
      return { ...image, backgroundRepeat: 'no-repeat', backgroundPosition: opts.position ?? 'top right', backgroundSize: opts.size ?? 'auto' };
    default:
      return { ...image, backgroundSize: 'cover' };
  }
}

/**
 * Write a surface onto its target node. The refusal is the contract: a group
 * whose style.background.backgroundImage is no longer empty, or a cover whose
 * url is no longer empty, belongs to an admin now and is never overwritten —
 * the flat band underneath is the reservation and the fallback either way.
 * backgroundColor is NEVER touched.
 */
export function applySurface(
  blocks: BlockNode[],
  target: SurfaceTargetRef,
  media: { id: number; url: string },
  opts: SurfaceStyleOpts,
): boolean {
  const node = nodeAt(blocks, target.path);
  if (!node || node.name !== target.block_name) return false;
  const attrs = (node.attributes ?? {}) as Record<string, unknown>;
  if (target.mechanism === 'cover') {
    const url = attrs.url;
    if (typeof url === 'string' && url.trim() !== '' && !PLACEHOLDER_URL.test(url)) return false;
    attrs.url = media.url;
    attrs.id = media.id;
    node.attributes = attrs;
    return true;
  }
  const style = (attrs.style ?? {}) as Record<string, unknown>;
  const background = (style.background ?? {}) as Record<string, unknown>;
  const existing = background.backgroundImage as { url?: string } | string | undefined;
  const existingUrl = typeof existing === 'string' ? existing : existing?.url;
  if (typeof existingUrl === 'string' && existingUrl.trim() !== '') return false;
  style.background = backgroundFor(media, opts);
  attrs.style = style;
  node.attributes = attrs;
  return true;
}
