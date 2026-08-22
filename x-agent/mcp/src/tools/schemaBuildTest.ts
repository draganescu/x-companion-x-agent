import { z } from 'zod';
import type { Ctx } from '../context.js';
import { schemaBuildTest } from '../schemaFactory.js';
import { XError } from '../errors.js';
import { defineTool } from './_shared.js';

const InputSchema = z.object({
  dir: z.string().describe('Package directory returned by wp_schema_scaffold.'),
  timeout_ms: z.number().int().min(10_000).max(600_000).optional(),
  port: z.number().int().optional(),
});

const RouteCheckSchema = z.object({
  path: z.string(),
  method: z.string(),
  status: z.number(),
  unauth_status: z.number().optional(),
  ok: z.boolean(),
});

const OutputSchema = z.object({
  built: z.boolean(),
  smoke: z.object({
    booted: z.boolean(),
    types_registered: z.record(z.string(), z.boolean()),
    meta_in_rest: z.record(z.string(), z.boolean()),
    taxonomies_registered: z.record(z.string(), z.boolean()),
    routes: z.array(RouteCheckSchema),
    bindings_registered: z.record(z.string(), z.boolean()),
    uninstall_clean: z.boolean(),
    php_error: z.string().optional(),
  }),
  zip_path: z.string().optional(),
  build_log: z.string().optional(),
});

export const wpSchemaBuildTest = defineTool({
  name: 'wp_schema_build_test',
  title: 'Gate a schema package in a throwaway WordPress',
  description:
    'THE SAFETY GATE for schema packages, mirroring wp_block_build_test. Static policy scan first (no $wpdb, no eval/exec — core APIs only), then a throwaway Playground boots the package and asserts: every declared post type in /wp/v2/types, every meta key REST-visible with a schema, taxonomies registered, every route answering as declared (2xx for a valid nonce\'d call, 401/403 unauthenticated on protected routes), binding sources resolvable, and a clean uninstall. Any failure returns structured detail and NO zip — nothing reaches an instance that has not passed here.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  local: true,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});
    const result = await schemaBuildTest(args.dir, {
      ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
      ...(args.port !== undefined ? { port: args.port } : {}),
      logger: ctx.logger,
    });

    if (result.failure) {
      throw new XError(result.failure.code, result.failure.message, result.failure.hint, {
        smoke: result.smoke,
        ...(result.build_log ? { build_log: result.build_log.slice(-2000) } : {}),
      });
    }

    const out: Record<string, unknown> = { built: result.built, smoke: result.smoke };
    if (result.zip_path) out.zip_path = result.zip_path;
    if (result.build_log) out.build_log = result.build_log;
    return out;
  },
});

export const tools = [wpSchemaBuildTest];
