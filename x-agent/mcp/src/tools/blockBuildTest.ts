/**
 * `wp_block_build_test` — THE SAFETY GATE.
 *
 * CONTRACT.md §5 says of `POST /blocks/install`: "Structural validation only.
 * **No `php -l`, no `exec`.** The safety gate lives on the agent side
 * (Playground smoke-test before POSTing)." This is that gate, and it is the only
 * producer of the `zip_path` that `wp_block_install` consumes.
 *
 *   1. `npm ci`/`npm install` + `wp-scripts build`
 *   2. stage the exact bytes that will ship, next to a one-line loader plugin
 *   3. boot a throwaway WordPress (`@wp-playground/cli`) with that plugin active
 *   4. assert the block is in `GET /wp/v2/block-types`
 *   5. render the sample attributes through the sandbox's own REST block
 *      renderer and capture the HTML — and any PHP fatal, parse error or notice
 *      raised from inside the package
 *   6. only then zip, and re-read the zip against every rule in the install
 *      policy before handing the path back
 *
 * Any failure returns structured detail and **no `zip_path`**. A sabotaged
 * `render.php` is caught here, in `smoke.php_error`, not by the server.
 *
 * Fully local: no connection config required (`local: true`).
 */
import { z } from 'zod';

import type { Ctx } from '../context.js';
import { getFactory } from '../context.js';
import { asFactory } from '../factory.js';
import { defineTool } from './_shared.js';

const InputSchema = z.looseObject({
  dir: z.string().describe('Scaffold directory returned by wp_block_scaffold.'),
  sample_attributes: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Attribute values used for the smoke render. Missing keys fall back to the block.json defaults.'),
  timeout_ms: z.number().optional().describe('Ceiling for npm install + wp-scripts build. Defaults to X_AGENT_BLOCK_BUILD_TIMEOUT_MS or 15 minutes; a cold @wordpress/scripts install is ~1500 packages.'),
  smoke_timeout_ms: z.number().optional().describe('Ceiling for the Playground boot + smoke. Defaults to X_AGENT_BLOCK_SMOKE_TIMEOUT_MS or 5 minutes.'),
  force_install: z.boolean().optional().describe('Reinstall dependencies even when node_modules is already present.'),
  port: z.number().optional().describe('Fixed port for the throwaway sandbox; otherwise the first free port in the configured range.'),
});

const OutputSchema = z.object({
  built: z.boolean(),
  smoke: z.object({
    registered: z.boolean(),
    rendered_html: z.string(),
    php_error: z.string().optional(),
  }),
  zip_path: z.string().optional().describe('Present ONLY when the build and the smoke test both passed. This is the only input wp_block_install accepts.'),
  build_log: z.string().optional(),
  failure: z
    .object({ code: z.enum(['build_failed', 'smoke_failed']), message: z.string(), hint: z.string() })
    .optional()
    .describe('Structured detail for the step that failed. When present, zip_path is absent by design.'),
  package: z
    .object({
      entries: z.array(z.object({ name: z.string(), bytes: z.number() })),
      zip_bytes: z.number(),
      uncompressed_bytes: z.number(),
    })
    .optional(),
  timings_ms: z.record(z.string(), z.number()).optional(),
  deviations: z.array(z.string()).optional(),
});

export const wpBlockBuildTest = defineTool({
  name: 'wp_block_build_test',
  title: 'Build and smoke-test a scaffolded block',
  description:
    'THE SAFETY GATE. Runs the wp-scripts build, boots @wp-playground/cli, registers the built block, asserts it appears in /wp/v2/block-types and renders sample markup, then produces an install zip that satisfies the companion install policy. The companion deliberately does not lint PHP — nothing reaches an instance that has not passed here. On any failure it returns {failure:{code,message,hint}} and NO zip_path.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  local: true,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});
    const factory = asFactory(await getFactory(ctx));
    const buildArgs: Parameters<typeof factory.buildAndTest>[0] = { dir: args.dir };
    if (args.sample_attributes) buildArgs.sample_attributes = args.sample_attributes;
    if (args.timeout_ms) buildArgs.timeout_ms = args.timeout_ms;
    if (args.smoke_timeout_ms) buildArgs.smoke_timeout_ms = args.smoke_timeout_ms;
    if (args.force_install) buildArgs.force_install = true;
    if (args.port) buildArgs.port = args.port;
    return factory.buildAndTest(buildArgs);
  },
});

export const tools = [wpBlockBuildTest];
export default wpBlockBuildTest;
