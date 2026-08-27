import { afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { computeKeyHex, processAsset, textureBoundFor, veilFor, type PageProvider } from '../mcp/src/images/process.js';

const browser: Browser | null = await chromium.launch().catch(() => null);

afterAll(async () => {
  await browser?.close();
});

function provider(): PageProvider {
  return { page: async () => browser!.newPage() };
}

/** Build a deterministic test image in the browser itself: quadrant colors so
 *  mirror symmetry is checkable, or an ornament on a key-color ground. */
async function makePng(draw: 'quadrants' | 'spot', keyHex: string | null, size = 8): Promise<Buffer> {
  const page: Page = await browser!.newPage();
  try {
    await page.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; };').catch(() => {});
    const b64 = await page.evaluate(
      ({ kind, key, n }: { kind: string; key: string | null; n: number }) => {
        const canvas = document.createElement('canvas');
        canvas.width = n;
        canvas.height = n;
        const g = canvas.getContext('2d')!;
        if (kind === 'quadrants') {
          g.fillStyle = '#d94141'; g.fillRect(0, 0, n / 2, n / 2);
          g.fillStyle = '#41d95a'; g.fillRect(n / 2, 0, n / 2, n / 2);
          g.fillStyle = '#4157d9'; g.fillRect(0, n / 2, n / 2, n / 2);
          g.fillStyle = '#d9c341'; g.fillRect(n / 2, n / 2, n / 2, n / 2);
        } else {
          g.fillStyle = key!; g.fillRect(0, 0, n, n);
          g.fillStyle = '#8b1a1a'; g.fillRect(n / 4, n / 4, n / 2, n / 2);
        }
        const u = canvas.toDataURL('image/png');
        return u.slice(u.indexOf(',') + 1);
      },
      { kind: draw, key: keyHex, n: size },
    );
    return Buffer.from(b64, 'base64');
  } finally {
    await page.close();
  }
}

/** Decode PNG bytes back to raw RGBA via a canvas readback. */
async function decodePixels(bytes: Buffer, mime: string): Promise<{ w: number; h: number; px: number[] }> {
  const page: Page = await browser!.newPage();
  try {
    await page.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; };').catch(() => {});
    return await page.evaluate(async (dataUrl: string) => {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('decode failed'));
        img.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const g = canvas.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, canvas.width, canvas.height);
      return { w: canvas.width, h: canvas.height, px: Array.from(data.data) };
    }, `data:${mime};base64,${bytes.toString('base64')}`);
  } finally {
    await page.close();
  }
}

describe.skipIf(!browser)('computeKeyHex', () => {
  it('picks the candidate farthest from the palette, stably', () => {
    const key = computeKeyHex(['#ffffff', '#f5f0e8', '#333333']);
    expect(key).toBe(computeKeyHex(['#ffffff', '#f5f0e8', '#333333']));
    expect(['#00b140', '#ff00ff', '#00ffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00']).toContain(key);
  });
});

