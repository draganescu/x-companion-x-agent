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
import { asFactory, type ScaffoldAttribute } from '../factory.js';
import { defineTool } from './_shared.js';

const AttributeSchema = z.object({
  name: z.string().describe('Attribute key; becomes a block.json attribute and a control in the inspector.'),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object']),
  default: z.unknown().optional(),
  control: z.enum(['text', 'textarea', 'number', 'toggle', 'select']),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional().describe('Required when control is "select"; also becomes the block.json enum.'),
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
  description: z.string().optional(),
  version: z.string().optional().describe('block.json version; defaults to 0.1.0.'),
  force: z.boolean().optional().describe('Overwrite an existing non-empty scaffold directory.'),
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
    return factory.scaffold(scaffoldArgs);
  },
});

export const tools = [wpBlockScaffold];
export default wpBlockScaffold;
