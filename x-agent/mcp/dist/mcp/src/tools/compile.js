/**
 * wp_compile — the ONLY legitimate source of serialized block markup.
 *
 * Takes a TreeIR, hands `tree.blocks` (the array, CONTRACT.md §6 — not the
 * envelope) to `window.__compile` on the instance's own harness page in the warm
 * browser, and returns the canonical markup each block's real `save()` produced.
 *
 * Two guards run before a single character is serialized:
 *   - a cheap `GET /fingerprint` probe, so a moved epoch reloads the harness
 *     page before it is used rather than after the markup is already wrong;
 *   - the registry-gap diff, so a block the server advertises but that never
 *     registered client-side fails with `{code:'harness_gap'}` instead of
 *     silently serializing to something no editor will accept.
 */
import { z } from 'zod';
import { ConnectionArgsShape, defineTool } from './_shared.js';
import { errInvalidInput } from '../errors.js';
import { BlockNodeSchema } from '../schemas.js';
import { sessionFor } from '../session.js';
const InputSchema = z.looseObject({
    ...ConnectionArgsShape,
    version: z.unknown().optional().describe('TreeIR version, the literal number 1.'),
    epoch: z.unknown().optional().describe('Manifest fingerprint the tree was generated against.'),
    blocks: z.unknown().optional().describe('BlockNode[] — the tree to compile.'),
});
const OutputSchema = z.object({
    markup: z.string(),
    all_valid: z.boolean(),
    invalid: z.array(z.object({ path: z.string(), name: z.string(), validation_issues: z.unknown() })),
    registry_gaps: z.array(z.string()),
    epoch: z.string(),
    timing: z.object({
        total_ms: z.number(),
        page_ms: z.number(),
        compile_ms: z.number(),
        cold: z.boolean().describe('True when this call paid for the browser launch and the harness page load.'),
    }),
    harness: z.object({
        reloaded: z.number().describe('How many times the harness page has been re-navigated for an epoch move.'),
        degraded: z.string().nullable().describe('X-Harness-Degraded header, when the instance served the page without enqueue_block_editor_assets.'),
        via_editor_fallback: z.boolean(),
    }),
});
export const wpCompile = defineTool({
    name: 'wp_compile',
    title: 'Compile a TreeIR to canonical block markup',
    description: 'Drives window.__compile on the instance GET /harness page in a warm headless browser, so markup comes from each block\'s real save() implementation. NEVER hand-write "<!-- wp:" markup; this tool is the only legitimate source of it. Returns {markup, all_valid, invalid[], registry_gaps, epoch}; all_valid must be true before you ship a layout. If a block in the tree is in the manifest but missing from the client-side registry the call fails with {code:"harness_gap", blocks:[...]}.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    handler: async (input, ctx) => {
        const raw = (input ?? {});
        if (!Array.isArray(raw.blocks)) {
            throw errInvalidInput('wp_compile needs a TreeIR: {version: 1, epoch: "<fingerprint>", blocks: BlockNode[]}. `blocks` was ' +
                (raw.blocks === undefined ? 'missing' : typeof raw.blocks) + '.', 'Generate a tree (never markup) and pass it whole. wp_validate will tell you if the tree itself is wrong.');
        }
        const parsed = z.array(BlockNodeSchema).safeParse(raw.blocks);
        if (!parsed.success) {
            const detail = parsed.error.issues
                .slice(0, 5)
                .map((i) => `/blocks/${i.path.join('/')}: ${i.message}`)
                .join('; ');
            throw errInvalidInput(`The tree does not satisfy tree-ir.schema.json: ${detail}`, 'Run wp_validate first — it reports E_TREE_SCHEMA with an RFC 6901 pointer. Remember a tree never contains innerHTML.');
        }
        const blocks = parsed.data;
        // Cheap epoch probe on EVERY compile. GET /fingerprint is explicitly the
        // cheap route (CONTRACT.md §5) and a compile is a batch; paying one small
        // request beats compiling at a stale epoch.
        await ctx.manifestCache.get({ fingerprintMinIntervalMs: 0 });
        // getSession() fires onEpochChange -> session.reload() when the epoch moved.
        const session = await sessionFor(ctx);
        const result = await session.compile(blocks);
        return {
            markup: result.markup,
            all_valid: result.all_valid,
            invalid: result.invalid,
            registry_gaps: result.registry_gaps,
            epoch: result.epoch,
            timing: result.timing,
            harness: {
                reloaded: session.stats.reloads,
                degraded: session.harnessDegraded,
                via_editor_fallback: session.viaEditorFallback,
            },
        };
    },
});
export const tools = [wpCompile];
//# sourceMappingURL=compile.js.map