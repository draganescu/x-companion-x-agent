/**
 * wp_verify — THE ORACLE.
 *
 * Renders (or navigates to) a layout in the warm browser, measures every block
 * wrapper with getBoundingClientRect() + getComputedStyle(), derives an
 * accessibility outline, and — when a DesignSpecIR is supplied — diffs the
 * result against the spec's regions in NUMBERS.
 *
 * This is the loop primitive. Screenshot comparison is deliberately not one:
 * wp_screenshot exists for a single final acceptance image and nothing else.
 *
 * With no spec, it returns box_tree + a11y_outline and pass:true — that is the
 * "what did I actually build" call, and it is also how you author a spec that
 * describes the real thing instead of an imagined one.
 */
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ConnectionArgsShape, defineTool } from './_shared.js';
import { XError } from '../errors.js';
import { DesignSpecIRSchema, type DesignSpecIR } from '../schemas.js';
import {
  DEFAULT_VIEWPORT,
  classNameMap,
  diffAgainstSpec,
  extractLayout,
  prepareTarget,
  resolveTolerances,
  toBoxTree,
  type Diff,
} from '../oracle.js';

const ViewportSchema = z.object({ width: z.number().gt(0), height: z.number().gt(0) });
const BoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

const InputSchema = z.looseObject({
  ...ConnectionArgsShape,
  markup: z.string().optional().describe('Compiled markup to render and measure. Mutually exclusive with url.'),
  url: z.string().optional().describe('Live URL to navigate and measure instead of rendering markup.'),
  nav_timeout_ms: z.number().int().min(1000).max(600000).optional().describe('Navigation timeout in ms (default 60000). Lower it for pages that never settle.'),
  wait: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe("waitUntil for the navigation (default 'load'). Use 'domcontentloaded' for frontends whose subresources crawl or never idle — e.g. WooCommerce on a single-worker sandbox."),
  spec: z.unknown().optional().describe('DesignSpecIR to diff against. Omit to get box_tree + a11y_outline only.'),
  spec_region_id: z.string().optional().describe('Restrict the diff to one region subtree.'),
  viewport: ViewportSchema.optional().describe('Measurement viewport, e.g. {width:1440,height:900}. Defaults to the spec source viewport, else 1440x900.'),
  tolerances: z
    .object({
      position_px: z.number().optional(),
      position_ratio: z.number().optional(),
      size_px: z.number().optional(),
      size_ratio: z.number().optional(),
      gap_steps: z.number().optional(),
      font_size_px: z.number().optional(),
      color_channel: z.number().optional().describe('Max per-channel 0-255 difference before a colour counts as different. Default 8.'),
    })
    .optional(),
});

const OutputSchema = z.object({
  box_tree: z.array(
    z.object({
      selector_path: z.string(),
      block_name: z.string().optional(),
      box: BoxSchema,
      computed: z.object({
        display: z.string(),
        gap: z.string(),
        fontSize: z.string(),
        color: z.string(),
        background: z.string(),
      }),
    }),
  ),
  a11y_outline: z.array(z.object({ role: z.string(), name: z.string(), level: z.number().optional() })),
  diffs: z.array(
    z.object({
      region_id: z.string(),
      kind: z.enum(['position', 'size', 'gap', 'font_size', 'color', 'missing', 'extra']),
      expected: z.unknown(),
      actual: z.unknown(),
      delta: z.unknown(),
      within_tolerance: z.boolean(),
    }),
  ),
  pass: z.boolean(),
  measured: z.object({
    source: z.enum(['url', 'render-shell']),
    loaded_url: z.string(),
    viewport: ViewportSchema,
    block_wrapper_nodes: z.int(),
    named_nodes: z.int(),
    named_ratio: z.number().describe('Share of measured .wp-block-* / data-block nodes that resolved to a manifest block name.'),
    stylesheets: z.int(),
    inline_style_blocks: z.int(),
    diffs_outside_tolerance: z.int(),
  }),
  matches: z.array(z.object({ region_id: z.string(), selector_path: z.string(), score: z.number() })),
});

export const wpVerify = defineTool({
  name: 'wp_verify',
  title: 'Numerically verify a layout against a Design Spec IR',
  description:
    'THE ORACLE. Renders markup (or navigates a url) in the warm browser, extracts per-element geometry and computed styles, builds an accessibility outline, and diffs numerically against DesignSpecIR regions. Tolerances default to 4px/2% position and size, one spacing step for gap, 1px for font size, and are overridable. Use this instead of comparing screenshots — screenshots are terminal evidence only.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});

    let spec: DesignSpecIR | undefined;
    if (args.spec !== undefined && args.spec !== null) {
      const parsed = DesignSpecIRSchema.safeParse(args.spec);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .slice(0, 5)
          .map((i) => `/${i.path.join('/')}: ${i.message}`)
          .join('; ');
        throw new XError(
          'invalid_input',
          `The supplied spec is not a valid DesignSpecIR: ${detail}`,
          'Run wp_spec_validate on the spec first; it reports E_SPEC_SCHEMA with a pointer.',
        );
      }
      spec = parsed.data;
    }

    const viewport = args.viewport ?? (spec ? spec.source.viewport : DEFAULT_VIEWPORT);

    const target = await prepareTarget(ctx, {
      ...(args.markup !== undefined ? { markup: args.markup } : {}),
      ...(args.url !== undefined ? { url: args.url } : {}),
      ...(args.nav_timeout_ms !== undefined ? { nav_timeout_ms: args.nav_timeout_ms } : {}),
      ...(args.wait !== undefined ? { wait: args.wait } : {}),
      viewport,
    });

    try {
      const manifest = await ctx.manifestCache.get();
      const lookup = classNameMap(Object.keys(manifest.blocks));
      const extracted = await extractLayout(target.page, lookup);

      let diffs: Diff[] = [];
      let pass = true;
      let matches: { region_id: string; selector_path: string; score: number }[] = [];

      if (spec) {
        const result = diffAgainstSpec({
          spec,
          nodes: extracted.nodes,
          viewport,
          tolerances: resolveTolerances(args.tolerances),
          ...(args.spec_region_id ? { regionId: args.spec_region_id } : {}),
        });
        diffs = result.diffs;
        pass = result.pass;
        matches = result.matches;
      }

      return {
        box_tree: toBoxTree(extracted.nodes),
        a11y_outline: extracted.a11y_outline,
        diffs,
        pass,
        measured: {
          source: target.source,
          loaded_url: target.loaded_url,
          viewport,
          block_wrapper_nodes: extracted.stats.candidates,
          named_nodes: extracted.stats.named,
          named_ratio: Math.round(extracted.stats.named_ratio * 10000) / 10000,
          stylesheets: target.theme_styles.links + target.enqueued_styles.length,
          inline_style_blocks: target.theme_styles.inline,
          diffs_outside_tolerance: diffs.filter((d) => !d.within_tolerance).length,
        },
        matches,
      };
    } finally {
      await target.release();
    }
  },
});

export const tools = [wpVerify];
