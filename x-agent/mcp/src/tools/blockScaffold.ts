/**
 * `wp_block_scaffold` — step 3 of the vocabulary-gap ladder.
 *
 * Copies `templates/dynamic-block` and interpolates. The block is ALWAYS
 * dynamic: `block.json` always carries a `render` entry and the generated
 * `src/index.js` hard-codes `save: () => null`. The spec's non-goals put it
 * plainly — "No static block generation under any circumstances" — and there is
 * no argument, flag or template branch here that produces one.
 *
 * `render_intent` is not executed and not interpreted. It is embedded verbatim
 * as the docblock at the top of `render.php`, which is the file the calling
 * agent then implements.
 *
 * Fully local: no connection config required (`local: true`).
 */
import { z } from 'zod';

import type { Ctx } from '../context.js';
import { getFactory } from '../context.js';
import { XError } from '../errors.js';
import { asFactory, type ScaffoldAttribute } from '../factory.js';
import { defineTool } from './_shared.js';

const AttributeSchema = z.object({
  name: z.string().describe('Attribute key; becomes a block.json attribute and a control in the inspector.'),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object']),
  default: z.unknown().optional(),
  control: z
    .enum(['text', 'textarea', 'number', 'toggle', 'select', 'image'])
    .optional()
    .describe(
      'Inspector control. Omit to infer from type (array/object then scaffold a raw-JSON fallback you MUST replace with a purpose-built control before install). "textarea" on an array edits it as one item per line.',
    ),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional().describe('Required when control is "select"; also becomes the block.json enum. Labels are user-facing.'),
  label: z.string().optional().describe('User-facing control label shown to site editors; defaults to a title-cased version of name.'),
  help: z.string().optional().describe('User-facing help text under the control. Write for site editors — plain language, never toolchain vocabulary.'),
});

const InputSchema = z.looseObject({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'slug must match ^[a-z0-9-]+$ — lowercase letters, digits and hyphens only')
    .describe('Block slug; the block name becomes agent/{slug} and the directory name is the slug.'),
  title: z.string().describe('Human title shown in the inserter.'),
  attributes: z.array(AttributeSchema).optional(),
  render_intent: z.string().describe('Natural-language description of what render.php must output. Embedded verbatim as the docblock you then implement against.'),
  dir: z.string().optional().describe('Parent directory for the scaffold; defaults to a temp workspace.'),
  description: z
    .string()
    .optional()
    .describe('User-facing description shown in the inserter and block card. Write it for site editors — what the block shows, never how it was made. Defaults to the title.'),
  version: z.string().optional().describe('block.json version; defaults to 0.1.0.'),
  force: z.boolean().optional().describe('Overwrite an existing non-empty scaffold directory.'),
  interactivity: z
    .enum(['none', 'view-script', 'interactivity-api'])
    .optional()
    .describe(
      "Front-end interactivity rung. 'view-script' (default rung for enhancement): a plain vanilla view.js, no build, no framework. 'interactivity-api': an ES module store via viewScriptModule — ONLY when state must flow server->client, and only when the target instance's features.interactivity_api is available (checked; refused otherwise). Declare the rung and why.",
    ),
  stylesheet: z
    .boolean()
    .optional()
    .describe('Ship a block-owned style.css — rung 6 of the expression ladder, only after supports/tokens/styles/variations/per-block css failed. R11: token custom properties only; literals are flagged by the build test.'),
});

const OutputSchema = z.object({
  dir: z.string(),
  name: z.string(),
  files: z.array(z.string()),
});

export const wpBlockScaffold = defineTool({
  name: 'wp_block_scaffold',
  title: 'Scaffold a new dynamic block',
  description:
    'Step 3 of the vocabulary-gap ladder, and only after composition and block styles/patterns have been ruled out. Copies templates/dynamic-block and interpolates slug/title/attributes. ALWAYS dynamic — static blocks freeze save() output into content and are never generated. render_intent is embedded as a comment for you to implement render.php against. Next step is always wp_block_build_test: nothing reaches an instance without passing that gate.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  local: true,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});

    // The interactivity-api rung exists only where the platform provides it.
    // The check reads the target's feature matrix; every other mode stays
    // fully local.
    if (args.interactivity === 'interactivity-api') {
      const { connectionArgs } = await import('./_shared.js');
      let available: boolean | undefined;
      try {
        const live = ctx.runtime.ctx(connectionArgs(input));
        const manifest = await live.manifestCache.get();
        const feature = (manifest.features as Record<string, { available?: boolean }> | undefined)?.interactivity_api;
        available = feature?.available;
      } catch (e) {
        throw new XError(
          'invalid_input',
          `interactivity:"interactivity-api" needs a connected instance to verify features.interactivity_api, and none is reachable: ${(e as Error).message}`,
          'Connect an instance (wp_connect) or use interactivity:"view-script" — the vanilla rung needs no platform feature.',
        );
      }
      if (available === false) {
        throw new XError(
          'invalid_input',
          'The target instance does not provide the Interactivity API (manifest features.interactivity_api.available = false).',
          'Use interactivity:"view-script" — the vanilla rung works everywhere. The Interactivity API rung requires WordPress 6.5+.',
        );
      }
    }

    const factory = asFactory(await getFactory(ctx));
    const scaffoldArgs: Parameters<typeof factory.scaffold>[0] = {
      slug: args.slug,
      title: args.title,
      render_intent: args.render_intent,
    };
    if (args.attributes) scaffoldArgs.attributes = args.attributes as ScaffoldAttribute[];
    if (args.dir) scaffoldArgs.dir = args.dir;
    if (args.description) scaffoldArgs.description = args.description;
    if (args.version) scaffoldArgs.version = args.version;
    if (args.force) scaffoldArgs.force = true;
    if (args.interactivity) scaffoldArgs.interactivity = args.interactivity;
    if (args.stylesheet) scaffoldArgs.stylesheet = true;
    return factory.scaffold(scaffoldArgs);
  },
});

export const tools = [wpBlockScaffold];
export default wpBlockScaffold;
