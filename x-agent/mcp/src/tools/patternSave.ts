import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';

const InputSchema = z.object({
  ...ConnectionArgsShape,
  slug: z
    .string()
    .regex(/^agent\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/)
    .describe('Pattern slug in the agent/ namespace, e.g. "agent/cta-amber-band". Same slug replaces.'),
  title: z.string().min(1).describe('Human-readable pattern title.'),
  content: z
    .string()
    .min(1)
    .describe('Serialized block markup — MUST be wp_compile output, never hand-written. Content that parses to zero blocks is refused (422 pattern_policy).'),
  categories: z.array(z.string()).optional().describe('Extra pattern categories; "x-agent" is always added.'),
  description: z.string().optional().describe('One sentence on when to reach for this section.'),
});

const OutputSchema = z.object({
  saved: z.string(),
  replaced: z.boolean(),
  total: z.number().describe('How many agent patterns the instance now holds.'),
  fingerprint: z.string().describe('The NEW epoch — adopt it in every subsequent tree (R3).'),
});

export const wpPatternSave = defineTool({
  name: 'wp_pattern_save',
  title: 'Save a composed section as a reusable pattern',
  description:
    'POST /patterns — saves a section you composed as a registered block pattern on the instance, so the corpus grows its own idiom: the next page assembles from it (wp_patterns lists it under the x-agent category) and future sessions inherit it as vocabulary. Save the sections worth keeping — a hero, a CTA band, a card row that came out right — not every band you ship. content must be wp_compile output at the current epoch; the save MOVES the epoch, so adopt the returned fingerprint immediately. Extend tier: refused with posture_forbidden on a production instance.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});
    const live = ctx.runtime.ctx(connectionArgs(input));
    return live.companion.patternSave({
      slug: args.slug,
      title: args.title,
      content: args.content,
      ...(args.categories ? { categories: args.categories } : {}),
      ...(args.description ? { description: args.description } : {}),
    });
  },
});

export const tools = [wpPatternSave];
