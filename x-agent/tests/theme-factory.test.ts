/**
 * Offline scaffolder tests for the theme factory (specs/theme-factory.spec.json M1).
 *
 * The load-bearing claims: byte-determinism (same spec twice => identical
 * trees), skeleton-driven file sets (rail emits the third part + functions.php,
 * stacked does not), and poison containment — a model-authored string can only
 * ever surface where the ThemeSpec legitimately carries it (style.css and
 * theme.json), never in a template, part, or PHP file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  MAX_THEME_PACKAGE_BYTES,
  THEME_RAIL_WIDTH,
  THEME_SMOKE_RUNNER_SOURCE,
  ThemeSpecSchema,
  buildThemeJson,
  inspectThemePackage,
  packageTheme,
  scaffoldTheme,
  themeProbePhp,
  themeTemplateDir,
  type ThemeSpec,
} from '../mcp/src/themeFactory.js';
import { loadAdmZip } from '../mcp/src/factory.js';
import { isXError, type XError } from '../mcp/src/errors.js';

let WS: string;

beforeAll(() => {
  WS = fs.mkdtempSync(path.join(os.tmpdir(), 'x-agent-theme-factory-'));
});

afterAll(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

const codeOf = (e: unknown): string => (isXError(e) ? (e as XError).code : `not-an-XError: ${String(e)}`);

const spec = (over: Partial<ThemeSpec> = {}): ThemeSpec => ({
  version: 1,
  identity: {
    name: 'Salon Regale Theme',
    slug: 'salon-regale',
    description: 'A bespoke ground for the Salon Regale — gilt editorial calm.',
  },
  skeleton: 'stacked',
  measure: { contentSize: '70ch', wideSize: '90ch' },
  physics: {
    blockGap: '1.5rem',
    rootPadding: { top: '0px', right: '24px', bottom: '0px', left: '24px' },
  },
  presets: {
    shadows: [{ slug: 'lift', name: 'Lift', shadow: '0 8px 24px rgba(0,0,0,0.12)' }],
    gradients: [{ slug: 'dusk', name: 'Dusk', gradient: 'linear-gradient(180deg, #2a1a2e 0%, #0e0a10 100%)' }],
    duotones: [{ slug: 'brass', name: 'Brass', colors: ['#2a1a2e', '#d4af37'] }],
    custom: { measureNote: 'editorial' },
  },
  ...over,
});

const readTree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relPath);
      else out[relPath] = fs.readFileSync(path.join(dir, relPath), 'utf8');
    }
  };
  walk('');
  return out;
};

const STACKED_FILES = [
  'parts/footer.html',
  'parts/header.html',
  'style.css',
  'templates/canvas.html',
  'templates/index.html',
  'templates/page-no-title.html',
  'templates/page.html',
  'theme.json',
];

describe('templates/block-theme', () => {
  it('resolves and carries the full static file set', () => {
    const dir = themeTemplateDir();
    for (const f of ['style.css', 'templates/index.html', 'templates/page-no-title.html', 'templates/canvas.html', 'templates/rail/page.html', 'parts/rail.html', 'functions-rail.php']) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    }
  });
});

describe('scaffoldTheme — determinism and file sets', () => {
  it('stacked: exact file list, byte-identical across two scaffolds', () => {
    const a = scaffoldTheme(spec(), { dir: path.join(WS, 'det-a') });
    const b = scaffoldTheme(spec(), { dir: path.join(WS, 'det-b') });
    expect(a.files).toEqual(STACKED_FILES);
    expect(a.slug).toBe('salon-regale');
    expect(a.name).toBe('Salon Regale Theme');
    expect(a.rail_width).toBeUndefined();
    expect(readTree(a.dir)).toEqual(readTree(b.dir));
  });

  it('rail: emits the third part, functions.php and the rail width; stacked does not', () => {
    const r = scaffoldTheme(spec({ skeleton: 'rail' }), { dir: path.join(WS, 'rail') });
    expect(r.files).toContain('parts/rail.html');
    expect(r.files).toContain('functions.php');
    expect(r.rail_width).toBe(THEME_RAIL_WIDTH);
    const railPage = fs.readFileSync(path.join(r.dir, 'templates/page.html'), 'utf8');
    expect(railPage).toContain('"slug":"rail"');
    const themeJson = JSON.parse(fs.readFileSync(path.join(r.dir, 'theme.json'), 'utf8'));
    expect(themeJson.settings.custom.railWidth).toBe(THEME_RAIL_WIDTH);
    expect(themeJson.templateParts).toContainEqual({ name: 'rail', title: 'Rail', area: 'rail' });

    const s = scaffoldTheme(spec(), { dir: path.join(WS, 'no-rail') });
    expect(s.files).not.toContain('parts/rail.html');
    expect(s.files).not.toContain('functions.php');
    const stackedJson = JSON.parse(fs.readFileSync(path.join(s.dir, 'theme.json'), 'utf8'));
    expect(stackedJson.templateParts).toHaveLength(2);
  });

  it('refuses an existing non-empty target without force, allows with force', () => {
    const dir = path.join(WS, 'force');
    scaffoldTheme(spec(), { dir });
    let thrown: unknown;
    try {
      scaffoldTheme(spec(), { dir });
    } catch (e) {
      thrown = e;
    }
    expect(codeOf(thrown)).toBe('invalid_input');
    expect(() => scaffoldTheme(spec(), { dir, force: true })).not.toThrow();
  });
});

describe('ThemeSpecSchema — the zod mirror', () => {
  it('accepts the fixture and rejects an unknown skeleton', () => {
    expect(ThemeSpecSchema.parse(spec())).toBeTruthy();
    const bad = ThemeSpecSchema.safeParse(spec({ skeleton: 'floating' as ThemeSpec['skeleton'] }));
    expect(bad.success).toBe(false);
  });

  it('rejects traversal and malformed slugs', () => {
    for (const slug of ['../escape', 'Upper', 'a/b', '']) {
      const s = spec();
      s.identity = { ...s.identity, slug };
      expect(ThemeSpecSchema.safeParse(s).success, slug).toBe(false);
    }
  });

  it('scaffoldTheme refuses reserved slugs', () => {
    for (const slug of ['twentytwentyfive', 'x-companion']) {
      const s = spec();
      s.identity = { ...s.identity, slug };
      let thrown: unknown;
      try {
        scaffoldTheme(s, { dir: path.join(WS, `reserved-${slug}`) });
      } catch (e) {
        thrown = e;
      }
      expect(codeOf(thrown)).toBe('invalid_input');
    }
  });
});

describe('poison containment — model strings only where the spec carries them', () => {
  it('sentinels surface only in style.css and theme.json', () => {
    const poisoned = spec({
      identity: { name: 'XPOISON-NAME', slug: 'xpoison-slug', description: 'XPOISON-DESCRIPTION padded to length' },
    });
    poisoned.presets = {
      shadows: [{ slug: 'xpoison-shadow', name: 'XPOISON-SHADOW-NAME', shadow: 'XPOISON-SHADOW-VALUE' }],
      gradients: [{ slug: 'xpoison-gradient', name: 'XPOISON-GRADIENT-NAME', gradient: 'XPOISON-GRADIENT-VALUE' }],
      duotones: [{ slug: 'xpoison-duotone', name: 'XPOISON-DUOTONE-NAME', colors: ['#111111', '#eeeeee'] }],
      custom: { xpoisonKey: 'XPOISON-CUSTOM-VALUE' },
    };
    const r = scaffoldTheme(poisoned, { dir: path.join(WS, 'poison'), force: true });
    const tree = readTree(r.dir);
    const allowed = new Set(['style.css', 'theme.json']);
    for (const [file, content] of Object.entries(tree)) {
      if (allowed.has(file)) continue;
      expect(content.includes('XPOISON'), `${file} leaked a model-authored string`).toBe(false);
      // The slug is the one identity fragment templates may carry (text domain);
      // rail's functions.php is the only file that uses it, and this spec is stacked...
      // poisoned is stacked, so no functions.php exists at all.
      expect(content.toLowerCase().includes('xpoison'), `${file} leaked the slug`).toBe(false);
    }
  });

  it('rail functions.php carries the slug as text domain and nothing else model-authored', () => {
    const poisoned = spec({
      skeleton: 'rail',
      identity: { name: 'XPOISON-NAME', slug: 'xpoison-slug', description: 'XPOISON-DESCRIPTION padded to length' },
    });
    const r = scaffoldTheme(poisoned, { dir: path.join(WS, 'poison-rail'), force: true });
    const fn = fs.readFileSync(path.join(r.dir, 'functions.php'), 'utf8');
    expect(fn).toContain("'xpoison-slug'");
    expect(fn).not.toContain('XPOISON');
  });
});

describe('packaging — the install policy asserted by reading the zip back', () => {
  it('packageTheme: one top-level dir named after the slug, deterministic bytes', () => {
    const r = scaffoldTheme(spec(), { dir: path.join(WS, 'pack'), force: true });
    const zipA = packageTheme(r.dir, path.join(WS, 'pack-a.zip'));
    const zipB = packageTheme(r.dir, path.join(WS, 'pack-b.zip'));
    expect(fs.readFileSync(zipA).equals(fs.readFileSync(zipB))).toBe(true);
    const Zip = loadAdmZip();
    const entries = new Zip(zipA).getEntries().map((e) => e.entryName);
    expect(entries.every((e) => e.startsWith('salon-regale/'))).toBe(true);
    expect(entries).toContain('salon-regale/style.css');
    expect(entries).toContain('salon-regale/templates/page-no-title.html');
    const report = inspectThemePackage(zipA);
    expect(report.ok).toBe(true);
    expect(report.slug).toBe('salon-regale');
  });

  it('inspectThemePackage names every policy violation', () => {
    const Zip = loadAdmZip();

    const noIndex = new Zip();
    noIndex.addFile('theme-x/style.css', Buffer.from('/*\nTheme Name: X Theme\n*/\n'));
    const noIndexPath = path.join(WS, 'no-index.zip');
    noIndex.writeZip(noIndexPath);
    const r1 = inspectThemePackage(noIndexPath);
    expect(r1.ok).toBe(false);
    expect(r1.reasons.join(' ')).toContain('templates/index.html');

    const noHeader = new Zip();
    noHeader.addFile('theme-x/style.css', Buffer.from('body {}'));
    noHeader.addFile('theme-x/templates/index.html', Buffer.from('<!-- wp:post-content /-->'));
    const noHeaderPath = path.join(WS, 'no-header.zip');
    noHeader.writeZip(noHeaderPath);
    expect(inspectThemePackage(noHeaderPath).reasons.join(' ')).toContain('Theme Name');

    const twoRoots = new Zip();
    twoRoots.addFile('a/style.css', Buffer.from('x'));
    twoRoots.addFile('b/style.css', Buffer.from('x'));
    const twoRootsPath = path.join(WS, 'two-roots.zip');
    twoRoots.writeZip(twoRootsPath);
    expect(inspectThemePackage(twoRootsPath).reasons.join(' ')).toContain('one top-level directory');

    const badJson = new Zip();
    badJson.addFile('theme-x/style.css', Buffer.from('/*\nTheme Name: X Theme\n*/\n'));
    badJson.addFile('theme-x/templates/index.html', Buffer.from('<!-- wp:post-content /-->'));
    badJson.addFile('theme-x/theme.json', Buffer.from('{nope'));
    const badJsonPath = path.join(WS, 'bad-json.zip');
    badJson.writeZip(badJsonPath);
    expect(inspectThemePackage(badJsonPath).reasons.join(' ')).toContain('theme.json does not parse');

    const oversize = new Zip();
    oversize.addFile('theme-x/style.css', Buffer.from('/*\nTheme Name: X Theme\n*/\n'));
    oversize.addFile('theme-x/templates/index.html', Buffer.from('<!-- wp:post-content /-->'));
    oversize.addFile('theme-x/blob.bin', crypto.randomBytes(MAX_THEME_PACKAGE_BYTES + 1));
    const oversizePath = path.join(WS, 'oversize.zip');
    oversize.writeZip(oversizePath);
    expect(inspectThemePackage(oversizePath).reasons.join(' ')).toMatch(/cap is/);
  });
});

