import { describe, expect, it } from 'vitest';
import type { BlockNode } from '../mcp/src/schemas.js';
import { buildImagePrompt } from '../mcp/src/images/gemini.js';
import { applyImage, findPlaceholders, nodeAt, scanRefs, toApiAspect } from '../mcp/src/images/scan.js';

const PIXEL = 'http://127.0.0.1:9400/wp-content/uploads/2026/08/x-pixel-d9a441.gif';

function tree(): BlockNode[] {
  return [
    {
      name: 'core/group',
      innerBlocks: [
        {
          name: 'core/image',
          attributes: {
            id: 6,
            url: PIXEL,
            aspectRatio: '3/4',
            metadata: { imageIntent: 'The red windmill at dusk.' },
          },
        },
        {
          name: 'core/image',
          attributes: { id: 9, url: 'http://x/real-photo.jpg', metadata: { imageIntent: 'provenance only' } },
        },
        {
          name: 'core/image',
          attributes: { id: 10, url: PIXEL },
        },
      ],
    },
    {
      name: 'core/media-text',
      attributes: { mediaId: 7, mediaUrl: PIXEL.replace('.gif', '.png'), metadata: { imageIntent: 'Dancers mid-kick.' } },
    },
  ];
}

describe('findPlaceholders', () => {
  it('finds only placeholder+intent pairs, with per-block attr names', () => {
    const refs = findPlaceholders(tree());
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      path: '/blocks/0/innerBlocks/0',
      block_name: 'core/image',
      url_attr: 'url',
      id_attr: 'id',
      aspect_ratio: '3:4',
    });
    expect(refs[1]).toMatchObject({
      path: '/blocks/1',
      block_name: 'core/media-text',
      url_attr: 'mediaUrl',
      id_attr: 'mediaId',
      aspect_ratio: '16:9',
    });
  });

  it('skips real photos and intent-less placeholders', () => {
    const paths = findPlaceholders(tree()).map((r) => r.path);
    expect(paths).not.toContain('/blocks/0/innerBlocks/1');
    expect(paths).not.toContain('/blocks/0/innerBlocks/2');
  });
});

describe('scanRefs', () => {
  function surfaceTree(): BlockNode[] {
    return [
      {
        name: 'core/group',
        attributes: {
          backgroundColor: 'base',
          metadata: { surfaceIntent: 'linen-wash' },
        },
        innerBlocks: [
          {
            name: 'core/image',
            attributes: {
              id: 6,
              url: PIXEL,
              metadata: { imageIntent: 'The red windmill at dusk.' },
            },
          },
          { name: 'core/paragraph', attributes: {} },
        ],
      },
      {
        name: 'core/cover',
        attributes: {
          overlayColor: 'contrast',
          dimRatio: 80,
          metadata: { surfaceIntent: 'damask-field' },
        },
      },
    ];
  }

  it('returns typed refs from one parse — surface and content, image inside surface group included', () => {
    const { content, surfaces, errors } = scanRefs(surfaceTree());
    expect(errors).toHaveLength(0);
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      kind: 'content',
      path: '/blocks/0/innerBlocks/0',
      block_name: 'core/image',
    });
    expect(surfaces).toHaveLength(2);
    expect(surfaces[0]).toMatchObject({
      kind: 'surface',
      path: '/blocks/0',
      block_name: 'core/group',
      asset_id: 'linen-wash',
      mechanism: 'group_background',
      reservation: 'base',
    });
    expect(surfaces[1]).toMatchObject({
      kind: 'surface',
      path: '/blocks/1',
      block_name: 'core/cover',
      asset_id: 'damask-field',
      mechanism: 'cover',
      reservation: null,
    });
  });

  it('matches findPlaceholders on the content lane of a surface-free tree', () => {
    const { content, surfaces } = scanRefs(tree());
    expect(surfaces).toHaveLength(0);
    expect(content.map((r) => r.path)).toEqual(findPlaceholders(tree()).map((r) => r.path));
  });

  it('rejects a cover carrying both intent kinds — one intent per cover', () => {
    const blocks: BlockNode[] = [
      {
        name: 'core/cover',
        attributes: {
          url: PIXEL,
          metadata: { imageIntent: 'A hero photo.', surfaceIntent: 'damask-field' },
        },
      },
    ];
    const { content, surfaces, errors } = scanRefs(blocks);
    expect(content).toHaveLength(0);
    expect(surfaces).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('/blocks/0');
    expect(errors[0]).toContain('one intent kind');
  });

  it('ignores surfaceIntent on blocks that are not group or cover', () => {
    const blocks: BlockNode[] = [
      { name: 'core/paragraph', attributes: { metadata: { surfaceIntent: 'linen-wash' } } },
    ];
    const { surfaces, errors } = scanRefs(blocks);
    expect(surfaces).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('core/paragraph');
  });
});

describe('toApiAspect', () => {
  it('maps attribute ratios to API ratios', () => {
    expect(toApiAspect('3/4')).toBe('3:4');
    expect(toApiAspect('16/9')).toBe('16:9');
    expect(toApiAspect('1')).toBe('1:1');
  });
  it('falls back to 16:9 for anything the API refuses', () => {
    expect(toApiAspect('7/5')).toBe('16:9');
    expect(toApiAspect(undefined)).toBe('16:9');
  });
});

describe('applyImage', () => {
  it('swaps url and id on the exact node, keeping the intent', () => {
    const blocks = tree();
    const [ref] = findPlaceholders(blocks);
    expect(applyImage(blocks, ref!, { id: 42, url: 'http://x/real.jpg' })).toBe(true);
    const node = nodeAt(blocks, ref!.path)!;
    expect(node.attributes).toMatchObject({ id: 42, url: 'http://x/real.jpg' });
    expect((node.attributes as any).metadata.imageIntent).toBe('The red windmill at dusk.');
  });

  it('refuses a node whose url changed since the scan', () => {
    const blocks = tree();
    const [ref] = findPlaceholders(blocks);
    const node = nodeAt(blocks, ref!.path)!;
    (node.attributes as any).url = 'http://x/someone-elses-photo.jpg';
    expect(applyImage(blocks, ref!, { id: 42, url: 'http://x/real.jpg' })).toBe(false);
    expect((node.attributes as any).url).toBe('http://x/someone-elses-photo.jpg');
  });
});

describe('buildImagePrompt', () => {
  it('composes intent, style and the constraints line', () => {
    const p = buildImagePrompt('A windmill.', 'Belle Époque lithograph');
    expect(p).toContain('A windmill.');
    expect(p).toContain('Style: Belle Époque lithograph');
    expect(p).toContain('No text, no watermarks');
    expect(p).not.toContain('..');
  });
  it('does not force a medium', () => {
    expect(buildImagePrompt('A poster-style illustration.')).not.toContain('Photographic');
  });
});
