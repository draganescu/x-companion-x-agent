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
 *  set up the deterministic post-processing that guarantees them. */
const CLASS_PHRASING: Record<SurfaceClass, string> = {
  field: 'Even, uniform surface texture with no focal point and low internal contrast, edge-to-edge',
  pattern: 'A single repeating motif tile, flat frontal view, evenly lit, no vignette',
  frieze: 'A horizontally uniform ornamental strip, continuous left to right',
  spot: 'A single discrete ornament, centered',
  canvas: 'Even, uniform surface texture with no focal point and low internal contrast, edge-to-edge',
};

const INTENSITY_PHRASING: Record<string, string> = {
  whisper: 'Very subtle, faint, low contrast',
  present: '',
  loud: 'Rich and pronounced',
};

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
  if (entry.class === 'spot') {
    const ground = entry.ground_baked ? entry.hexes[0] : entry.key_hex;
    if (ground) parts.push(`on a solid uniform background of exactly ${ground}`);
  }
  const intensity = entry.intensity ? INTENSITY_PHRASING[entry.intensity] : '';
  if (intensity) parts.push(intensity);
  parts.push(`Palette: exactly these colors — ${entry.hexes.join(', ')}`);
  if (style && style.trim()) parts.push(`Style: ${style.trim()}`);
  parts.push('No text, no watermarks, no logos, no borders.');
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