describe.skipIf(!browser)('processAsset', () => {
  it('mirror-tiles a pattern 2x2 — seams impossible by construction, byte-asserted on the pixel rows', async () => {
    const input = await makePng('quadrants', null);
    const result = await processAsset(provider(), input, 'image/png', { class: 'pattern' });
    expect(result.post_processing).toBe('mirror-tile');
    expect(result.mime_type).toBe('image/png');
    const { w, h, px } = await decodePixels(result.bytes, result.mime_type);
    expect(w).toBe(16);
    expect(h).toBe(16);
    const pixel = (x: number, y: number) => px.slice((y * w + x) * 4, (y * w + x) * 4 + 4);
    for (let y = 0; y < h; y++) {
      expect(pixel(0, y)).toEqual(pixel(w - 1, y));
    }
    for (let x = 0; x < w; x++) {
      expect(pixel(x, 0)).toEqual(pixel(x, h - 1));
    }
  }, 30000);

  it('chroma-keys a spot to real alpha and leaves the ornament opaque over any band', async () => {
    const key = '#00b140';
    const input = await makePng('spot', key);
    const result = await processAsset(provider(), input, 'image/png', { class: 'spot', key_hex: key });
    expect(result.post_processing).toBe('chroma-key');
    expect(result.mime_type).toBe('image/png');
    const { w, px } = await decodePixels(result.bytes, result.mime_type);
    const alphaAt = (x: number, y: number) => px[(y * w + x) * 4 + 3];
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(w - 1, 0)).toBe(0);
    expect(alphaAt(w / 2, w / 2)).toBe(255);
  }, 30000);

  it('recompresses fields to JPEG and measures the luminance range', async () => {
    const input = await makePng('quadrants', null);
    const result = await processAsset(provider(), input, 'image/png', { class: 'field' });
    expect(result.post_processing).toBe('recompress');
    expect(result.mime_type).toBe('image/jpeg');
    expect(result.lum_min).toBeGreaterThanOrEqual(0);
    expect(result.lum_max).toBeLessThanOrEqual(1);
    expect(result.lum_max).toBeGreaterThan(result.lum_min);
  }, 30000);

  it('identical input bytes produce identical output bytes', async () => {
    const input = await makePng('quadrants', null);
    const a = await processAsset(provider(), input, 'image/png', { class: 'pattern' });
    const b = await processAsset(provider(), input, 'image/png', { class: 'pattern' });
    expect(a.bytes.equals(b.bytes)).toBe(true);
    expect(a.lum_min).toBe(b.lum_min);
    expect(a.lum_max).toBe(b.lum_max);
  }, 30000);

  it('the veil collapses a wild luminance range toward the band hex — a whisper actually whispers', async () => {
    const input = await makePng('quadrants', null); // high-contrast quadrants
    const bare = await processAsset(provider(), input, 'image/png', { class: 'field' });
    const veiled = await processAsset(provider(), input, 'image/png', {
      class: 'field',
      veil: { hex: '#F6EFE6', alpha: 0.85 },
    });
    expect(bare.lum_max - bare.lum_min).toBeGreaterThan(0.3);
    expect(veiled.lum_max - veiled.lum_min).toBeLessThan(0.2);
    expect(veiled.lum_min).toBeGreaterThan(0.4); // pulled toward the light band
    // Determinism holds through the veil.
    const again = await processAsset(provider(), input, 'image/png', {
      class: 'field',
      veil: { hex: '#F6EFE6', alpha: 0.85 },
    });
    expect(veiled.bytes.equals(again.bytes)).toBe(true);
  }, 30000);
});

describe('the texture bound and the veil policy (pure)', () => {
  it('bounds tighten with intensity for grounds; friezes get slack; spots are unbounded', () => {
    expect(textureBoundFor('field', 'whisper')).toBe(0.2);
    expect(textureBoundFor('pattern', 'present')).toBe(0.4);
    expect(textureBoundFor('canvas', 'loud')).toBe(0.6);
    expect(textureBoundFor('frieze', 'whisper')).toBe(0.7);
    expect(textureBoundFor('spot', 'present')).toBeNull();
  });

  it('grounds are veiled with the band hex; edges and ornaments are not', () => {
    expect(veilFor('field', 'whisper', '#F6EFE6')).toEqual({ hex: '#F6EFE6', alpha: 0.85 });
    expect(veilFor('pattern', 'present', '#3B2A1E')).toEqual({ hex: '#3B2A1E', alpha: 0.7 });
    expect(veilFor('canvas', undefined, '#fff')).toEqual({ hex: '#fff', alpha: 0.7 });
    expect(veilFor('frieze', 'present', '#F6EFE6')).toBeNull();
    expect(veilFor('spot', 'whisper', '#F6EFE6')).toBeNull();
    expect(veilFor('field', 'whisper', undefined)).toBeNull();
  });
});
