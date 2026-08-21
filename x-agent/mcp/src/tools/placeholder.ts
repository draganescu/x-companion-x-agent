import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';

const InputSchema = z.object({
  ...ConnectionArgsShape,
  color: z
    .string()
    .describe('A #rrggbb value, or a palette slug from the instance manifest (e.g. "accent-1") so the placeholder lands on the design system.'),
});

const OutputSchema = z.object({
  id: z.number().describe('Attachment id — put it in the image block\'s `id` attribute.'),
  url: z.string().describe('Attachment URL — put it in the image block\'s `url` attribute.'),
  color: z.string().describe('Resolved #rrggbb value.'),
  slug: z.string(),
  reused: z.boolean().describe('True when an attachment for this colour already existed.'),
});

export const wpPlaceholder = defineTool({
  name: 'wp_placeholder',
  title: 'Create a solid-colour pixel placeholder image',
  description:
    'POST /placeholder — creates (idempotently, one per colour) a 1×1 solid-colour GIF attachment in the media library and returns {id, url, color, slug, reused}. This is the DEFAULT image source while a layout is being fabricated and no real asset exists yet: stretch the pixel with the image block\'s width:"100%" + aspectRatio + scale:"cover" (or imageFill:true on core/media-text) so the geometry is final from day one, and record what the real picture should be in that node\'s attributes.metadata.imageIntent — a later image-generation pass reads the intents via wp_parse, produces the assets, and swaps the URLs without moving the layout. Prefer palette slugs over raw hex so placeholders stay on the design system. Extend tier: refused with posture_forbidden on a production instance.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});
    const live = ctx.runtime.ctx(connectionArgs(input));
    return live.companion.placeholder(args.color);
  },
});

export const tools = [wpPlaceholder];
