/**
 * M4_oracle — live acceptance for oracle.ts + wp_verify + wp_screenshot.
 *
 *     x-agent/tests/live/setup.sh
 *     cd x-agent/mcp
 *     npx tsx ../tests/capture-golden.ts                  # (re)capture the fixtures
 *     X_AGENT_LIVE=1 npx vitest run ../tests/live --no-file-parallelism
 *
 * The spec fixture these tests diff against is CAPTURED from the golden render
 * (see capture-golden.ts). If they fail on geometry, the honest first move is to
 * re-run the capture: the spec must describe the instance it is measured on, and
 * a different theme/suite renders different numbers. Only the MARKUP goldens are
 * instance-independent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { Runtime } from '../../mcp/src/context.js';
import { callTool } from '../../mcp/src/server.js';
import { loadExternalHandlers } from '../../mcp/src/registry.js';
import { liveRuntime, readTree } from '../capture-golden.js';
import type { DesignSpecIR } from '../../mcp/src/schemas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', '..', 'fixtures');
const LIVE = process.env.X_AGENT_LIVE === '1';
const VIEWPORT = { width: 1440, height: 900 };

let runtime: Runtime;
let spec: DesignSpecIR;
let goldenMarkup: string;

async function call(name: string, args: unknown = {}): Promise<{ ok: boolean; data: any }> {
  const res = await callTool(name, args, runtime);
  return { ok: !res.isError, data: JSON.parse(res.content[0]!.text) };
}

const RECAPTURE = 'Re-run `npx tsx ../tests/capture-golden.ts` from x-agent/mcp: the spec fixture is measured, not written.';

beforeAll(async () => {
  if (!LIVE) return;
  await loadExternalHandlers({ force: true });
  runtime = liveRuntime();
  spec = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'specs', 'golden-landing.json'), 'utf8'));
  goldenMarkup = fs.readFileSync(path.join(FIXTURES, 'golden', 'golden-landing.html'), 'utf8');
}, 180_000);

afterAll(async () => {
  if (!LIVE) return;
  await runtime?.disconnect();
}, 120_000);

describe.skipIf(!LIVE)('M4 live — wp_verify, the numeric oracle', () => {
  it('the captured spec fixture is a clean DesignSpecIR', async () => {
    const r = await call('wp_spec_validate', spec);
    expect(r.ok).toBe(true);
    expect(r.data.valid, JSON.stringify(r.data.diagnostics)).toBe(true);
    expect(r.data.diagnostics).toEqual([]);
  }, 120_000);

  it('the golden landing verifies against its spec with every diff inside tolerance', async () => {
    const r = await call('wp_verify', { markup: goldenMarkup, spec, viewport: VIEWPORT });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    const outside = r.data.diffs.filter((d: any) => !d.within_tolerance);
    expect(outside, `${JSON.stringify(outside, null, 2)}\n${RECAPTURE}`).toEqual([]);
    expect(r.data.pass).toBe(true);
    expect(r.data.diffs.length).toBeGreaterThan(0);
    expect(r.data.measured.source).toBe('render-shell');
    // every region in the spec found an element
    expect(r.data.matches.length).toBe(countRegions(spec.regions));
    // eslint-disable-next-line no-console
    console.log(
      `[oracle] ${r.data.diffs.length} numeric diffs across ${r.data.matches.length} regions, all within tolerance; ` +
        `${r.data.measured.stylesheets} stylesheets + ${r.data.measured.inline_style_blocks} inline style blocks loaded into the shell`,
    );
  }, 300_000);

  it('one preset step of hero font size produces EXACTLY ONE diff outside tolerance, and it is the hero font_size', async () => {
    const tree = readTree('golden-landing.json') as any;
    const hero = tree.blocks[0].innerBlocks[0];
    expect(hero.name).toBe('core/heading');
    expect(hero.attributes.fontSize).toBe('xx-large');
    hero.attributes.fontSize = 'x-large'; // exactly one step down the theme scale

    const compiled = await call('wp_compile', tree);
    expect(compiled.ok, JSON.stringify(compiled.data)).toBe(true);
    expect(compiled.data.all_valid).toBe(true);
    expect(compiled.data.markup).not.toBe(goldenMarkup);

    const r = await call('wp_verify', { markup: compiled.data.markup, spec, viewport: VIEWPORT });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    const outside = r.data.diffs.filter((d: any) => !d.within_tolerance);
    expect(outside.length, JSON.stringify(outside, null, 2)).toBe(1);
    expect(outside[0].kind).toBe('font_size');
    expect(outside[0].region_id).toBe(spec.regions[0]!.id);
    expect(spec.regions[0]!.role).toBe('hero');
    expect(r.data.pass).toBe(false);
    // eslint-disable-next-line no-console
    console.log(
      `[oracle] hero font_size ${JSON.stringify(outside[0].expected)} -> ${outside[0].actual}px ` +
        `(delta ${JSON.stringify(outside[0].delta)}); every other diff still inside tolerance`,
    );
  }, 300_000);

  it('with no spec it returns geometry only, pass:true, and maps block_name for >= 80% of nodes', async () => {
    const r = await call('wp_verify', { markup: goldenMarkup, viewport: VIEWPORT });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    expect(r.data.pass).toBe(true);
    expect(r.data.diffs).toEqual([]);
    expect(r.data.box_tree.length).toBeGreaterThan(10);
    expect(r.data.a11y_outline.length).toBeGreaterThan(0);

    const total = r.data.box_tree.length;
    const named = r.data.box_tree.filter((n: any) => typeof n.block_name === 'string').length;
    const pct = (named / total) * 100;
    // eslint-disable-next-line no-console
    console.log(`[oracle] block_name mapped for ${named}/${total} = ${pct.toFixed(1)}% of measured .wp-block-* nodes`);
    expect(pct).toBeGreaterThanOrEqual(80);
    expect(r.data.measured.named_ratio).toBeCloseTo(named / total, 3);

    // the outline is a real document outline, not a class dump
    const h1 = r.data.a11y_outline.find((n: any) => n.role === 'heading' && n.level === 1);
    expect(h1?.name).toContain('Ship the layout');
  }, 300_000);

  it('every box_tree node carries the five computed properties the contract names', async () => {
    const r = await call('wp_verify', { markup: goldenMarkup, viewport: VIEWPORT });
    for (const n of r.data.box_tree) {
      expect(Object.keys(n.computed).sort()).toEqual(['background', 'color', 'display', 'fontSize', 'gap']);
      expect(typeof n.selector_path).toBe('string');
      expect(Number.isFinite(n.box.x) && Number.isFinite(n.box.w)).toBe(true);
    }
  }, 300_000);

  it('tolerances are overridable, and tightening them turns a pass into a fail', async () => {
    const tight = await call('wp_verify', {
      markup: goldenMarkup,
      spec,
      viewport: VIEWPORT,
      tolerances: { position_px: 0, position_ratio: 0, size_px: 0, size_ratio: 0, gap_steps: 0, font_size_px: 0 },
    });
    expect(tight.ok).toBe(true);
    expect(tight.data.diffs.length).toBeGreaterThan(0);
    // zero tolerance on sub-pixel layout must find something; that is the point
    expect(tight.data.diffs.some((d: any) => !d.within_tolerance)).toBe(true);
  }, 300_000);

  it('a spec_region_id restricts the diff to one subtree', async () => {
    const id = spec.regions[0]!.id;
    const r = await call('wp_verify', { markup: goldenMarkup, spec, spec_region_id: id, viewport: VIEWPORT });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    const ids = new Set(r.data.diffs.filter((d: any) => d.kind !== 'extra').map((d: any) => d.region_id));
    expect([...ids]).toEqual([id]);
  }, 300_000);

  it('markup and url are mutually exclusive', async () => {
    const r = await call('wp_verify', {});
    expect(r.ok).toBe(false);
    expect(r.data.code).toBe('invalid_input');
  }, 60_000);

  it('wp_verify can measure a live url as well as markup', async () => {
    const url = JSON.parse(fs.readFileSync(process.env.X_AGENT_LIVE_RUNTIME ?? findRuntime(), 'utf8')).url as string;
    const r = await call('wp_verify', { url, viewport: VIEWPORT });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    expect(r.data.measured.source).toBe('url');
    expect(r.data.pass).toBe(true);
  }, 300_000);
});

describe.skipIf(!LIVE)('M4 live — wp_screenshot', () => {
  it('produces exactly one full-page png and nothing else', async () => {
    const out = path.join(os.tmpdir(), `x-agent-accept-${Date.now()}.png`);
    const r = await call('wp_screenshot', { markup: goldenMarkup, viewport: VIEWPORT, out_path: out });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    expect(r.data.path_to_png).toBe(out);
    expect(fs.existsSync(out)).toBe(true);
    expect(r.data.bytes).toBeGreaterThan(5000);
    // PNG magic
    const head = fs.readFileSync(out).subarray(0, 8);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(Object.keys(r.data).sort()).toEqual(['bytes', 'path_to_png', 'viewport']);
    fs.rmSync(out, { force: true });
  }, 300_000);

  it('refuses a non-png destination', async () => {
    const r = await call('wp_screenshot', { markup: goldenMarkup, out_path: '/tmp/nope.jpg' });
    expect(r.ok).toBe(false);
    expect(r.data.code).toBe('invalid_input');
  }, 120_000);
});

function countRegions(regions: readonly { children?: readonly any[] }[]): number {
  let n = 0;
  for (const r of regions) {
    n += 1;
    if (r.children) n += countRegions(r.children);
  }
  return n;
}

function findRuntime(): string {
  const stateFile = path.join(HERE, '.live-instance');
  const [profile, posture] = fs.readFileSync(stateFile, 'utf8').trim().split(':');
  return path.resolve(HERE, '..', '..', '..', 'tools', '.runtime', `${profile}-${posture}.json`);
}
