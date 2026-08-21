import { z } from 'zod';
import type { Ctx } from '../context.js';
import type { ParsedBlock } from '../companion.js';
import type { BlockNode } from '../schemas.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';

const InputSchema = z.object({
  ...ConnectionArgsShape,
  markup: z.string().describe('Serialized block markup (post_content) to lift back into a TreeIR.'),
  include_raw: z.boolean().optional().describe('Include the verbatim parse_blocks() output alongside the stripped tree (default true).'),
});

const OutputSchema = z.object({
  tree: z.object({ version: z.literal(1), epoch: z.string(), blocks: z.array(z.unknown()) }),
  blocks: z.array(z.unknown()).optional().describe('Verbatim parse_blocks() output including innerHTML/innerContent.'),
  dropped_freeform: z.number().describe('Number of null-name (classic/freeform) nodes dropped when building the tree.'),
});

/**
 * parse_blocks() output -> TreeIR.blocks: keep name/attrs/innerBlocks, drop
 * innerHTML and innerContent (a tree never contains innerHTML — CONTRACT.md §1),
 * and drop null-name freeform nodes, which parse_blocks emits for whitespace.
 */
export function stripToTree(parsed: ParsedBlock[]): { blocks: BlockNode[]; dropped: number } {
  let dropped = 0;
  const walk = (nodes: ParsedBlock[]): BlockNode[] => {
    const out: BlockNode[] = [];
    for (const n of nodes ?? []) {
      if (!n || typeof n.blockName !== 'string' || n.blockName === '') {
        dropped += 1;
        continue;
      }
      const node: BlockNode = { name: n.blockName };
      if (n.attrs && typeof n.attrs === 'object' && Object.keys(n.attrs).length > 0) node.attributes = n.attrs;
      const inner = walk(Array.isArray(n.innerBlocks) ? n.innerBlocks : []);
      if (inner.length) node.innerBlocks = inner;
      out.push(node);
    }
    return out;
  };
  return { blocks: walk(parsed), dropped };
}

export const wpParse = defineTool({
  name: 'wp_parse',
  title: 'Parse existing markup into a TreeIR',
  description:
    'POST /parse. Brownfield lifting: turns existing post_content into a TreeIR you can edit and recompile. Returns both the verbatim parse_blocks() output (with innerHTML, for inspection) and the stripped TreeIR (no innerHTML — a tree never carries compiler output).',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});
    const live = ctx.runtime.ctx(connectionArgs(input));
    const { blocks } = await live.companion.parse(args.markup);
    const { blocks: tree, dropped } = stripToTree(blocks);
    const epoch = live.companion.expectedFingerprint ?? (await live.companion.fetchFingerprint()).fingerprint;

    const out: {
      tree: { version: 1; epoch: string; blocks: unknown[] };
      blocks?: unknown[];
      dropped_freeform: number;
    } = {
      tree: { version: 1, epoch, blocks: tree },
      dropped_freeform: dropped,
    };
    if (args.include_raw !== false) out.blocks = blocks;
    return out;
  },
});

export const tools = [wpParse];
