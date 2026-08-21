import { z } from 'zod';
import type { Ctx } from '../context.js';
import { TreeIRSchema, DiagnosticsSchema, checkWithZod, type Diagnostics } from '../schemas.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';

/**
 * Deliberately permissive: this tool's entire job is to REPORT schema
 * violations as Diagnostics, so a malformed tree must reach the handler rather
 * than bounce off the MCP input guard as `{code:'invalid_input'}`.
 * The real shape is schemas/tree-ir.schema.json, enforced by the local
 * pre-check below.
 */
const InputSchema = z.looseObject({
  ...ConnectionArgsShape,
  version: z.unknown().optional().describe('TreeIR version. Must be the literal number 1.'),
  epoch: z
    .unknown()
    .optional()
    .describe('String: the manifest fingerprint this tree was generated against. Get it from wp_connect or wp_manifest.'),
  blocks: z
    .unknown()
    .optional()
    .describe('BlockNode[] — each node is {name: "namespace/block", attributes?: object, innerBlocks?: BlockNode[]}. innerHTML is forbidden anywhere in a tree; it is a wp_compile output.'),
});

const OutputSchema = DiagnosticsSchema.extend({
  checked_locally_only: z.boolean().describe('true when the local TreeIR schema pre-check failed and no request was sent to the instance.'),
});

/**
 * LOCAL pre-check against the vendored TreeIR schema.
 *
 * A schema-invalid tree never reaches the network: CONTRACT.md §5 says
 * E_TREE_SCHEMA stops all further checks server-side anyway, so the round trip
 * is pure waste. Returns null when the tree is schema-clean.
 */
export function localTreeSchemaPrecheck(tree: unknown): Diagnostics | null {
  const issues = checkWithZod(TreeIRSchema, tree);
  if (issues.length === 0) return null;
  return {
    valid: false,
    epoch_ok: false,
    diagnostics: issues.map((i) => ({
      code: 'E_TREE_SCHEMA' as const,
      severity: 'error' as const,
      path: i.path,
      message: i.message,
      fix_hint:
        'Fix the tree against schemas/tree-ir.schema.json. BlockNode allows only {name, attributes, innerBlocks}; innerHTML is a compiler output and is a hard schema error here.',
    })),
  };
}

export const wpValidate = defineTool({
  name: 'wp_validate',
  title: 'Validate a TreeIR against the instance registry',
  description:
    'POST /validate. A local TreeIR schema pre-check runs first and short-circuits without any network call when the tree is malformed. On the wire the instance checks unknown blocks, attribute types/enums, parent/ancestor nesting, agent hints and the epoch. valid===true means zero severity:"error" diagnostics. Warnings are review items, not noise.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: unknown, ctx: Ctx) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const tree = { version: raw.version, epoch: raw.epoch, blocks: raw.blocks };

    const local = localTreeSchemaPrecheck(tree);
    if (local) return { ...local, checked_locally_only: true };

    const live = ctx.runtime.ctx(connectionArgs(input));
    const result = await live.companion.validate(TreeIRSchema.parse(tree));
    return { ...result, checked_locally_only: false };
  },
});

export const tools = [wpValidate];
