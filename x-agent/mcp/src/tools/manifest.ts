import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ManifestSchema, type Manifest, type ManifestBlock } from '../schemas.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';

const InputSchema = z.object({
  ...ConnectionArgsShape,
  refresh: z.boolean().optional().describe('Force a fresh GET /manifest instead of serving the cache.'),
  summary: z
    .boolean()
    .optional()
    .describe('Return only {title, parent, ancestor, is_dynamic} per block instead of full attribute schemas. The blocks map is large; start here.'),
  filter: z
    .object({
      name_prefix: z.string().optional().describe('Keep only blocks whose name starts with this, e.g. "core/" or "kadence/".'),
      dynamic_only: z.boolean().optional().describe('Keep only blocks with is_dynamic === true.'),
    })
    .optional(),
});

const SummaryBlockSchema = z.object({
  title: z.string(),
  parent: z.union([z.array(z.string()), z.null()]).optional(),
  ancestor: z.union([z.array(z.string()), z.null()]).optional(),
  is_dynamic: z.boolean(),
});

const OutputSchema = ManifestSchema.omit({ blocks: true }).extend({
  blocks: z.record(z.string(), z.unknown()).describe('Full ManifestBlock entries, or the summary shape when summary:true.'),
  summary: z.boolean(),
  filtered: z.boolean(),
  blocks_returned: z.number(),
  blocks_total: z.number(),
  served_from_cache: z.boolean(),
});

export function applyManifestView(
  manifest: Manifest,
  opts: { summary?: boolean; filter?: { name_prefix?: string; dynamic_only?: boolean } },
): { blocks: Record<string, unknown>; filtered: boolean; total: number } {
  const total = Object.keys(manifest.blocks).length;
  const prefix = opts.filter?.name_prefix;
  const dynamicOnly = opts.filter?.dynamic_only === true;
  const filtered = Boolean(prefix) || dynamicOnly;

  const out: Record<string, unknown> = {};
  for (const [name, block] of Object.entries(manifest.blocks)) {
    if (prefix && !name.startsWith(prefix)) continue;
    if (dynamicOnly && !block.is_dynamic) continue;
    out[name] = opts.summary ? summarise(block) : block;
  }
  return { blocks: out, filtered, total };
}

function summarise(block: ManifestBlock): z.infer<typeof SummaryBlockSchema> {
  const s: z.infer<typeof SummaryBlockSchema> = { title: block.title, is_dynamic: block.is_dynamic };
  if (block.parent !== undefined) s.parent = block.parent;
  if (block.ancestor !== undefined) s.ancestor = block.ancestor;
  return s;
}

export const wpManifest = defineTool({
  name: 'wp_manifest',
  title: 'Read the instance block/pattern/token manifest',
  description:
    'The vocabulary at the current epoch. Serves the in-memory cache unless refresh:true or the cheap GET /fingerprint probe (rate-limited to once per 10s) shows the fingerprint moved. Use summary:true and filter{name_prefix,dynamic_only} first — the full blocks map with verbatim attribute schemas is large. Never assume a block or attribute that is not in here.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});
    const live = ctx.runtime.ctx(connectionArgs(input));
    const before = live.manifestCache.stats.cacheHits;
    const manifest = await live.manifestCache.get(args.refresh ? { refresh: true } : {});
    const servedFromCache = live.manifestCache.stats.cacheHits > before;

    const viewOpts: { summary?: boolean; filter?: { name_prefix?: string; dynamic_only?: boolean } } = {};
    if (args.summary !== undefined) viewOpts.summary = args.summary;
    if (args.filter !== undefined) viewOpts.filter = args.filter;
    const view = applyManifestView(manifest, viewOpts);

    const { blocks: _drop, ...rest } = manifest;
    return {
      ...rest,
      blocks: view.blocks,
      summary: args.summary === true,
      filtered: view.filtered,
      blocks_returned: Object.keys(view.blocks).length,
      blocks_total: view.total,
      served_from_cache: servedFromCache,
    };
  },
});

export const tools = [wpManifest];
