/**
 * Thin image-generation client for Google's Gemini image models (the Nano
 * Banana family) — the same client shape wpforge uses: retries with backoff,
 * per-call timing, and no opinions about what to do with the bytes. WHAT each
 * image shows comes from the block's own `metadata.imageIntent`, written when
 * the layout was built; `buildImagePrompt` composes that with an optional
 * per-run style line so every image in one pass shares a look.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';

export interface GeminiOpts {
  apiKey: string;
  /** e.g. "gemini-3.1-flash-lite-image" (Nano Banana 2 Lite). */
  model: string;
}

export interface ImageResult {
  data: Buffer;
  mimeType: string;
  ms: number;
}

/** Aspect ratios the image API accepts. Attribute "3/4" maps to "3:4". */
export const ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);

export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';

/** Compose the node's imageIntent with the run's style line, plus the hard
 *  constraints every generated image gets. The medium (photo, lithograph,
 *  poster…) belongs to the intent, so nothing here forces one. */
export function buildImagePrompt(intent: string, style?: string): string {
  const parts = [intent.trim()];
  if (style && style.trim()) parts.push(`Style: ${style.trim()}`);
  parts.push('No text, no watermarks, no logos, no borders.');
  return parts.join('. ').replace(/\.\./g, '.');
}

/* ------------------------------------------------------------ surface lane */

export type SurfaceClass = 'field' | 'pattern' | 'frieze' | 'spot' | 'canvas';

export interface SurfacePromptEntry {
  class: SurfaceClass;
  prompt_seed: string;
  /** The exact hexes of every band this asset will touch. Never empty. */
  hexes: string[];
  intensity?: 'whisper' | 'present' | 'loud';
  /** Spot only: bake the band hex into the ground instead of the chroma key. */
  ground_baked?: boolean;
  /** Spot only: the computed chroma-key ground the knockout will remove. */
  key_hex?: string;
}

/** What each asset class must look like, said the same way every run. The
 *  model is never trusted with seamlessness or alpha — these phrasings only
 *  set up the deterministic post-processing that guarantees them. A surface
 *  is a MATERIAL SAMPLE, never a scene: the anti-scene language is loud on
 *  purpose (field evidence: a "foxed paper" field came back as a photograph
 *  of a teacup by a window, and a frieze came back as an entire fake menu
 *  page with typography). */
const FLAT_SAMPLE = 'A flat close-up material sample that fills the entire frame edge to edge. No objects, no scene, no room, no furniture, no depth of field, no perspective, no directional lighting, no shadows of things';
const CLASS_PHRASING: Record<SurfaceClass, string> = {
  field: `${FLAT_SAMPLE}. Even and uniform with no focal point and low internal contrast`,
  pattern: 'A flat repeating ornamental motif, line-work and shapes only, flat frontal view, evenly lit. No vignette, no scene, no objects, no room, no depth, no photograph',
  frieze: 'A single horizontal ornamental border strip, continuous and uniform left to right. Ornament only: no page, no document, no layout, no photograph, no scene, no objects',
  spot: 'A single discrete ornament, centered, nothing else in the frame',
  canvas: `${FLAT_SAMPLE}. Even and uniform with no focal point and low internal contrast`,
};

const INTENSITY_PHRASING: Record<string, string> = {
  whisper: 'Very subtle, faint, low contrast',
  present: '',
  loud: 'Rich and pronounced',
};

/** Appended when a birth fails the texture bound and gets its one retry:
 *  the correction is explicit about WHY the last attempt was rejected. */
export const SURFACE_RETRY_SUFFIX =
  'MATERIAL SAMPLE ONLY — the previous attempt was rejected for depicting a scene, object or document. Render ONLY the flat material surface itself, filling the whole frame, with nothing depicted on it or in front of it.';

/** Aspect each class is generated at; friezes take the widest the API has. */
export function aspectForClass(cls: SurfaceClass): string {
  if (cls === 'frieze') return '21:9';
  if (cls === 'pattern' || cls === 'spot') return '1:1';
  return '16:9';
}

/** Compose a surface prompt: the dictionary seed, the class phrasing, the
 *  EXACT hexes of every band the asset touches, and the run's one style line.
 *  A surface prompt without its hexes is a bug, so it throws. */
export function buildSurfacePrompt(entry: SurfacePromptEntry, style?: string): string {
  if (!entry.hexes || entry.hexes.length === 0) {
    throw new Error(`surface prompt for class ${entry.class} has no band hexes — a surface is born on-palette or not at all`);
  }
  const parts = [entry.prompt_seed.trim(), CLASS_PHRASING[entry.class]];
  // Every ornament class is born on its knockout ground: the computed chroma
  // key for true-alpha assets, the band hex for a ground-baked spot.
  if (entry.class === 'spot' && entry.ground_baked) {
    if (entry.hexes[0]) parts.push(`on a solid uniform background of exactly ${entry.hexes[0]}`);
  } else if (entry.key_hex && (entry.class === 'spot' || entry.class === 'pattern' || entry.class === 'frieze')) {
    parts.push(`The ornament sits on a solid uniform background of exactly ${entry.key_hex}, which fills every gap between the motifs`);
  }
  const intensity = entry.intensity ? INTENSITY_PHRASING[entry.intensity] : '';
  if (intensity) parts.push(intensity);
  parts.push(`Palette: exactly these colors — ${entry.hexes.join(', ')}`);
  if (style && style.trim()) parts.push(`Material style: ${style.trim()}`);
  // The surface suffix is harder than the content one: letters and numerals
  // are how a "letterpress" style line leaks typography into a texture.
  parts.push('Absolutely no text, no letters, no numerals, no typography, no watermarks, no logos.');
  return parts.join('. ').replace(/\.\./g, '.');
}

/** Where a replayed image fixture for (prompt, aspect) lives: content-addressed
 *  by the prompt so identical briefs replay identical bytes — the determinism
 *  lane for fake-provider runs. */
export function fixturePathFor(dir: string, prompt: string, aspect: string): { jpg: string; png: string } {
  const key = createHash('sha256').update(`${prompt}|${aspect}`).digest('hex').slice(0, 16);
  return { jpg: join(dir, `${key}.jpg`), png: join(dir, `${key}.png`) };
}

export class GeminiImages {
  private ai: GoogleGenAI;
  private model: string;

  constructor(opts: GeminiOpts) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  /** Generate one image. Retries transient failures; throws after 3 attempts. */
  async generate(prompt: string, aspectRatio = '16:9'): Promise<ImageResult> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const started = Date.now();
      try {
        const interaction = await this.ai.interactions.create({
          model: this.model,
          input: prompt,
          response_format: {
            type: 'image',
            mime_type: 'image/jpeg',
            aspect_ratio: aspectRatio as '16:9',
            image_size: '1K',
          },
        });
        const image = interaction.output_image;
        if (!image?.data) {
          throw new Error('no image data in response');
        }
        return {
          data: Buffer.from(image.data, 'base64'),
          mimeType: image.mime_type ?? 'image/jpeg',
          ms: Date.now() - started,
        };
      } catch (e) {
        lastErr = e;
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    }
    throw new Error(`Gemini image call failed: ${(lastErr as Error)?.message ?? String(lastErr)}`);
  }
}
