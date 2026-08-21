#!/usr/bin/env -S npx tsx
/**
 * capture-golden.ts — CAPTURE the ground-truth fixtures. Never author them.
 *
 * `specs/agent-plugin.spec.json` -> `fixtures.authoring_rule`:
 *
 *   "Ground-truth markup fixtures are CAPTURED, not hand-written ...
 *    Hand-authored expected markup is the original sin of this domain and is
 *    forbidden even in tests."
 *
 * So the only thing a human authors here is the TREE. Every byte of markup is
 * produced by driving the live instance's own GET /harness page through
 * `wp_compile`, i.e. by each block's real `save()`. The same rule is applied one
 * level further: the DesignSpecIR fixture is GENERATED FROM THE MEASURED RENDER
 * rather than imagined, so `wp_verify` is diffing against a description of the
 * real thing.
 *
 * Produces:
 *   fixtures/golden/valid-core-landing.html   compiled from trees/valid-core-landing.json
 *   fixtures/golden/golden-landing.html       compiled from trees/golden-landing.json
 *   fixtures/specs/golden-landing.json        DesignSpecIR measured off the above at 1440px
 *   fixtures/images/hero-sample.png           the golden landing hero, 1440px wide
 *   fixtures/images/golden-landing.png        full-page acceptance shot (wp_screenshot)
 *
 * Usage:
 *   x-agent/tests/live/setup.sh                       # boot / attach
 *   npx tsx x-agent/tests/capture-golden.ts           # capture everything
 *   npx tsx x-agent/tests/capture-golden.ts --check   # capture to memory and diff, write nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime, type Ctx } from '../mcp/src/context.js';
import { callTool } from '../mcp/src/server.js';
import { loadExternalHandlers } from '../mcp/src/registry.js';
import { classNameMap, extractLayout, prepareTarget, type MeasuredNode } from '../mcp/src/oracle.js';
import type { DesignSpecIR, Region } from '../mcp/src/schemas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(AGENT_ROOT, '..');
const FIXTURES = path.join(AGENT_ROOT, 'fixtures');

const VIEWPORT = { width: 1440, height: 900 };

/* --------------------------------------------------------------- plumbing */

export function runtimeDescriptorPath(): string {
  const fromEnv = process.env.X_AGENT_LIVE_RUNTIME;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const stateFile = path.join(AGENT_ROOT, 'tests', 'live', '.live-instance');
  if (fs.existsSync(stateFile)) {
    const [profile, posture] = fs.readFileSync(stateFile, 'utf8').trim().split(':');
    const p = path.join(REPO_ROOT, 'tools', '.runtime', `${profile}-${posture}.json`);
    if (fs.existsSync(p)) return p;
  }
  for (const key of ['core-plus-suite-toolchain', 'core-only-toolchain']) {
    const p = path.join(REPO_ROOT, 'tools', '.runtime', `${key}.json`);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('No live runtime descriptor. Run x-agent/tests/live/setup.sh first.');
}

export function liveRuntime(): Runtime {
  const rt = JSON.parse(fs.readFileSync(runtimeDescriptorPath(), 'utf8')) as {
    url: string;
    admin: { user: string; app_password: string };
  };
  return new Runtime({
    env: { X_WP_URL: rt.url, X_WP_USER: rt.admin.user, X_WP_APP_PASSWORD: rt.admin.app_password },
  });
}

export async function tool(runtime: Runtime, name: string, args: unknown = {}): Promise<any> {
  const res = await callTool(name, args, runtime);
  const data = JSON.parse(res.content[0]!.text);
  if (res.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

export const readTree = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, 'trees', name), 'utf8'));

