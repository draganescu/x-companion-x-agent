import { z } from 'zod';
import type { Ctx } from '../context.js';
import { MANIFEST_SECTIONS, ManifestSchema, type Manifest, type ManifestBlock } from '../schemas.js';
import type { ClientCapture } from '../session.js';
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
  section: z
    .enum(MANIFEST_SECTIONS)
    .optional()
    .describe(
      'Return one interfaces-v2 section instead of the blocks map: styles | variations | global_styles | bindings | data_model | features. Mirrors GET /manifest?section=.',
    ),
  client_capture: z
    .boolean()
    .optional()
    .describe(
      'Merge client-registered variations and styles captured from the warm harness page (source: "client"). Default true on an interfaces-v2 instance; the capture is cached per fingerprint. Pass false to skip warming the browser.',
    ),
});

const SummaryBlockSchema = z.object({
  title: z.string(),
  parent: z.union([z.array(z.string()), z.null()]).optional(),
  ancestor: z.union([z.array(z.string()), z.null()]).optional(),
  is_dynamic: z.boolean(),
});

const ClientCaptureInfoSchema = z.object({
  performed: z.boolean(),
  from_cache: z.boolean().optional(),
  harness_loads: z.number().optional(),
  blocks_with_client_variations: z.number().optional(),
  blocks_with_client_styles: z.number().optional(),
  error: z.string().optional(),
});

/**
 * One object shape for both views: the full manifest view carries blocks/
 * summary/filtered/…, the section view carries section + the section payload
 * via the catchall. A single object type keeps `tools/list` introspectable.
 */
const OutputSchema = ManifestSchema.omit({ blocks: true })
  .partial()
  .extend({
    fingerprint: z.string(),
    posture: z.enum(['toolchain', 'production']),
    interfaces_version: z.string(),
    served_from_cache: z.boolean(),
    client_capture: ClientCaptureInfoSchema,
    section: z.enum(MANIFEST_SECTIONS).optional(),
    blocks: z.record(z.string(), z.unknown()).optional().describe('Full ManifestBlock entries, or the summary shape when summary:true. Absent in section views.'),
    summary: z.boolean().optional(),
    filtered: z.boolean().optional(),
    blocks_returned: z.number().optional(),
    blocks_total: z.number().optional(),
  })
  .catchall(z.unknown());

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

/**
 * Merge a harness client capture into a manifest: client-registered variations
 * and styles that the server does not know join each block's lists with
 * source 'client' (variations) / 'plugin' (styles — register_block_style has
 * no client provenance). Pure; never mutates the input manifest.
 */
export function mergeClientCapture(manifest: Manifest, capture: ClientCapture): Manifest {
  const blocks: Manifest['blocks'] = {};

  for (const [name, block] of Object.entries(manifest.blocks)) {
    const merged: ManifestBlock = { ...block };

    const clientVars = capture.variations[name] ?? [];
    if (clientVars.length) {
      const server = merged.variations ?? [];
      const seen = new Set(server.map((v) => v.name));
      const fresh = clientVars
        .filter((v) => !seen.has(v.name))
        .map((v) => ({ ...v, source: 'client' as const }));
      if (fresh.length) merged.variations = [...server, ...fresh].sort((a, b) => a.name.localeCompare(b.name));
    }

    const clientStyles = capture.styles[name] ?? [];
    if (clientStyles.length) {
      const server = merged.styles ?? [];
      const seen = new Set(server.map((s) => s.name));
      const fresh = clientStyles
        .filter((s) => !seen.has(s.name))
        .map((s) => ({ ...s, source: 'plugin' as const }));
      if (fresh.length) merged.styles = [...server, ...fresh].sort((a, b) => a.name.localeCompare(b.name));
    }

    blocks[name] = merged;
  }

  return { ...manifest, blocks };
}

/** The {fingerprint, posture, interfaces_version, section, <section>} envelope. */
export function sectionEnvelope(manifest: Manifest, section: (typeof MANIFEST_SECTIONS)[number]): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    fingerprint: manifest.fingerprint,
    posture: manifest.posture,
    interfaces_version: manifest.interfaces_version,
    section,
  };
  if (section === 'styles' || section === 'variations') {
    const map: Record<string, unknown> = {};
    for (const [name, block] of Object.entries(manifest.blocks)) {
      const list = section === 'styles' ? block.styles : block.variations;
      if (list && list.length) map[name] = list;
    }
    envelope[section] = map;
  } else {
    envelope[section] = manifest[section] ?? {};
  }
  return envelope;
}

export const wpManifest = defineTool({
  name: 'wp_manifest',
  title: 'Read the instance block/pattern/token manifest',
  description:
    'The vocabulary at the current epoch. Serves the in-memory cache unless refresh:true or the cheap GET /fingerprint probe (rate-limited to once per 10s) shows the fingerprint moved. Use summary:true and filter{name_prefix,dynamic_only} first — the full blocks map with verbatim attribute schemas is large. section:"styles"|"variations"|"global_styles"|"bindings"|"data_model"|"features" returns one interfaces-v2 section (block styles, variations, merged global styles + custom css, binding sources + bindable attributes + registered meta, post types/taxonomies, feature matrix). On a v2 instance, client-registered variations and styles are captured from the warm harness page and merged with source "client" (cached per fingerprint; disable with client_capture:false). Never assume a block, attribute, style, variation, binding or post type that is not in here.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});
    const live = ctx.runtime.ctx(connectionArgs(input));
    const before = live.manifestCache.stats.cacheHits;
    let manifest = await live.manifestCache.get(args.refresh ? { refresh: true } : {});
    const servedFromCache = live.manifestCache.stats.cacheHits > before;

    // Client capture: only meaningful on interfaces v2 and only for views
    // that surface per-block styles/variations. Degrades to performed:false
    // rather than failing the manifest read.
    const v2 = Number.parseInt(manifest.interfaces_version, 10) >= 2;
    const wantsBlocks = !args.section || args.section === 'styles' || args.section === 'variations';
    const captureWanted = args.client_capture ?? true;
    let captureInfo: z.infer<typeof ClientCaptureInfoSchema> = { performed: false };
    if (captureWanted && v2 && wantsBlocks) {
      try {
        const { sessionFor } = await import('../session.js');
        const session = await sessionFor(live);
        const loadsBefore = session.stats.harness_loads;
        const { capture, from_cache } = await session.captureClient();
        manifest = mergeClientCapture(manifest, capture);
        captureInfo = {
          performed: true,
          from_cache,
          harness_loads: session.stats.harness_loads - loadsBefore,
          blocks_with_client_variations: Object.keys(capture.variations).length,
          blocks_with_client_styles: Object.keys(capture.styles).length,
        };
      } catch (e) {
        captureInfo = { performed: false, error: (e as Error).message };
      }
    }

    if (args.section) {
      return {
        ...sectionEnvelope(manifest, args.section),
        served_from_cache: servedFromCache,
        client_capture: captureInfo,
      };
    }

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
      client_capture: captureInfo,
    };
  },
});

export const tools = [wpManifest];
