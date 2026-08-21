import { z } from 'zod';
import type { Ctx } from '../context.js';
import type { PatternEntry } from '../companion.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';

const InputSchema = z.object({
  ...ConnectionArgsShape,
  query: z.string().optional().describe('Case-insensitive substring matched against pattern name, title and serialized content.'),
  category: z.string().optional().describe('Keep only patterns registered in this pattern category.'),
  limit: z.int().min(1).max(200).optional().describe('Cap the number of returned patterns (default 25).'),
  include_markup: z.boolean().optional().describe('Also return the serialized `content` markup. Off by default because it is bulky.'),
});

const OutputSchema = z.object({
  patterns: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      categories: z.array(z.string()),
      parsed_tree: z.array(z.unknown()),
      content: z.string().optional(),
    }),
  ),
  total: z.number(),
  returned: z.number(),
  fingerprint: z.string(),
  served_from_cache: z.boolean(),
});

/** Patterns are fetched once per fingerprint; filtering is local. */
const patternCache = new Map<string, PatternEntry[]>();

/** Test hook. */
export function clearPatternCache(): void {
  patternCache.clear();
}

export const wpPatterns = defineTool({
  name: 'wp_patterns',
  title: 'Search the instance pattern corpus',
  description:
    'The retrieval corpus of layout idioms actually registered on the instance. Check this BEFORE inventing a novel composition: adapting a registered pattern is the cheapest correct answer. Fetched once per fingerprint, filtered locally by substring and pattern category.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});
    const live = ctx.runtime.ctx(connectionArgs(input));
    const fingerprint = live.companion.expectedFingerprint ?? (await live.companion.fetchFingerprint()).fingerprint;

    let all = patternCache.get(fingerprint);
    const servedFromCache = all !== undefined;
    if (!all) {
      all = await live.companion.patterns();
      patternCache.set(fingerprint, all);
    }

    const q = args.query?.toLowerCase();
    const matched = all.filter((p) => {
      if (args.category && !(p.categories ?? []).includes(args.category)) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.title} ${p.content ?? ''}`.toLowerCase();
      return hay.includes(q);
    });

    const limit = args.limit ?? 25;
    const slice = matched.slice(0, limit).map((p) => {
      const base: {
        name: string;
        title: string;
        categories: string[];
        parsed_tree: unknown[];
        content?: string;
      } = {
        name: p.name,
        title: p.title,
        categories: p.categories ?? [],
        parsed_tree: Array.isArray(p.parsed) ? p.parsed : [],
      };
      if (args.include_markup) base.content = p.content;
      return base;
    });

    return {
      patterns: slice,
      total: matched.length,
      returned: slice.length,
      fingerprint,
      served_from_cache: servedFromCache,
    };
  },
});

export const tools = [wpPatterns];
