import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST_SCHEMA_VERSION,
  emptyManifest,
  loadManifest,
  mergeManifest,
  saveManifest,
  type ManifestContentEntry,
  type ManifestSurfaceEntry,
  type ManifestV2,
} from '../mcp/src/images/manifest.js';

function contentEntry(overrides: Partial<ManifestContentEntry> = {}): ManifestContentEntry {
  return {
    kind: 'content',
    post_id: 5,
    rest_base: 'pages',
    path: '/blocks/0',
    block_name: 'core/image',
    intent: 'The red windmill at dusk.',
    url_attr: 'url',
    id_attr: 'id',
    url: 'http://x/x-pixel-d9a441.gif',
    aspect_ratio: '3:4',
    file: '/tmp/img-1.jpg',
    prompt: 'The red windmill at dusk. No text.',
    mime_type: 'image/jpeg',
    bytes: 100,
    ms: 5,
    ...overrides,
  };
}

function surfaceEntry(overrides: Partial<ManifestSurfaceEntry> = {}): ManifestSurfaceEntry {
  return {
    kind: 'surface',
    asset_id: 'linen-wash',
    class: 'field',
    file: '/tmp/asset-linen-wash.jpg',
    prompt: 'Woven linen texture. Palette: #f5f0e8.',
    mime_type: 'image/jpeg',
    bytes: 200,
    ms: 7,
    post_processing: 'recompress',
    targets: [
      { post_id: 5, rest_base: 'pages', path: '/blocks/0', block_name: 'core/group', mechanism: 'group_background', reservation: 'base' },
    ],
    ...overrides,
  };
}

describe('manifest v2', () => {
  it('round-trips through save and load with the schema version stamped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-manifest-'));
    const path = join(dir, 'images-manifest.json');
    const m: ManifestV2 = {
      ...emptyManifest('gemini-test', 'Style line'),
      content: [contentEntry()],
      surfaces: [surfaceEntry()],
    };
    saveManifest(path, m);
    const back = loadManifest(path);
    expect(back.schema_version).toBe(MANIFEST_SCHEMA_VERSION);
    expect(back).toEqual(m);
  });

  it('migrates a v1 manifest file into typed content entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-manifest-'));
    const path = join(dir, 'images-manifest.json');
    const v1 = {
      post_id: 5,
      rest_base: 'pages',
      model: 'gemini-test',
      style: 'Style line',
      images: [
        {
          path: '/blocks/0',
          block_name: 'core/image',
          intent: 'The red windmill at dusk.',
          url_attr: 'url',
          id_attr: 'id',
          url: 'http://x/x-pixel-d9a441.gif',
          aspect_ratio: '3:4',
          file: '/tmp/img-1.jpg',
          prompt: 'The red windmill at dusk. No text.',
          mime_type: 'image/jpeg',
          bytes: 100,
          ms: 5,
        },
      ],
    };
    writeFileSync(path, JSON.stringify(v1));
    const m = loadManifest(path);
    expect(m.schema_version).toBe(MANIFEST_SCHEMA_VERSION);
    expect(m.surfaces).toEqual([]);
    expect(m.content).toHaveLength(1);
    expect(m.content[0]).toMatchObject({ kind: 'content', post_id: 5, rest_base: 'pages', path: '/blocks/0' });
  });

  it('merges content by (post_id, path) — same slot replaced, other posts kept', () => {
    const a: ManifestV2 = { ...emptyManifest('m'), content: [contentEntry(), contentEntry({ post_id: 6, file: '/tmp/other.jpg' })], surfaces: [] };
    const b: ManifestV2 = { ...emptyManifest('m'), content: [contentEntry({ file: '/tmp/img-2.jpg' })], surfaces: [] };
    const merged = mergeManifest(a, b);
    expect(merged.content).toHaveLength(2);
    expect(merged.content.find((c) => c.post_id === 5)?.file).toBe('/tmp/img-2.jpg');
    expect(merged.content.find((c) => c.post_id === 6)?.file).toBe('/tmp/other.jpg');
  });

  it('merges surfaces by asset_id — one file, targets unioned without duplicates', () => {
    const a: ManifestV2 = { ...emptyManifest('m'), content: [], surfaces: [surfaceEntry()] };
    const b: ManifestV2 = {
      ...emptyManifest('m'),
      content: [],
      surfaces: [
        surfaceEntry({
          targets: [
            { post_id: 5, rest_base: 'pages', path: '/blocks/0', block_name: 'core/group', mechanism: 'group_background', reservation: 'base' },
            { post_id: 7, rest_base: 'pages', path: '/blocks/2', block_name: 'core/group', mechanism: 'group_background', reservation: 'surface' },
          ],
        }),
      ],
    };
    const merged = mergeManifest(a, b);
    expect(merged.surfaces).toHaveLength(1);
    expect(merged.surfaces[0]!.targets).toHaveLength(2);
  });

  it('merge with null existing returns the incoming manifest', () => {
    const b: ManifestV2 = { ...emptyManifest('m'), content: [contentEntry()], surfaces: [] };
    expect(mergeManifest(null, b)).toEqual(b);
  });
});
