import { z } from 'zod';
import type { Ctx } from '../context.js';
import { schemaScaffold } from '../schemaFactory.js';
import { defineTool } from './_shared.js';

const MetaSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object']),
  schema: z.record(z.string(), z.unknown()).optional().describe('show_in_rest schema; defaults to {type}. POLICY: every meta key is REST-visible.'),
  single: z.boolean().optional(),
  default: z.unknown().optional(),
});

const InputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/).describe('Package slug; the plugin becomes agent-schema-{slug}, routes agent-{slug}/v1.'),
  intent: z.string().describe('The domain this package models, in one or two sentences. Embedded as the implementation contract, exactly like render_intent.'),
  post_types: z
    .array(
      z.object({
        slug: z.string().regex(/^[a-z0-9-]+$/).describe('Post type slug (max 20 chars; hyphens become underscores).'),
        label: z.string(),
        supports: z.array(z.string()).optional(),
        meta: z.array(MetaSchema).optional(),
        taxonomies: z.array(z.string()).optional(),
        public: z.boolean().optional().describe('Front-end visibility; defaults false — agent CPTs are data first, blocks are their views.'),
        rewrite_slug: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .optional()
          .describe("URL base a public post type claims (/{rewrite_slug}/...); defaults to the post type slug. Decide the URL map up front — the scaffold warns when it collides with an existing page."),
        has_archive: z.boolean().optional().describe('Whether /{rewrite_slug}/ itself lists the entries. Defaults false.'),
        statuses: z.array(z.object({ slug: z.string(), label: z.string() })).optional().describe('Extra workflow statuses, e.g. ready / picked-up.'),
      }),
    )
    .min(1),
  taxonomies: z
    .array(
      z.object({
        slug: z.string().regex(/^[a-z0-9-]+$/),
        label: z.string(),
        object_types: z.array(z.string()).min(1),
        hierarchical: z.boolean().optional(),
      }),
    )
    .optional(),
  routes: z
    .array(
      z.object({
        path: z.string().describe("Path under agent-{slug}/v1, e.g. '/submit'."),
        methods: z.array(z.enum(['GET', 'POST', 'PUT', 'DELETE'])).optional(),
        auth: z.enum(['public-nonce', 'capability']).describe('public-nonce: anonymous with REST nonce + honeypot verified in the handler. capability: permission_callback checks the named capability.'),
        capability: z.string().optional(),
        writes: z.string().optional().describe('Post type the scaffolded handler writes to; defaults to the first CPT.'),
      }),
    )
    .optional(),
  bindings: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9-]+$/),
        meta_key: z.string(),
        label: z.string().optional(),
      }),
    )
    .optional()
    .describe('Block binding sources reading post meta — lets core blocks display the model with no custom rendering.'),
  dir: z.string().optional().describe('Parent directory; defaults to the schema workspace.'),
  version: z.string().optional(),
  force: z.boolean().optional(),
});

const OutputSchema = z.object({
  dir: z.string(),
  slug: z.string(),
  files: z.array(z.string()),
  warnings: z
    .array(z.string())
    .describe('URL-map findings: a public post type claiming a path an existing page already serves. Cheap to fix now; a rebuild cycle after publish.'),
});

export const wpSchemaScaffold = defineTool({
  name: 'wp_schema_scaffold',
  title: 'Scaffold a schema package (the backend factory)',
  description:
    'The backend counterpart of wp_block_scaffold: generates a schema package — real plugin code registering post types, taxonomies, REST-visible meta, workflow statuses, block-binding sources and nonce-guarded REST routes, all through core APIs on init, plus standard admin list-table columns and an uninstall story. Use when a block would otherwise need storage, backend behavior or an admin surface: the package owns the data, blocks are its views. The intent is embedded as the implementation contract. Then wp_schema_build_test (the gate) and wp_schema_install.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  local: true,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});
    const result = await schemaScaffold(args);

    // URL-map check, best effort: a PUBLIC post type claims /{rewrite_slug}/…
    // on the site. If an instance is reachable, compare against its published
    // page and post slugs and WARN on collision — that is decidable now, and
    // discovering it after publication costs a full rebuild cycle. Without a
    // reachable instance the scaffold still works; it just says it could not
    // look.
    const warnings: string[] = [];
    const publicTypes = args.post_types.filter((p) => p.public);
    if (publicTypes.length) {
      try {
        const { connectionArgs } = await import('./_shared.js');
        const live = ctx.runtime.ctx(connectionArgs(input));
        const taken = new Set([
          ...(await live.companion.coreListSlugs('pages')),
          ...(await live.companion.coreListSlugs('posts')),
        ]);
        for (const p of publicTypes) {
          const claim = p.rewrite_slug ?? p.slug;
          if (taken.has(claim)) {
            warnings.push(
              `post type "${p.slug}" claims /${claim}/ but the site already serves a page or post at that slug — ` +
                `its permalinks${p.has_archive ? ' and archive' : ''} will fight it. Pick a different rewrite_slug now.`,
            );
          }
        }
      } catch {
        warnings.push(
          'Could not check the URL map against an instance (none reachable): collisions between a public post type and existing page slugs will only surface after publish.',
        );
      }
    }

    return { ...result, warnings };
  },
});

export const tools = [wpSchemaScaffold];
