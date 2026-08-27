import { describe, expect, it } from 'vitest';
import type { BlockNode } from '../mcp/src/schemas.js';
import { applySurface } from '../mcp/src/images/scan.js';
import type { ManifestSurfaceTarget } from '../mcp/src/images/manifest.js';

const MEDIA = { id: 42, url: 'http://x/wp-content/uploads/asset-linen-wash.jpg' };

function groupTarget(overrides: Partial<ManifestSurfaceTarget> = {}): ManifestSurfaceTarget {
  return {
    post_id: 5,
    rest_base: 'pages',
    path: '/blocks/0',
    block_name: 'core/group',
    mechanism: 'group_background',
    reservation: 'base',
    ...overrides,
  };
}

function groupTree(attributes: Record<string, unknown> = {}): BlockNode[] {
  return [
    {
      name: 'core/group',
      attributes: { backgroundColor: 'base', metadata: { surfaceIntent: 'linen-wash' }, ...attributes },
      innerBlocks: [{ name: 'core/paragraph', attributes: {} }],
    },
  ];
}

describe('applySurface — group backgrounds', () => {
  it('field: cover-sized skin; the backgroundColor reservation is never touched', () => {
    const blocks = groupTree();
    expect(applySurface(blocks, groupTarget(), MEDIA, { class: 'field' })).toBe(true);
    const attrs = blocks[0]!.attributes as Record<string, any>;
    expect(attrs.style.background).toEqual({
      backgroundImage: { url: MEDIA.url, id: MEDIA.id },
      backgroundSize: 'cover',
    });
    expect(attrs.backgroundColor).toBe('base');
  });

  it('pattern repeats, frieze repeats-x at an edge, spot sits positioned', () => {
    const p = groupTree();
    applySurface(p, groupTarget(), MEDIA, { class: 'pattern' });
    expect((p[0]!.attributes as any).style.background.backgroundRepeat).toBe('repeat');

    const f = groupTree();
    applySurface(f, groupTarget(), MEDIA, { class: 'frieze', position: 'bottom' });
    expect((f[0]!.attributes as any).style.background).toMatchObject({
      backgroundRepeat: 'repeat-x',
      backgroundPosition: 'bottom',
    });

    const s = groupTree();
    applySurface(s, groupTarget(), MEDIA, { class: 'spot', position: 'top right', size: '160px' });
    expect((s[0]!.attributes as any).style.background).toMatchObject({
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'top right',
      backgroundSize: '160px',
    });
  });

  it('merges into existing style without clobbering sibling keys', () => {
    const blocks = groupTree({ style: { spacing: { padding: { top: '2rem' } } } });
    expect(applySurface(blocks, groupTarget(), MEDIA, { class: 'field' })).toBe(true);
    const style = (blocks[0]!.attributes as any).style;
    expect(style.spacing.padding.top).toBe('2rem');
    expect(style.background.backgroundImage.url).toBe(MEDIA.url);
  });

  it("refuses a target that already carries someone's background image", () => {
    const blocks = groupTree({ style: { background: { backgroundImage: { url: 'http://x/admins-own.jpg' } } } });
    expect(applySurface(blocks, groupTarget(), MEDIA, { class: 'field' })).toBe(false);
    expect((blocks[0]!.attributes as any).style.background.backgroundImage.url).toBe('http://x/admins-own.jpg');
  });

  it('refuses a node whose block name drifted since the scan', () => {
    const blocks: BlockNode[] = [{ name: 'core/columns', attributes: {} }];
    expect(applySurface(blocks, groupTarget(), MEDIA, { class: 'field' })).toBe(false);
  });
});

describe('applySurface — covers', () => {
  function coverTree(attributes: Record<string, unknown> = {}): BlockNode[] {
    return [
      {
        name: 'core/cover',
        attributes: { overlayColor: 'contrast', dimRatio: 80, metadata: { surfaceIntent: 'damask-field' }, ...attributes },
      },
    ];
  }

  const coverTarget = (): ManifestSurfaceTarget =>
    groupTarget({ block_name: 'core/cover', mechanism: 'cover', reservation: null });

  it('writes url and id, leaving the authored veil alone', () => {
    const blocks = coverTree();
    expect(applySurface(blocks, coverTarget(), MEDIA, { class: 'pattern' })).toBe(true);
    const attrs = blocks[0]!.attributes as Record<string, any>;
    expect(attrs.url).toBe(MEDIA.url);
    expect(attrs.id).toBe(MEDIA.id);
    expect(attrs.overlayColor).toBe('contrast');
    expect(attrs.dimRatio).toBe(80);
  });

  it('refuses a cover that already shows a real image', () => {
    const blocks = coverTree({ url: 'http://x/admins-hero.jpg' });
    expect(applySurface(blocks, coverTarget(), MEDIA, { class: 'pattern' })).toBe(false);
    expect((blocks[0]!.attributes as any).url).toBe('http://x/admins-hero.jpg');
  });
});