describe('the sandbox runner and probes', () => {
  it('the theme runner mounts the themes path and activates by folder name', () => {
    expect(THEME_SMOKE_RUNNER_SOURCE).toContain("'/wordpress/wp-content/themes/' + cfg.themeSlug");
    expect(THEME_SMOKE_RUNNER_SOURCE).toContain("step: 'activateTheme'");
    expect(THEME_SMOKE_RUNNER_SOURCE).not.toContain('activatePlugin');
  });

  it('the roster probe asserts page-no-title by name and reads allowed areas', () => {
    const php = themeProbePhp('salon-regale', true);
    expect(php).toContain("'page-no-title'");
    expect(php).toContain('get_allowed_block_template_part_areas');
    expect(php).toContain("'rail'");
    expect(themeProbePhp('salon-regale', false)).not.toContain("'rail'");
  });
});

describe('buildThemeJson — the physics and presets land at the verified v3 paths', () => {
  it('maps every ThemeSpec field to its theme.json v3 home', () => {
    const t = buildThemeJson(spec()) as Record<string, any>;
    expect(t.version).toBe(3);
    expect(t.settings.layout).toEqual({ contentSize: '70ch', wideSize: '90ch' });
    expect(t.settings.spacing.blockGap).toBe(true);
    expect(t.styles.spacing.blockGap).toBe('1.5rem');
    expect(t.styles.css).toContain('.wp-site-blocks > * + * { margin-block-start: 0; }');
    expect(t.styles.css).toContain('.wp-block-post-content > * + * { margin-block-start: 0; }');
    expect(t.styles.spacing.padding).toEqual({ top: '0px', right: '24px', bottom: '0px', left: '24px' });
    expect(t.settings.useRootPaddingAwareAlignments).toBe(true);
    expect(t.settings.appearanceTools).toBe(true);
    expect(t.settings.typography.fluid).toBe(true);
    expect(t.settings.shadow.presets).toEqual([{ slug: 'lift', name: 'Lift', shadow: '0 8px 24px rgba(0,0,0,0.12)' }]);
    expect(t.settings.color.gradients).toEqual([{ slug: 'dusk', name: 'Dusk', gradient: 'linear-gradient(180deg, #2a1a2e 0%, #0e0a10 100%)' }]);
    expect(t.settings.color.duotone).toEqual([{ slug: 'brass', name: 'Brass', colors: ['#2a1a2e', '#d4af37'] }]);
    expect(t.settings.custom).toEqual({ measureNote: 'editorial' });
    expect(t.customTemplates).toEqual([
      { name: 'page-no-title', title: 'Page (No Title)', postTypes: ['page'] },
      { name: 'canvas', title: 'Canvas', postTypes: ['page'] },
    ]);
    expect(t.templateParts).toEqual([
      { name: 'header', title: 'Header', area: 'header' },
      { name: 'footer', title: 'Footer', area: 'footer' },
    ]);
  });

  it('omits empty preset groups instead of writing empty arrays', () => {
    const s = spec();
    s.presets = { shadows: [], gradients: [], duotones: [], custom: {} };
    const t = buildThemeJson(s) as Record<string, any>;
    expect(t.settings.shadow).toBeUndefined();
    expect(t.settings.color).toBeUndefined();
    expect(t.settings.custom).toBeUndefined();
  });
});
