/**
 * Thin image-generation client for Google's Gemini image models (the Nano
 * Banana family) — the same client shape wpforge uses: retries with backoff,
 * per-call timing, and no opinions about what to do with the bytes. WHAT each
 * image shows comes from the block's own `metadata.imageIntent`, written when
 * the layout was built; `buildImagePrompt` composes that with an optional
 * per-run style line so every image in one pass shares a look.
 */
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