/** Whitespace-normalised comparison, per the M3 acceptance. */
export function normaliseMarkup(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/* -------------------------------------------------- spec generation helpers */

const ROLE_FOR_BLOCK: Record<string, Region['role']> = {
  'core/cover': 'hero',
  'core/columns': 'features',
  'core/group': 'section',
  'core/column': 'column',
};

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function rgbHex(rgba: [number, number, number, number] | null): string | null {
  if (!rgba || rgba[3] === 0) return null;
  return '#' + [rgba[0], rgba[1], rgba[2]].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

/**
 * Build a DesignSpecIR out of what the page ACTUALLY measured. Slugs are only
 * attached where the measured value really is that token's value — a spec that
 * claims a colour the render does not have would be a lie the oracle would then
 * dutifully report as a diff forever.
 */
export function specFromMeasurement(nodes: readonly MeasuredNode[], palette: { slug: string; name: string; color: string }[]): DesignSpecIR {
  const named = nodes.filter((n) => n.block_name && n.box.w > 0 && n.box.h > 0);
  const minDepth = named.reduce((m, n) => Math.min(m, n.depth), Number.POSITIVE_INFINITY);
  const tops = named.filter((n) => n.depth === minDepth);
  if (tops.length === 0) throw new Error('nothing measurable on the page');

  const paletteByHex = new Map(palette.map((p) => [p.color.toLowerCase(), p.slug]));
  const slugForColor = (rgba: [number, number, number, number] | null): string | undefined => {
    const hex = rgbHex(rgba);
    if (!hex) return undefined;
    return paletteByHex.get(hex.toLowerCase());
  };

  const fontSlugs = new Map<string, number>();
  const content: DesignSpecIR['content'] = [];
  let contentSeq = 0;

  const regionFor = (n: MeasuredNode, id: string, role: Region['role'], children: MeasuredNode[]): Region => {
    const gap = n.row_gap_px ?? n.child_gap_px;
    const region: Region = {
      id,
      role,
      box: { x: round(n.box.x), y: round(n.box.y), w: round(n.box.w), h: round(n.box.h) },
      layout: {
        direction: n.computed.display.includes('flex') || n.computed.display.includes('grid') ? 'row' : 'column',
        ...(gap !== null && gap !== undefined ? { gap_px: round(gap) } : {}),
      },
    };
    const styleRefs: NonNullable<Region['style_refs']> = {};
    const fg = slugForColor(n.fg_rgba);
    const bg = slugForColor(n.bg_rgba);
    if (fg) styleRefs.palette_slug = fg;
    if (bg) styleRefs.background_palette_slug = bg;
    // One font-size slug per region, keyed off the biggest type it contains —
    // that is the size a designer names when they name a region's type scale.
    const slug = `measured-${Math.round(n.max_font_px)}`;
    fontSlugs.set(slug, n.max_font_px);
    styleRefs.font_size_slug = slug;
    if (Object.keys(styleRefs).length) region.style_refs = styleRefs;
    if (children.length) {
      region.children = children.map((c, i) =>
        regionFor(c, `${id}-${ROLE_FOR_BLOCK[c.block_name ?? ''] ?? 'item'}-${i + 1}`, ROLE_FOR_BLOCK[c.block_name ?? ''] ?? 'item', []),
      );
    }
    region.responsive_assumptions = [
      { breakpoint: '<=781px', change: 'inner columns stack; the region keeps its vertical rhythm', confidence: 'synthesized' },
    ];
    // Text inventory: the headings and buttons inside this region.
    for (const t of textsInside(n, nodes)) {
      content.push({ id: `c${++contentSeq}`, kind: t.kind, text: t.text, region_id: id });
    }
    return region;
  };

  const regions: Region[] = tops.map((n, i) => {
    const role = ROLE_FOR_BLOCK[n.block_name ?? ''] ?? 'section';
    const id = `${role}-${i + 1}`;
    const kids = nodes.filter(
      (c) =>
        c !== n &&
        c.block_name === 'core/column' &&
        c.selector_path.startsWith(n.selector_path) &&
        c.box.w > 0,
    );
    return regionFor(n, id, role, kids);
  });

  const sizes = [...fontSlugs.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([slug, px]) => ({ slug, size: `${round(px)}px` }));

  const spacingPx = [...new Set(regions.flatMap((r) => (r.layout?.gap_px ? [Math.round(r.layout.gap_px)] : [])))].sort((a, b) => a - b);
  const steps = (spacingPx.length ? spacingPx : [16, 24, 32, 48]).map((px) => ({ slug: `gap-${px}`, size: `${px}px` }));

  const layout = { contentSize: `${Math.round(tops[0]!.box.w)}px`, wideSize: `${Math.round(tops[0]!.box.w)}px` };

  const quantization_log = [
    ...palette.map((p) => ({ observed: p.color, snapped_to: p.color, delta: 0, note: `theme palette slug ${p.slug}, read from GET /manifest` })),
    ...steps.map((s) => ({ observed: s.size, snapped_to: s.size, delta: 0, note: 'measured child spacing, no snap applied' })),
    ...sizes.map((s) => ({ observed: s.size, snapped_to: s.size, delta: 0, note: 'measured computed font-size at 1440px' })),
    { observed: layout.contentSize, snapped_to: layout.contentSize, delta: 0, note: 'measured full-bleed width' },
    { observed: layout.wideSize, snapped_to: layout.wideSize, delta: 0, note: 'measured full-bleed width' },
  ];

  return {
    version: 1,
    source: { kind: 'synthesized', files: ['fixtures/golden/golden-landing.html'], viewport: VIEWPORT },
    tokens_candidates: {
      palette: palette.map((p) => ({ slug: p.slug, name: p.name, color: p.color })),
      spacing: { scale_unit: 'px', steps },
      typography: {
        families: [{ slug: 'body', name: 'Body', fontFamily: 'inherit' }],
        sizes,
      },
      layout,
      quantization_log,
    },
    content,
    regions,
  } as DesignSpecIR;
}

function textsInside(
  n: MeasuredNode,
  all: readonly MeasuredNode[],
): { kind: 'heading' | 'button' | 'paragraph' | 'other'; text: string }[] {
  const out: { kind: 'heading' | 'button' | 'paragraph' | 'other'; text: string }[] = [];
  for (const c of all) {
    if (!c.selector_path.startsWith(n.selector_path)) continue;
    if (c.block_name === 'core/heading' && c.text) out.push({ kind: 'heading', text: c.text });
    if (c.block_name === 'core/button' && c.text) out.push({ kind: 'button', text: c.text });
  }
  return out.slice(0, 6);
}

/* -------------------------------------------------------------------- main */

export interface CaptureOutput {
  goldens: Record<string, string>;
  spec: DesignSpecIR;
  images: string[];
  timings: { cold_ms: number; warm_ms: number[] };
  named_ratio: number;
}

export async function capture(runtime: Runtime, opts: { write: boolean } = { write: true }): Promise<CaptureOutput> {
  await loadExternalHandlers({ force: true });

  const goldens: Record<string, string> = {};
  const timings: { cold_ms: number; warm_ms: number[] } = { cold_ms: 0, warm_ms: [] };

  for (const [treeFile, goldenFile] of [
    ['valid-core-landing.json', 'valid-core-landing.html'],
    ['golden-landing.json', 'golden-landing.html'],
  ] as const) {
    const compiled = await tool(runtime, 'wp_compile', readTree(treeFile));
    if (!compiled.all_valid) {
      throw new Error(`${treeFile} did not compile all_valid: ${JSON.stringify(compiled.invalid)}`);
    }
    if (compiled.timing.cold) timings.cold_ms = compiled.timing.total_ms;
    else timings.warm_ms.push(compiled.timing.total_ms);
    goldens[goldenFile] = compiled.markup;
    if (opts.write) {
      const dest = path.join(FIXTURES, 'golden', goldenFile);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, compiled.markup.endsWith('\n') ? compiled.markup : compiled.markup + '\n');
      process.stderr.write(`[capture] wrote ${path.relative(REPO_ROOT, dest)} (${compiled.markup.length} bytes)\n`);
    }
  }

  /* ------------------------------------------ measure, then derive the spec */
  const ctx: Ctx = runtime.ctx({});
  const manifest = await ctx.manifestCache.get();
  const lookup = classNameMap(Object.keys(manifest.blocks));
  const themePalette = ((manifest.theme_tokens.color.palette as any)?.theme ?? []) as {
    slug: string;
    name: string;
    color: string;
  }[];
  const palette = themePalette.filter((p) => /^#[0-9a-f]{3,8}$/i.test(p.color)).map((p) => ({ slug: p.slug, name: p.name, color: p.color.toLowerCase() }));

  const target = await prepareTarget(ctx, { markup: goldens['golden-landing.html']!, viewport: VIEWPORT });
  let spec: DesignSpecIR;
  let namedRatio = 0;
  try {
    const measured = await extractLayout(target.page, lookup);
    namedRatio = measured.stats.named_ratio;
    spec = specFromMeasurement(measured.nodes, palette);
  } finally {
    await target.release();
  }

  if (opts.write) {
    const dest = path.join(FIXTURES, 'specs', 'golden-landing.json');
    fs.writeFileSync(dest, JSON.stringify(spec, null, 2) + '\n');
    process.stderr.write(`[capture] wrote ${path.relative(REPO_ROOT, dest)} (${spec.regions.length} top-level regions)\n`);
  }

  /* ------------------------------------------------------------- the images */
  const images: string[] = [];
  if (opts.write) {
    // hero-sample.png: the golden landing's hero at 1440px wide, per the
    // fixtures set in specs/agent-plugin.spec.json. Clipped to the hero region
    // measured on the page, so the crop is derived, not eyeballed.
    const heroTarget = await prepareTarget(ctx, { markup: goldens['valid-core-landing.html']!, viewport: VIEWPORT });
    try {
      const measured = await extractLayout(heroTarget.page, lookup);
      const named = measured.nodes.filter((n) => n.block_name && n.box.w > 0 && n.box.h > 0);
      const minDepth = named.reduce((m, n) => Math.min(m, n.depth), Number.POSITIVE_INFINITY);
      const hero = named.find((n) => n.depth === minDepth);
      if (!hero) throw new Error('no hero region found on the golden landing');
      const dest = path.join(FIXTURES, 'images', 'hero-sample.png');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await heroTarget.page.screenshot({
        path: dest,
        clip: { x: hero.box.x, y: hero.box.y, width: hero.box.w, height: Math.max(1, hero.box.h) },
      });
      images.push(dest);
      process.stderr.write(`[capture] wrote ${path.relative(REPO_ROOT, dest)} (hero ${Math.round(hero.box.w)}x${Math.round(hero.box.h)})\n`);
    } finally {
      await heroTarget.release();
    }

    const shot = await tool(runtime, 'wp_screenshot', {
      markup: goldens['golden-landing.html'],
      viewport: VIEWPORT,
      out_path: path.join(FIXTURES, 'images', 'golden-landing.png'),
    });
    images.push(shot.path_to_png);
    process.stderr.write(`[capture] wrote ${path.relative(REPO_ROOT, shot.path_to_png)} (${shot.bytes} bytes)\n`);
  }

  return { goldens, spec, images, timings, named_ratio: namedRatio };
}

/* ----------------------------------------------------------------- as a CLI */

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
})();

if (invokedDirectly) void main();

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const runtime = liveRuntime();
  try {
    const out = await capture(runtime, { write: !check });
    if (check) {
      let drift = 0;
      for (const [file, markup] of Object.entries(out.goldens)) {
        const dest = path.join(FIXTURES, 'golden', file);
        const onDisk = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
        const same = normaliseMarkup(onDisk) === normaliseMarkup(markup);
        process.stderr.write(`[check] ${file}: ${same ? 'MATCHES' : 'DRIFTED'}\n`);
        if (!same) drift += 1;
      }
      process.exitCode = drift === 0 ? 0 : 1;
    }
    process.stderr.write(
      `[capture] cold compile ${out.timings.cold_ms}ms, warm ${out.timings.warm_ms.join('/')}ms; ` +
        `block_name mapped for ${(out.named_ratio * 100).toFixed(1)}% of measured nodes\n`,
    );
  } finally {
    await runtime.disconnect();
  }
}
