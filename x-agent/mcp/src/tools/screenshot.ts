/**
 * wp_screenshot — ONE full-page PNG, at the END of a build.
 *
 * Deliberately minimal. It is not a loop primitive and there is no diff mode:
 * iterate with wp_verify's numbers, then take exactly one screenshot as human
 * acceptance evidence. Anything more would re-create the screenshot-squinting
 * loop this toolchain exists to replace.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ConnectionArgsShape, defineTool } from './_shared.js';
import { XError } from '../errors.js';
import { DEFAULT_VIEWPORT, eagerLoadImages, prepareTarget } from '../oracle.js';

const ViewportSchema = z.object({ width: z.number().gt(0), height: z.number().gt(0) });

const InputSchema = z.looseObject({
  ...ConnectionArgsShape,
  url: z.string().optional(),
  markup: z.string().optional(),
  viewport: ViewportSchema.optional(),
  nav_timeout_ms: z.number().int().min(1000).max(600000).optional().describe('Navigation timeout in ms (default 60000). Lower it for pages that never settle.'),
  wait: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe("waitUntil for the navigation (default 'load'). Use 'domcontentloaded' for frontends whose subresources crawl or never idle — e.g. WooCommerce on a single-worker sandbox."),
  out_path: z.string().optional().describe('Destination .png path; defaults to a temp file.'),
  clip: z
    .object({ x: z.number(), y: z.number(), width: z.number().gt(0), height: z.number().gt(0) })
    .optional()
    .describe('Optional region clip in CSS pixels. Omit for the full page.'),
});

const OutputSchema = z.object({
  path_to_png: z.string(),
  viewport: ViewportSchema,
  bytes: z.int(),
});

export const wpScreenshot = defineTool({
  name: 'wp_screenshot',
  title: 'Take the final acceptance screenshot',
  description:
    'ONE full-page PNG via the warm browser, for human acceptance at the END of a build. This is deliberately not a loop primitive: iterate with wp_verify\'s numbers, then take exactly one screenshot as evidence.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});
    const viewport = args.viewport ?? DEFAULT_VIEWPORT;

    const outPath = path.resolve(
      args.out_path ?? path.join(os.tmpdir(), `x-agent-shot-${Date.now()}.png`),
    );
    if (!/\.png$/i.test(outPath)) {
      throw new XError('invalid_input', `out_path must end in .png (got ${outPath}).`, 'Pass a .png destination or omit out_path for a temp file.');
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const target = await prepareTarget(ctx, {
      ...(args.markup !== undefined ? { markup: args.markup } : {}),
      ...(args.url !== undefined ? { url: args.url } : {}),
      ...(args.nav_timeout_ms !== undefined ? { nav_timeout_ms: args.nav_timeout_ms } : {}),
      ...(args.wait !== undefined ? { wait: args.wait } : {}),
      viewport,
    });

    try {
      await eagerLoadImages(target.page);
      await target.page.screenshot({
        path: outPath,
        ...(args.clip ? { clip: args.clip } : { fullPage: true }),
      });
    } finally {
      await target.release();
    }

    const bytes = fs.statSync(outPath).size;
    return { path_to_png: outPath, viewport, bytes };
  },
});

export const tools = [wpScreenshot];
