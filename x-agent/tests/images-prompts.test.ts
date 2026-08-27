import { describe, expect, it } from 'vitest';
import { aspectForClass, buildSurfacePrompt } from '../mcp/src/images/gemini.js';
import { emptyManifest, planSurfaceCalls, type ManifestV2 } from '../mcp/src/images/manifest.js';

describe('buildSurfacePrompt', () => {
  it('composes seed, class phrasing, exact hexes and the style line', () => {
    const p = buildSurfacePrompt(
      { class: 'field', prompt_seed: 'Woven linen, warm cream', hexes: ['#f5f0e8', '#e8e0d0'] },
      'Wabi-Sabi quietude',
    );
    expect(p).toContain('Woven linen, warm cream');
    expect(p).toContain('no focal point');
    expect(p).toContain('fills the entire frame edge to edge');
    expect(p).toContain('No objects, no scene, no room');
    expect(p).toContain('Palette: exactly these colors — #f5f0e8, #e8e0d0');
    expect(p).toContain('Material style: Wabi-Sabi quietude');
    expect(p).toContain('no text, no letters, no numerals');
    expect(p).not.toContain('..');
  });

  it('a surface prompt without its hexes is a bug', () => {
    expect(() => buildSurfacePrompt({ class: 'field', prompt_seed: 'Linen', hexes: [] })).toThrow(/hex/i);
  });

  it('spot prompts demand the key color ground', () => {
    const p = buildSurfacePrompt({ class: 'spot', prompt_seed: 'Filigree corner', hexes: ['#f5f0e8'], key_hex: '#00b140' });
    expect(p).toContain('solid uniform background of exactly #00b140');
  });

  it('ground-baked spots bake the band hex instead of the key color', () => {
    const p = buildSurfacePrompt({
      class: 'spot',
      prompt_seed: 'Filigree corner',
      hexes: ['#f5f0e8'],
      ground_baked: true,
      key_hex: '#00b140',
    });
    expect(p).toContain('solid uniform background of exactly #f5f0e8');
    expect(p).not.toContain('#00b140');
  });

  it('pattern and frieze phrasings demand tileability and continuity — and refuse pages and scenes', () => {
    expect(buildSurfacePrompt({ class: 'pattern', prompt_seed: 'Damask motif', hexes: ['#111'] })).toContain('repeating ornamental motif');
    const frieze = buildSurfacePrompt({ class: 'frieze', prompt_seed: 'Botanical band', hexes: ['#111'] });
    expect(frieze).toContain('continuous and uniform left to right');
    expect(frieze).toContain('no page, no document');
  });

  it('intensity shapes the prompt deterministically', () => {
    const whisper = buildSurfacePrompt({ class: 'field', prompt_seed: 'Plaster', hexes: ['#eee'], intensity: 'whisper' });
    const loud = buildSurfacePrompt({ class: 'field', prompt_seed: 'Plaster', hexes: ['#eee'], intensity: 'loud' });
    expect(whisper).toContain('faint');
    expect(loud).toContain('pronounced');
  });
});

describe('aspectForClass', () => {
  it('friezes are the widest the API offers, tiles are square', () => {
    expect(aspectForClass('frieze')).toBe('21:9');
    expect(aspectForClass('pattern')).toBe('1:1');
    expect(aspectForClass('spot')).toBe('1:1');
    expect(aspectForClass('field')).toBe('16:9');
    expect(aspectForClass('canvas')).toBe('16:9');
  });
});

describe('planSurfaceCalls', () => {
  const dictionary = [
    { id: 'linen-wash', class: 'field' as const, prompt_seed: 'Woven linen', hexes: ['#f5f0e8'] },
    { id: 'deco-frieze', class: 'frieze' as const, prompt_seed: 'Deco border', hexes: ['#111111'] },
  ];

  it('one call per unique asset with no manifest', () => {
    const plan = planSurfaceCalls(dictionary, null, () => true);
    expect(plan.generate.map((g) => g.id)).toEqual(['linen-wash', 'deco-frieze']);
    expect(plan.cached).toEqual([]);
  });

  it('assets already in the manifest with a file on disk are replayed, not re-bought', () => {
    const manifest: ManifestV2 = {
      ...emptyManifest('m'),
      surfaces: [
        {
          kind: 'surface',
          asset_id: 'linen-wash',
          class: 'field',
          file: '/tmp/asset-linen-wash.jpg',
          prompt: 'p',
          mime_type: 'image/jpeg',
          bytes: 1,
          ms: 1,
          post_processing: 'recompress',
          targets: [],
        },
      ],
    };
    const plan = planSurfaceCalls(dictionary, manifest, (f) => f === '/tmp/asset-linen-wash.jpg');
    expect(plan.generate.map((g) => g.id)).toEqual(['deco-frieze']);
    expect(plan.cached).toEqual(['linen-wash']);
  });

  it('a manifest entry whose file vanished is re-generated', () => {
    const manifest: ManifestV2 = {
      ...emptyManifest('m'),
      surfaces: [
        {
          kind: 'surface',
          asset_id: 'linen-wash',
          class: 'field',
          file: '/tmp/gone.jpg',
          prompt: 'p',
          mime_type: 'image/jpeg',
          bytes: 1,
          ms: 1,
          post_processing: 'recompress',
          targets: [],
        },
      ],
    };
    const plan = planSurfaceCalls(dictionary, manifest, () => false);
    expect(plan.generate.map((g) => g.id)).toEqual(['linen-wash', 'deco-frieze']);
    expect(plan.cached).toEqual([]);
  });
});
