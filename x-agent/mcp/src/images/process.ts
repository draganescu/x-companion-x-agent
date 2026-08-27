/**
 * The deterministic processing station: between generate and upload, every
 * surface asset passes through canvas 2D in the warm Chromium the MCP already
 * drives. The model is never trusted with seamlessness or alpha — it can only
 * return opaque JPEG (the API's one response format), so code manufactures
 * both:
 *
 *   ORNAMENT classes (pattern, frieze, true-alpha spot) are generated on a
 *   computed chroma key and KNOCKED OUT to real alpha: a soft tolerance ramp
 *   (no halo fringes), edge de-contamination (the key's share of every
 *   partially-transparent pixel is mathematically removed), and INTENSITY
 *   BAKED AS ALPHA — a whisper damask is the same damask at 25% opacity over
 *   the band's own flat color, so the ground under text stays the reservation
 *   itself. Patterns are then mirror-tiled 2x2 (seams impossible by
 *   construction) and everything with alpha ships lossless PNG.
 *
 *   GROUND classes (field, canvas) have nothing to knock out — a photographic
 *   wash keeps the veil: the band hex composited over it at intensity-scaled
 *   opacity, then JPEG.
 *
 * Measurement matches rendering: an alpha asset is measured as its COMPOSITE
 * over the band hex it will actually sit on, so the texture bound rates what
 * the visitor sees. No randomness anywhere: identical input bytes produce
 * identical output bytes.
 */
import type { SurfaceClass } from './gemini.js';

/** The sliver of a Playwright Page the station needs — structural, so both the
 *  warm HarnessSession and a bare test browser satisfy it. */
export interface CanvasPage {
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface PageProvider {
  page(opts?: { fresh?: boolean }): Promise<CanvasPage>;
}

export interface ProcessResult {
  bytes: Buffer;
  mime_type: string;
  /** The exact chain applied, e.g. 'chroma-key+mirror-tile+alpha(0.25)'. */
  post_processing: string;
  /** Measured relative-luminance range (0..1) — of the COMPOSITE over the
   *  band hex for alpha assets, of the visible pixels otherwise. */
  lum_min: number;
  lum_max: number;
}

/** JPEG quality for the ground classes; everything with alpha ships PNG. */
const JPEG_QUALITY: Partial<Record<SurfaceClass, number>> = {
  field: 0.8,
  canvas: 0.8,
  frieze: 0.85,
};

/** The soft knockout ramp: fully transparent inside NEAR, fully opaque past
 *  FAR, smooth in between — hard cutoffs leave key-colored halos on fine
 *  linework (the gilt-filigree field bug). */
const CHROMA_NEAR = 30;
const CHROMA_FAR = 90;

/**
 * Intensity is a PIXEL OPERATION, not a vocabulary word.
 * Ground classes (field/canvas): the band hex is composited OVER the wash at
 * intensity-scaled opacity (the veil), collapsing its luminance toward the
 * band. Ornament classes: the ornament's own alpha is SCALED, so the band —
 * the reservation itself — stays the ground under everything.
 */
export const VEIL_ALPHA: Record<string, number> = {
  whisper: 0.85,
  present: 0.7,
  loud: 0.5,
};

const VEILED_CLASSES = new Set<SurfaceClass>(['field', 'canvas']);

export function veilFor(cls: SurfaceClass, intensity: string | undefined, bandHex: string | undefined): { hex: string; alpha: number } | null {
  if (!VEILED_CLASSES.has(cls) || !bandHex) return null;
  const alpha = VEIL_ALPHA[intensity ?? 'present'] ?? VEIL_ALPHA.present!;
  return { hex: bandHex, alpha };
}

/** Ornament opacity per class and intensity — a whisper actually whispers. */
export const ORNAMENT_ALPHA: Record<string, Record<string, number>> = {
  pattern: { whisper: 0.25, present: 0.5, loud: 0.8 },
  frieze: { whisper: 0.45, present: 0.7, loud: 1 },
  spot: { whisper: 0.5, present: 0.85, loud: 1 },
};

export function alphaScaleFor(cls: SurfaceClass, intensity: string | undefined): number | null {
  const map = ORNAMENT_ALPHA[cls];
  if (!map) return null;
  return map[intensity ?? 'present'] ?? map.present!;
}

/**
 * Deterministic taming: an ornament whose composite range exceeds its bound is
 * not re-bought — its alpha is trimmed on the SAME bytes until the bound holds
 * (composite range scales ~linearly with ornament opacity). Intensity is the
 * ceiling; the bound is the law. Below the floor the ornament would be
 * invisible — that is a reject (the raw was never a material), not a whisper.
 */
export function tamedAlpha(alpha: number, measuredRange: number, bound: number, floor = 0.08): number | null {
  if (measuredRange <= bound) return alpha;
  const tamed = Math.floor(alpha * (bound / measuredRange) * 0.95 * 100) / 100;
  return tamed >= floor ? tamed : null;
}

/**
 * The texture bound: how wide the measured luminance range may be, per class
 * and intensity — measured on the COMPOSITE for alpha assets, so it rates
 * exactly what renders. A "field" that came back as a photograph of a room
 * reads 0..1 and is mechanically detectable as not-a-material.
 * null = unbounded (a full-opacity spot is punctuation, not a ground).
 */
export function textureBoundFor(cls: SurfaceClass, intensity: string | undefined): number | null {
  if (cls === 'spot') return null;
  // Friezes are edge ornament, not grounds under text: the bound only has to
  // refuse scenes and documents — those read essentially 0..1.
  if (cls === 'frieze') return 0.85;
  const bounds: Record<string, number> = { whisper: 0.2, present: 0.4, loud: 0.6 };
  return bounds[intensity ?? 'present'] ?? bounds.present!;
}

/**
 * The chroma key an ornament is generated on: the candidate farthest from
 * every palette color, so the knockout can never eat the ornament itself.
 * Pure and stable — the chosen hex is recorded in the manifest.
 */
export function computeKeyHex(paletteHexes: string[]): string {
  const candidates = ['#00b140', '#ff00ff', '#00ffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#000000', '#ffffff'];
  const parse = (hex: string): [number, number, number] => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  };
  const palette = paletteHexes.map(parse);
  let best = candidates[0]!;
  let bestScore = -1;
  for (const candidate of candidates) {
    const c = parse(candidate);
    const score = palette.length
      ? Math.min(...palette.map((p) => Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2])))
      : 255;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

