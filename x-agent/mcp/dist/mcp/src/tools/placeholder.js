import { z } from 'zod';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';
const InputSchema = z.object({
    ...ConnectionArgsShape,
    color: z
        .string()
        .describe('A #rrggbb value, or a palette slug from the instance manifest (e.g. "accent-1") so the placeholder lands on the design system.'),
    width: z
        .number()
        .int()
        .min(1)
        .max(4000)
        .optional()
        .describe('Pixel width. Omit for the stretchable 1×1; set real dimensions when the markup is NOT yours to stretch (e.g. WooCommerce product images render at intrinsic size).'),
    height: z.number().int().min(1).max(4000).optional().describe('Pixel height.'),
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
    description: 'POST /placeholder — creates (idempotently, one per colour) a 1×1 solid-colour GIF attachment in the media library and returns {id, url, color, slug, reused}. This is the DEFAULT image source while a layout is being fabricated and no real asset exists yet: stretch the pixel with the image block\'s width:"100%" + aspectRatio + scale:"cover" (or imageFill:true on core/media-text) so the geometry is final from day one, and record what the real picture should be in that node\'s attributes.metadata.imageIntent — a later image-generation pass reads the intents via wp_parse, produces the assets, and swaps the URLs without moving the layout. Prefer palette slugs over raw hex so placeholders stay on the design system. Pass width/height to mint a real-sized PNG instead, for contexts whose markup you cannot stretch — WooCommerce product images, avatars, anything that renders at intrinsic size. Extend tier: refused with posture_forbidden on a production instance.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    handler: async (input, ctx) => {
        const args = InputSchema.parse(input ?? {});
        const live = ctx.runtime.ctx(connectionArgs(input));
        return live.companion.placeholder(args.color, args.width, args.height);
    },
});
export const tools = [wpPlaceholder];
//# sourceMappingURL=placeholder.js.map