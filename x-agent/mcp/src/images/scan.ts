/**
 * Pure tree work for the image pass: find every placeholder image that carries
 * an imageIntent brief, and later swap a generated asset into its node.
 *
 * A "placeholder" is what wp_placeholder minted: an attachment whose filename
 * is x-pixel-<hex>.<gif|png>, stretched by block attributes. The brief lives on
 * the same node at attributes.metadata.imageIntent (wp-blocks R5). Both must be
 * present — a placeholder without a brief has nothing to generate from, and a
 * brief on a real photo is provenance, not a work order.
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

export function findPlaceholders(blocks: BlockNode[]): PlaceholderRef[] {
  const out: PlaceholderRef[] = [];
  const walk = (nodes: BlockNode[], prefix: string): void => {
    nodes.forEach((node, i) => {
      const path = `${prefix}/${i}`;
      const attrs = (node.attributes ?? {}) as Record<string, unknown>;
      const meta = attrs.metadata as Record<string, unknown> | undefined;
      const intent = typeof meta?.imageIntent === 'string' ? meta.imageIntent.trim() : '';
      const names = attrNames(node.name);
      const url = typeof attrs[names.url] === 'string' ? (attrs[names.url] as string) : '';
      if (intent !== '' && PLACEHOLDER_URL.test(url)) {
        out.push({
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
  return out;
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