interface InPageResult {
  out?: string;
  mime?: string;
  lumMin?: number;
  lumMax?: number;
  error?: string;
}

export interface ProcessOpts {
  class: SurfaceClass;
  /** Knock the key-color ground out to alpha (ornament classes). */
  key_hex?: string;
  /** Composite the band hex OVER the asset (ground classes). */
  veil?: { hex: string; alpha: number } | null;
  /** Scale the ornament's alpha — intensity baked into the pixels. */
  alpha_scale?: number | null;
  /** Measure the composite over this hex instead of the raw pixels. */
  composite_hex?: string | null;
  /** Force lossless output (e.g. a ground-baked spot must keep its exact hex). */
  force_png?: boolean;
}

export async function processAsset(
  session: PageProvider,
  input: Buffer,
  inputMime: string,
  opts: ProcessOpts,
): Promise<ProcessResult> {
  const page = await session.page({ fresh: true });
  try {
    // Same dev-runtime shim the oracle installs: tsx/esbuild keepNames rewrites
    // arrow consts through a module-scoped __name helper the page lacks.
    await page.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; };').catch(() => {});
    const payload = {
      dataUrl: `data:${inputMime};base64,${input.toString('base64')}`,
      cls: opts.class,
      keyHex: opts.key_hex ?? null,
      veil: opts.veil ?? null,
      alphaScale: opts.alpha_scale ?? null,
      compositeHex: opts.composite_hex ?? null,
      forcePng: opts.force_png === true,
      quality: JPEG_QUALITY[opts.class] ?? 0.85,
      near: CHROMA_NEAR,
      far: CHROMA_FAR,
    };
    const raw = (await page.evaluate(async (p: typeof payload) => {
      try {
        const parseHex = (hex: string): [number, number, number] => {
          const h = hex.replace('#', '');
          const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
          return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
        };
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('image failed to decode'));
          img.src = p.dataUrl;
        });
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) return { error: 'decoded image has no pixels' };

        let canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0);

        // 1. Knockout: soft tolerance ramp + de-contamination. A pixel at
        //    distance d from the key is alpha = smoothstep(near, far, d); its
        //    color is un-mixed from the key ground (c = a*ornament + (1-a)*key
        //    solved for ornament), so edges carry no key-colored fringe.
        if (p.keyHex) {
          const [kr, kg, kb] = parseHex(p.keyHex);
          const g = canvas.getContext('2d')!;
          const data = g.getImageData(0, 0, canvas.width, canvas.height);
          const px = data.data;
          for (let i = 0; i < px.length; i += 4) {
            const dr = px[i]! - kr;
            const dg = px[i + 1]! - kg;
            const db = px[i + 2]! - kb;
            const d = Math.sqrt(dr * dr + dg * dg + db * db);
            let a = (d - p.near) / (p.far - p.near);
            a = a < 0 ? 0 : a > 1 ? 1 : a;
            a = a * a * (3 - 2 * a); // smoothstep
            if (a === 0) {
              px[i + 3] = 0;
            } else if (a < 1) {
              px[i] = Math.max(0, Math.min(255, Math.round((px[i]! - (1 - a) * kr) / a)));
              px[i + 1] = Math.max(0, Math.min(255, Math.round((px[i + 1]! - (1 - a) * kg) / a)));
              px[i + 2] = Math.max(0, Math.min(255, Math.round((px[i + 2]! - (1 - a) * kb) / a)));
              px[i + 3] = Math.round(px[i + 3]! * a);
            }
          }
          g.putImageData(data, 0, 0);
        }

        // 2. Patterns mirror-tile AFTER the knockout, alpha preserved.
        if (p.cls === 'pattern') {
          const sheet = document.createElement('canvas');
          sheet.width = 2 * canvas.width;
          sheet.height = 2 * canvas.height;
          const g = sheet.getContext('2d')!;
          g.drawImage(canvas, 0, 0);
          g.save(); g.scale(-1, 1); g.drawImage(canvas, -sheet.width, 0); g.restore();
          g.save(); g.scale(1, -1); g.drawImage(canvas, 0, -sheet.height); g.restore();
          g.save(); g.scale(-1, -1); g.drawImage(canvas, -sheet.width, -sheet.height); g.restore();
          canvas = sheet;
        }

        // 3. The veil (ground classes): band hex OVER the wash.
        if (p.veil) {
          const g = canvas.getContext('2d')!;
          g.globalAlpha = p.veil.alpha;
          g.fillStyle = p.veil.hex;
          g.fillRect(0, 0, canvas.width, canvas.height);
          g.globalAlpha = 1;
        }

        // 4. Intensity as ornament opacity: scale the alpha channel whole.
        if (p.alphaScale !== null && p.alphaScale < 1) {
          const g = canvas.getContext('2d')!;
          const data = g.getImageData(0, 0, canvas.width, canvas.height);
          const px = data.data;
          for (let i = 3; i < px.length; i += 4) {
            px[i] = Math.round(px[i]! * p.alphaScale);
          }
          g.putImageData(data, 0, 0);
        }

        // 5. Measure what RENDERS: the composite over the band hex for alpha
        //    assets, the visible pixels otherwise.
        let measured = canvas;
        if (p.compositeHex) {
          const comp = document.createElement('canvas');
          comp.width = canvas.width;
          comp.height = canvas.height;
          const g = comp.getContext('2d')!;
          g.fillStyle = p.compositeHex;
          g.fillRect(0, 0, comp.width, comp.height);
          g.drawImage(canvas, 0, 0);
          measured = comp;
        }
        const px = measured.getContext('2d')!.getImageData(0, 0, measured.width, measured.height).data;
        let lumMin = 1;
        let lumMax = 0;
        let seen = false;
        const lin = (v: number): number => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        for (let i = 0; i < px.length; i += 16) {
          if (px[i + 3] === 0) continue;
          const lum = 0.2126 * lin(px[i]!) + 0.7152 * lin(px[i + 1]!) + 0.0722 * lin(px[i + 2]!);
          if (lum < lumMin) lumMin = lum;
          if (lum > lumMax) lumMax = lum;
          seen = true;
        }
        if (!seen) { lumMin = 0; lumMax = 1; }

        const usePng = p.forcePng || p.keyHex !== null || p.cls === 'pattern' || p.cls === 'spot';
        const dataUrl = usePng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', p.quality);
        return {
          out: dataUrl.slice(dataUrl.indexOf(',') + 1),
          mime: usePng ? 'image/png' : 'image/jpeg',
          lumMin: Math.round(lumMin * 1000) / 1000,
          lumMax: Math.round(lumMax * 1000) / 1000,
        };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }, payload)) as InPageResult;
    if (raw.error || !raw.out) {
      throw new Error(`asset post-processing failed: ${raw.error ?? 'no output'}`);
    }
    const chain = [
      opts.key_hex ? 'chroma-key' : null,
      opts.class === 'pattern' ? 'mirror-tile' : null,
      opts.veil ? `veil(${opts.veil.hex}@${opts.veil.alpha})` : null,
      opts.alpha_scale !== null && opts.alpha_scale !== undefined && opts.alpha_scale < 1 ? `alpha(${opts.alpha_scale})` : null,
      !opts.key_hex && opts.class !== 'pattern' ? 'recompress' : null,
    ].filter(Boolean).join('+') || 'recompress';
    return {
      bytes: Buffer.from(raw.out, 'base64'),
      mime_type: raw.mime!,
      post_processing: chain,
      lum_min: raw.lumMin ?? 0,
      lum_max: raw.lumMax ?? 1,
    };
  } finally {
    await page.close().catch(() => {});
  }
}
