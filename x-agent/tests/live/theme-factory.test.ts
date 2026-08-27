/**
 * Live theme-factory suite (specs/theme-factory.spec.json M2, sandbox half).
 * Opt-in: X_AGENT_THEME_LIVE=1. Boots throwaway Playgrounds on the theme port
 * range (9480-9489) — no shared instance, no setup script needed. Slow (one
 * sandbox boot per case, ~10s warm).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildAndTestTheme, scaffoldTheme, type ThemeSpec } from '../../mcp/src/themeFactory.js';

const LIVE = process.env.X_AGENT_THEME_LIVE === '1';
const d = LIVE ? describe : describe.skip;

const spec = (skeleton: ThemeSpec['skeleton']): ThemeSpec => ({
  version: 1,
  identity: {
    name: 'Salon Regale Theme',
    slug: 'salon-regale',
    description: 'A bespoke ground for the Salon Regale — gilt editorial calm.',
  },
  skeleton,
  measure: { contentSize: '680px', wideSize: '1080px' },
  physics: {
    blockGap: '1.5rem',
    rootPadding: { top: '0px', right: '24px', bottom: '0px', left: '24px' },
  },
  presets: {
    shadows: [{ slug: 'lift', name: 'Lift', shadow: '0 8px 24px rgba(0,0,0,0.12)' }],
    gradients: [],
    duotones: [],
    custom: {},
  },
});

d('wp_theme_build_test against a real throwaway Playground', () => {
  it('stacked: built:true with measured flush physics and a clamped measure', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-live-'));
    const r = scaffoldTheme(spec('stacked'), { dir: ws });
    const out = await buildAndTestTheme({ dir: r.dir });
    expect(out.failure).toBeUndefined();
    expect(out.built).toBe(true);
    expect(out.smoke.activated).toBe(true);
    expect(out.smoke.theme_name).toBe('Salon Regale Theme');
    expect(out.smoke.page_no_title_present).toBe(true);
    expect(out.measured?.root_gap_px).toBeLessThanOrEqual(1);
    expect(Math.abs((out.measured?.measure_px ?? 0) - (out.measured?.content_declared_px ?? -1))).toBeLessThanOrEqual(2);
    expect(Math.abs((out.measured?.full_px ?? 0) - (out.measured?.viewport_px ?? -1))).toBeLessThanOrEqual(1);
    expect(out.zip_path && fs.existsSync(out.zip_path)).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  }, 300_000);

  it('rail: the third area registers and the rail renders at its declared width', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-live-'));
    const r = scaffoldTheme(spec('rail'), { dir: ws });
    const out = await buildAndTestTheme({ dir: r.dir });
    expect(out.failure).toBeUndefined();
    expect(out.built).toBe(true);
    expect(out.smoke.rail_area_registered).toBe(true);
    expect(Math.abs((out.measured?.rail_px ?? 0) - (out.measured?.rail_declared_px ?? -1))).toBeLessThanOrEqual(8);
    fs.rmSync(ws, { recursive: true, force: true });
  }, 300_000);

  it('a poisoned theme (page-no-title deleted) fails the gate NAMING the template', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-live-'));
    const r = scaffoldTheme(spec('stacked'), { dir: ws });
    fs.rmSync(path.join(r.dir, 'templates', 'page-no-title.html'));
    const out = await buildAndTestTheme({ dir: r.dir });
    expect(out.built).toBe(false);
    expect(out.zip_path).toBeUndefined();
    expect(out.failure?.message).toContain('page-no-title');
    fs.rmSync(ws, { recursive: true, force: true });
  }, 300_000);
});
