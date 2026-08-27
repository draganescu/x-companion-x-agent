/**
 * The theme factory — deterministic compilation of a ThemeSpec into a complete
 * block theme (specs/theme-factory.spec.json).
 *
 * The division of authorship is absolute: the model authors ONE parameter
 * object (the ThemeSpec, validated against contract/schemas/theme-spec.schema.json,
 * zod-mirrored here); every byte on disk is produced by this module's pure
 * templating. No model call ever writes a theme file, a template, or a line of
 * theme.json — a model-authored string can surface only where the ThemeSpec
 * legitimately carries it (style.css header, theme.json values), which the
 * poisoned-spec test asserts file by file.
 *
 * A sibling of factory.ts (blocks) and schemaFactory.ts (schema packages), not
 * an extension of either: the theme is a different artifact with a different
 * gate, and only the generic primitives (interpolate, zip binding) are shared.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { createRequire } from 'node:module';
import net from 'node:net';

import { XError, errInvalidInput } from './errors.js';
import { TAG, extractPhpError, interpolate, loadAdmZip, phpJson, resolvePlaygroundCli, run } from './factory.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(import.meta.url);

/* ========================================================================== */
/* The contract, zod-mirrored                                                 */
/* ========================================================================== */

const SLUG_RE = /^[a-z][a-z0-9-]{1,48}$/;
const MEASURE_RE = /^[0-9]+(\.[0-9]+)?(px|ch|rem)$/;
const GAP_RE = /^(0|[0-9]+(\.[0-9]+)?(px|rem|em))$/;
const PAD_RE = /^(0|[0-9]+(\.[0-9]+)?(px|rem|em|vw|%))$/;
const PRESET_SLUG_RE = /^[a-z][a-z0-9-]*$/;
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const PresetBase = { slug: z.string().regex(PRESET_SLUG_RE), name: z.string().min(1) };

export const ThemeSpecSchema = z
  .object({
    version: z.literal(1),
    identity: z
      .object({
        name: z.string().min(3),
        slug: z.string().regex(SLUG_RE),
        description: z.string().min(10),
      })
      .strict(),
    skeleton: z.enum(['stacked', 'split', 'rail']),
    measure: z
      .object({
        contentSize: z.string().regex(MEASURE_RE),
        wideSize: z.string().regex(MEASURE_RE),
      })
      .strict(),
    physics: z
      .object({
        blockGap: z.string().regex(GAP_RE),
        rootPadding: z
          .object({
            top: z.string().regex(PAD_RE),
            right: z.string().regex(PAD_RE),
            bottom: z.string().regex(PAD_RE),
            left: z.string().regex(PAD_RE),
          })
          .strict(),
      })
      .strict(),
    presets: z
      .object({
        shadows: z.array(z.object({ ...PresetBase, shadow: z.string().min(3) }).strict()).max(8),
        gradients: z.array(z.object({ ...PresetBase, gradient: z.string().min(10) }).strict()).max(8),
        duotones: z
          .array(z.object({ ...PresetBase, colors: z.array(z.string().regex(HEX_RE)).length(2) }).strict())
          .max(8),
        custom: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();

export type ThemeSpec = z.infer<typeof ThemeSpecSchema>;

/**
 * The rail's declared width — a scaffolder constant, never the model's
 * (recorded decision: the ThemeSpec ships structure only; a width the section
 * lane must obey belongs to code). S9 audits the rendered rail against it.
 */
export const THEME_RAIL_WIDTH = '20rem';

/**
 * The seam reset the pipeline's S3 authors into css.global, byte-for-byte
 * (pipeline/stages/s3-tokens.mjs SEAM_RESET) — baked into theme.json styles.css
 * so the bespoke ground owns flush bands structurally.
 */
export const THEME_SEAM_RESET =
  '.wp-site-blocks > * + * { margin-block-start: 0; }\n' +
  '.wp-block-post-content > * + * { margin-block-start: 0; }';

/** Bespoke themes never shadow core's bundled namespace or the toolchain. */
const RESERVED_THEME_SLUG_RE = /^(twenty|x-companion$)/;

/* ========================================================================== */
/* Template resolution                                                        */
/* ========================================================================== */

/** `x-agent/templates/block-theme`, resolved like factory.ts templateDir(). */
export function themeTemplateDir(): string {
  const override = process.env.X_AGENT_THEME_TEMPLATE_DIR;
  if (override) {
    if (!fs.existsSync(path.join(override, 'style.css'))) {
      throw errInvalidInput(
        `X_AGENT_THEME_TEMPLATE_DIR=${override} does not contain a style.css.`,
        'Point it at x-agent/templates/block-theme, or unset it.',
      );
    }
    return override;
  }
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'templates', 'block-theme');
    if (fs.existsSync(path.join(candidate, 'style.css'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new XError(
    'internal',
    'Could not locate templates/block-theme relative to the installed x-agent package.',
    'Set X_AGENT_THEME_TEMPLATE_DIR to the absolute path of x-agent/templates/block-theme.',
  );
}

/** Where theme scaffolds land when the caller does not name a directory. */
export function defaultThemeWorkspace(): string {
  return process.env.X_AGENT_THEME_WORKSPACE || path.join(os.tmpdir(), 'x-agent-themes');
}

/* ========================================================================== */
/* theme.json compilation                                                     */
/* ========================================================================== */

/**
 * ThemeSpec -> theme.json v3 (verified key paths; see the plan's decision 11).
 * Scaffolder constants — appearanceTools, useRootPaddingAwareAlignments and
 * fluid typography — are always on; the spec carries only what varies. Empty
 * preset groups are omitted entirely: an empty array in theme.json reads as a
 * deliberate declaration, and the theme declares nothing it does not mean.
 */
export function buildThemeJson(spec: ThemeSpec): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    appearanceTools: true,
    useRootPaddingAwareAlignments: true,
    layout: { contentSize: spec.measure.contentSize, wideSize: spec.measure.wideSize },
    spacing: { blockGap: true },
    typography: { fluid: true },
  };
  const color: Record<string, unknown> = {};
  if (spec.presets.gradients.length > 0) {
    color.gradients = spec.presets.gradients.map((g) => ({ slug: g.slug, name: g.name, gradient: g.gradient }));
  }
  if (spec.presets.duotones.length > 0) {
    color.duotone = spec.presets.duotones.map((d) => ({ slug: d.slug, name: d.name, colors: [...d.colors] }));
  }
  if (Object.keys(color).length > 0) settings.color = color;
  if (spec.presets.shadows.length > 0) {
    settings.shadow = { presets: spec.presets.shadows.map((s) => ({ slug: s.slug, name: s.name, shadow: s.shadow })) };
  }
  const custom: Record<string, unknown> = { ...spec.presets.custom };
  if (spec.skeleton === 'rail') custom.railWidth = THEME_RAIL_WIDTH;
  if (Object.keys(custom).length > 0) settings.custom = custom;

  const templateParts = [
    { name: 'header', title: 'Header', area: 'header' },
    { name: 'footer', title: 'Footer', area: 'footer' },
  ];
  if (spec.skeleton === 'rail') templateParts.push({ name: 'rail', title: 'Rail', area: 'rail' });

  return {
    $schema: 'https://schemas.wp.org/trunk/theme.json',
    version: 3,
    settings,
    styles: {
      // The flush-band physics, owned structurally: core injects
      // margin-block-start between template-level blocks, and bands own their
      // rhythm through their own padding, so the theme zeroes the seams at the
      // source — S3's stage-authored SEAM_RESET (same selectors, verbatim)
      // becomes belt, not load-bearing. blockGap stays declared for every
      // INNER layout's rhythm.
      css: THEME_SEAM_RESET,
      spacing: {
        blockGap: spec.physics.blockGap,
        padding: { ...spec.physics.rootPadding },
      },
      // The typography SLOTS (measured live: a sourced font nobody renders
      // stays document.fonts "unloaded" and S9 rightly fails the promise).
      // The theme declares NO fonts — it wires body text and headings to the
      // conventional token preset slugs ('body', 'heading'), the same
      // convention the palette pins with base/contrast. The tokens gate
      // requires those family slugs on bespoke runs; until tokens apply, an
      // undefined var() simply inherits the browser default.
      typography: { fontFamily: 'var(--wp--preset--font-family--body)' },
      elements: {
        heading: { typography: { fontFamily: 'var(--wp--preset--font-family--heading)' } },
      },
    },
    customTemplates: [
      { name: 'page-no-title', title: 'Page (No Title)', postTypes: ['page'] },
      { name: 'canvas', title: 'Canvas', postTypes: ['page'] },
    ],
    templateParts,
  };
}

/* ========================================================================== */
/* Scaffold                                                                   */
/* ========================================================================== */

export interface ThemeScaffoldResult {
  dir: string;
  slug: string;
  name: string;
  files: string[];
  rail_width?: string;
}

const ROSTER_TEMPLATES = ['index.html', 'page.html', 'page-no-title.html', 'canvas.html'];

export function scaffoldTheme(input: ThemeSpec, opts: { dir?: string; force?: boolean } = {}): ThemeScaffoldResult {
  const spec = ThemeSpecSchema.parse(input);
  if (RESERVED_THEME_SLUG_RE.test(spec.identity.slug)) {
    throw errInvalidInput(
      `Theme slug "${spec.identity.slug}" is reserved.`,
      "Bespoke themes never shadow core's twenty* namespace or the companion.",
    );
  }

  const src = themeTemplateDir();
  const target = path.join(path.resolve(opts.dir ?? defaultThemeWorkspace()), spec.identity.slug);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0 && opts.force !== true) {
    throw errInvalidInput(`Target directory ${target} exists and is not empty.`, 'Pass force: true to overwrite it.');
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(target, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(target, 'parts'), { recursive: true });

  const written: string[] = [];
  const write = (rel: string, content: string): void => {
    fs.writeFileSync(path.join(target, rel), content);
    written.push(rel);
  };
  const copyStatic = (fromRel: string, toRel: string): void => {
    write(toRel, fs.readFileSync(path.join(src, fromRel), 'utf8'));
  };

  write(
    'style.css',
    interpolate(fs.readFileSync(path.join(src, 'style.css'), 'utf8'), {
      name: spec.identity.name,
      slug: spec.identity.slug,
      description: spec.identity.description,
    }),
  );
  write('theme.json', `${JSON.stringify(buildThemeJson(spec), null, '\t')}\n`);

  // Templates are STATIC per skeleton: rail swaps in its two-column variants,
  // stacked and split share the plain set (split's panes are assembled in
  // content by S8 — the template is not where a pane lives).
  for (const name of ROSTER_TEMPLATES) {
    const railVariant = path.join('templates', 'rail', name);
    const useRail = spec.skeleton === 'rail' && fs.existsSync(path.join(src, railVariant));
    copyStatic(useRail ? railVariant : path.join('templates', name), path.join('templates', name));
  }

  copyStatic(path.join('parts', 'header.html'), path.join('parts', 'header.html'));
  copyStatic(path.join('parts', 'footer.html'), path.join('parts', 'footer.html'));
  if (spec.skeleton === 'rail') {
    copyStatic(path.join('parts', 'rail.html'), path.join('parts', 'rail.html'));
    write(
      'functions.php',
      interpolate(fs.readFileSync(path.join(src, 'functions-rail.php'), 'utf8'), {
        textdomain: spec.identity.slug,
      }),
    );
  }

  const result: ThemeScaffoldResult = {
    dir: target,
    slug: spec.identity.slug,
    name: spec.identity.name,
    files: written.sort(),
  };
  if (spec.skeleton === 'rail') result.rail_width = THEME_RAIL_WIDTH;
  return result;
}

/* ========================================================================== */
/* Packaging + inspection (the install policy, asserted locally before the    */
/* wire — the companion re-checks server-side)                                */
/* ========================================================================== */

export const MAX_THEME_PACKAGE_BYTES = 5 * 1024 * 1024;

/** Deterministic zip: sorted walk, one top-level directory named after the slug. */
export function packageTheme(themeDir: string, zipPath: string): string {
  const root = path.basename(themeDir);
  const Zip = loadAdmZip();
  const zip = new Zip();
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(themeDir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relPath);
      else files.push(relPath);
    }
  };
  walk('');
  for (const rel of files) {
    zip.addFile(`${root}/${rel}`, fs.readFileSync(path.join(themeDir, rel)));
  }
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  zip.writeZip(zipPath);
  return zipPath;
}

export interface ThemePackageReport {
  ok: boolean;
  slug?: string;
  reasons: string[];
}

export function inspectThemePackage(zipPath: string): ThemePackageReport {
  const reasons: string[] = [];
  const stat = fs.statSync(zipPath);
  if (stat.size > MAX_THEME_PACKAGE_BYTES) {
    reasons.push(`package is ${stat.size} bytes; the cap is ${MAX_THEME_PACKAGE_BYTES}`);
  }
  const Zip = loadAdmZip();
  const zip = new Zip(zipPath);
  const entries = zip.getEntries();
  const roots = new Set<string>();
  for (const entry of entries) {
    const name = entry.entryName;
    if (name.includes('..') || name.startsWith('/') || name.includes('\\') || name.includes('\u0000')) {
      reasons.push(`unsafe entry path: ${name}`);
      continue;
    }
    roots.add(name.split('/')[0] ?? '');
  }
  if (roots.size !== 1) {
    reasons.push(`expected exactly one top-level directory, found ${roots.size === 0 ? 'none' : [...roots].join(', ')}`);
    return { ok: false, reasons };
  }
  const root = [...roots][0] ?? '';
  if (!SLUG_RE.test(root)) reasons.push(`top-level directory "${root}" is not a valid theme slug`);
  const has = (rel: string): boolean => entries.some((e) => e.entryName === `${root}/${rel}` && !e.isDirectory);
  if (!has('style.css')) {
    reasons.push('style.css missing');
  } else {
    const css = zip.getEntries().find((e) => e.entryName === `${root}/style.css`)?.getData().toString('utf8') ?? '';
    if (!/^\s*Theme Name\s*:\s*\S/m.test(css)) reasons.push('style.css carries no Theme Name header');
  }
  if (!has('templates/index.html')) reasons.push('templates/index.html missing — not an installable block theme');
  if (has('theme.json')) {
    const raw = zip.getEntries().find((e) => e.entryName === `${root}/theme.json`)?.getData().toString('utf8') ?? '';
    try {
      JSON.parse(raw);
    } catch (e) {
      reasons.push(`theme.json does not parse: ${(e as Error).message}`);
    }
  }
  const report: ThemePackageReport = { ok: reasons.length === 0, reasons };
  if (reasons.length === 0) report.slug = root;
  return report;
}

/* ========================================================================== */
/* The build gate — a throwaway sandbox on its own port, physics MEASURED     */
/* ========================================================================== */

const THEME_PORT_RANGE: [number, number] = [9480, 9489];
const DEFAULT_THEME_SMOKE_TIMEOUT_MS = 5 * 60 * 1000;

function themePortRange(): [number, number] {
  const raw = process.env.X_AGENT_THEME_SMOKE_PORT_RANGE;
  if (raw) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(raw.trim());
    if (m) return [Number(m[1]), Number(m[2])];
  }
  return THEME_PORT_RANGE;
}

/** First free port in the theme range (blocks own 9440-9449, schema 9460-9469). */
export async function freeThemePort(preferred?: number): Promise<number> {
  const [lo, hi] = themePortRange();
  const candidates = preferred !== undefined ? [preferred] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  for (const port of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new XError('smoke_failed', `No free port in ${lo}-${hi} for the theme sandbox.`, 'Pass an explicit port or widen X_AGENT_THEME_SMOKE_PORT_RANGE.');
}

export interface ThemeProbeOutcome {
  text: string;
  threw: boolean;
  error_text: string;
  exit_code: number | null;
}

export interface ThemePhysicsMeasured {
  root_gap_px: number;
  padding_top_px: number;
  padding_bottom_px: number;
  padding_top_declared_px: number;
  padding_bottom_declared_px: number;
  content_var: string;
  wide_var: string;
  content_declared_px: number;
  wide_declared_px: number;
  measure_px: number;
  content_box_px: number;
  full_px: number;
  wide_px: number;
  rail_px: number;
  rail_declared_px: number;
  viewport_px: number;
  body_text: string;
}

interface ThemeRunnerResult {
  booted: boolean;
  boot_ms: number;
  probes?: Record<string, ThemeProbeOutcome>;
  physics?: { url?: string; console_errors?: string[]; measured?: ThemePhysicsMeasured; error?: string };
  error: string;
}

export interface ThemeSmoke {
  activated: boolean;
  stylesheet: string;
  theme_name: string;
  templates_resolved: string[];
  templates_missing: string[];
  page_no_title_present: boolean;
  parts_resolved: string[];
  rail_area_registered?: boolean;
  php_error: string;
}

export interface ThemeBuildResult {
  built: boolean;
  smoke: ThemeSmoke;
  measured?: ThemePhysicsMeasured;
  zip_path?: string;
  build_log?: string;
  failure?: { code: 'build_failed' | 'smoke_failed'; message: string; hint: string };
  timings_ms?: { boot?: number; total: number };
}

/**
 * The theme sandbox runner — a sibling of factory.ts SMOKE_RUNNER_SOURCE with
 * the theme mount (`wp-content/themes/<slug>` + `activateTheme`) and one
 * physics pass in real Chromium instead of the block front-smoke. Same
 * discipline: the child is deliberately dumb, all interpretation happens in
 * the parent, and it is a separate process because Playground owns stdout and
 * a PHP-wasm fatal must never reach the MCP server.
 */
export const THEME_SMOKE_RUNNER_SOURCE = [
  "import fs from 'node:fs';",
  "import { pathToFileURL } from 'node:url';",
  '',
  "const cfg = JSON.parse( fs.readFileSync( process.argv[ 2 ], 'utf8' ) );",
  'const outPath = process.argv[ 3 ];',
  "const result = { booted: false, boot_ms: 0, error: '' };",
  'const write = () => { try { fs.writeFileSync( outPath, JSON.stringify( result ) ); } catch {} };',
  '',
  'async function probe( server, code ) {',
  '\ttry {',
  '\t\tconst r = await server.playground.run( { code } );',
  "\t\treturn { text: String( r.text ?? '' ), threw: false, error_text: '', exit_code: r.exitCode ?? 0 };",
  '\t} catch ( e ) {',
  "\t\tconst text = String( e?.response?.text ?? '' );",
  "\t\treturn { text, threw: true, error_text: text || String( e?.message ?? e ), exit_code: e?.response?.exitCode ?? null };",
  '\t}',
  '}',
  '',
  'let server;',
  'try {',
  '\tconst { runCLI } = await import( pathToFileURL( cfg.cliEntry ).href );',
  '\tconst t0 = Date.now();',
  '\tserver = await runCLI( {',
  "\t\tcommand: 'server',",
  '\t\tphp: cfg.php,',
  '\t\twp: cfg.wp,',
  '\t\tport: cfg.port,',
  '\t\tlogin: false,',
  "\t\tverbosity: 'quiet',",
  "\t\tmount: [ { hostPath: cfg.themeDir, vfsPath: '/wordpress/wp-content/themes/' + cfg.themeSlug } ],",
  '\t\tblueprint: {',
  '\t\t\tpreferredVersions: { php: cfg.php, wp: cfg.wp },',
  "\t\t\tsteps: [ { step: 'activateTheme', themeFolderName: cfg.themeSlug } ],",
  '\t\t},',
  '\t} );',
  '\tresult.booted = true;',
  '\tresult.boot_ms = Date.now() - t0;',
  '',
  '\tif ( cfg.probes ) {',
  '\t\tresult.probes = {};',
  '\t\tfor ( const [ id, code ] of Object.entries( cfg.probes ) ) {',
  '\t\t\tresult.probes[ id ] = await probe( server, code );',
  '\t\t}',
  '\t}',
  '',
  '\tif ( cfg.physics ) {',
  '\t\ttry {',
  '\t\t\tconst pub = await probe( server, cfg.physics.publishCode );',
  "\t\t\tconst info = JSON.parse( String( pub.text ?? '' ).split( cfg.physics.tag )[ 1 ] ?? '{}' );",
  '\t\t\tconst pw = await import( pathToFileURL( cfg.physics.playwrightEntry ).href );',
  '\t\t\tconst chromium = pw.chromium ?? pw.default?.chromium;',
  '\t\t\tconst browser = await chromium.launch( { headless: true } );',
  '\t\t\tconst page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );',
  '\t\t\tconst consoleErrors = [];',
  "\t\t\tpage.on( 'console', ( m ) => { if ( m.type() === 'error' ) consoleErrors.push( m.text() ); } );",
  "\t\t\tpage.on( 'pageerror', ( e ) => consoleErrors.push( 'pageerror: ' + e.message ) );",
  "\t\t\tawait page.goto( info.url, { waitUntil: 'networkidle', timeout: 60000 } );",
  '\t\t\tconst measured = await page.evaluate( ( declared ) => {',
  '\t\t\t\tconst pxIn = ( host, v ) => {',
  "\t\t\t\t\tconst d = document.createElement( 'div' );",
  "\t\t\t\t\td.style.position = 'absolute';",
  "\t\t\t\t\td.style.visibility = 'hidden';",
  "\t\t\t\t\td.style.maxWidth = 'none';",
  '\t\t\t\t\td.style.width = v;',
  '\t\t\t\t\t( host || document.body ).appendChild( d );',
  '\t\t\t\t\tconst w = d.getBoundingClientRect().width;',
  '\t\t\t\t\td.remove();',
  '\t\t\t\t\treturn w;',
  '\t\t\t\t};',
  "\t\t\t\tconst root = document.querySelector( '.wp-site-blocks' );",
  '\t\t\t\tconst kids = root ? [ ...root.children ].filter( ( el ) => el.getBoundingClientRect().height > 0 ) : [];',
  '\t\t\t\tlet rootGap = 0;',
  '\t\t\t\tfor ( let i = 1; i < kids.length; i += 1 ) {',
  '\t\t\t\t\tconst prev = kids[ i - 1 ].getBoundingClientRect();',
  '\t\t\t\t\tconst cur = kids[ i ].getBoundingClientRect();',
  '\t\t\t\t\trootGap = Math.max( rootGap, cur.top - prev.bottom );',
  '\t\t\t\t}',
  '\t\t\t\tconst cs = root ? getComputedStyle( root ) : null;',
  '\t\t\t\tconst rootStyle = getComputedStyle( document.documentElement );',
  "\t\t\t\tconst meas = document.querySelector( '.x-probe-measure' );",
  '\t\t\t\tconst content = meas ? meas.parentElement : document.body;',
  "\t\t\t\tconst full = document.querySelector( '.x-probe-full' );",
  "\t\t\t\tconst wide = document.querySelector( '.x-probe-wide' );",
  "\t\t\t\tconst rail = document.querySelector( 'aside.wp-block-template-part' );",
  '\t\t\t\treturn {',
  '\t\t\t\t\troot_gap_px: rootGap,',
  '\t\t\t\t\tpadding_top_px: cs ? parseFloat( cs.paddingTop ) : -1,',
  '\t\t\t\t\tpadding_bottom_px: cs ? parseFloat( cs.paddingBottom ) : -1,',
  '\t\t\t\t\tpadding_top_declared_px: pxIn( document.body, declared.rootPadding.top ),',
  '\t\t\t\t\tpadding_bottom_declared_px: pxIn( document.body, declared.rootPadding.bottom ),',
  "\t\t\t\t\tcontent_var: rootStyle.getPropertyValue( '--wp--style--global--content-size' ).trim(),",
  "\t\t\t\t\twide_var: rootStyle.getPropertyValue( '--wp--style--global--wide-size' ).trim(),",
  '\t\t\t\t\tcontent_declared_px: pxIn( content, declared.contentSize ),',
  '\t\t\t\t\twide_declared_px: pxIn( content, declared.wideSize ),',
  '\t\t\t\t\tmeasure_px: meas ? meas.getBoundingClientRect().width : -1,',
  '\t\t\t\t\tcontent_box_px: content ? content.clientWidth - parseFloat( getComputedStyle( content ).paddingLeft ) - parseFloat( getComputedStyle( content ).paddingRight ) : -1,',
  '\t\t\t\t\tfull_px: full ? full.getBoundingClientRect().width : -1,',
  '\t\t\t\t\twide_px: wide ? wide.getBoundingClientRect().width : -1,',
  '\t\t\t\t\trail_px: rail ? rail.getBoundingClientRect().width : -1,',
  '\t\t\t\t\trail_declared_px: declared.railWidth ? pxIn( document.body, declared.railWidth ) : -1,',
  '\t\t\t\t\tviewport_px: window.innerWidth,',
  "\t\t\t\t\tbody_text: ( document.body.innerText || '' ).slice( 0, 400 ),",
  '\t\t\t\t};',
  '\t\t\t}, cfg.physics.declared );',
  '\t\t\tawait browser.close();',
  '\t\t\tresult.physics = { url: info.url, console_errors: consoleErrors, measured };',
  '\t\t} catch ( e ) {',
  "\t\t\tresult.physics = { error: String( e?.message ?? e ) };",
  '\t\t}',
  '\t}',
  '} catch ( e ) {',
  "\tresult.error = String( e?.stack ?? e?.message ?? e );",
  '} finally {',
  "\ttry { if ( server ) await server[ Symbol.asyncDispose ]?.(); } catch {}",
  '\twrite();',
  '\tprocess.exit( 0 );',
  '}',
  '',
].join('\n');

/** PHP: activation + the full template/part roster, resolved by name. */
export function themeProbePhp(slug: string, rail: boolean): string {
  const parts = rail ? ['header', 'footer', 'rail'] : ['header', 'footer'];
  return `<?php
require_once '/wordpress/wp-load.php';
wp_set_current_user( 1 );

$slug      = ${phpJson(slug)};
$templates = array( 'index', 'page', 'page-no-title', 'canvas' );
$parts     = ${JSON.stringify(parts).replace('[', "array( '").replace(']', "' )").replace(/","/g, "', '").replace(/"/g, '')};
$resolved  = array();
$missing   = array();
foreach ( $templates as $t ) {
	$tpl = get_block_template( $slug . '//' . $t, 'wp_template' );
	if ( $tpl && ! empty( $tpl->content ) ) { $resolved[] = $t; } else { $missing[] = $t; }
}
$parts_ok = array();
foreach ( $parts as $p ) {
	$tpl = get_block_template( $slug . '//' . $p, 'wp_template_part' );
	if ( $tpl && ! empty( $tpl->content ) ) { $parts_ok[] = $p; }
}
$areas = array();
foreach ( get_allowed_block_template_part_areas() as $a ) { $areas[] = $a['area']; }

echo "\\n${TAG}" . wp_json_encode(
	array(
		'stylesheet'  => get_stylesheet(),
		'theme_name'  => wp_get_theme()->get( 'Name' ),
		'resolved'    => $resolved,
		'missing'     => $missing,
		'parts'       => $parts_ok,
		'areas'       => $areas,
	)
) . "${TAG}";
`;
}

/**
 * The physics page: three code-authored probes published with the
 * page-no-title template — an unaligned paragraph (the measure), a full band
 * (the viewport), a wide band (the wideSize). Test fixtures, not authorship.
 */
export const PHYSICS_PAGE_MARKUP = [
  '<!-- wp:paragraph {"className":"x-probe-measure"} -->',
  '<p class="x-probe-measure">The measure is the promise: this paragraph must sit at the declared content size.</p>',
  '<!-- /wp:paragraph -->',
  '',
  '<!-- wp:group {"className":"x-probe-full","align":"full","layout":{"type":"constrained"}} -->',
  '<div class="wp-block-group x-probe-full alignfull"><!-- wp:paragraph -->',
  '<p>The full band spans the pane the skeleton assigns it.</p>',
  '<!-- /wp:paragraph --></div>',
  '<!-- /wp:group -->',
  '',
  '<!-- wp:group {"className":"x-probe-wide","align":"wide","layout":{"type":"constrained"}} -->',
  '<div class="wp-block-group x-probe-wide alignwide"><!-- wp:paragraph -->',
  '<p>The wide band sits at the declared wide size.</p>',
  '<!-- /wp:paragraph --></div>',
  '<!-- /wp:group -->',
].join('\n');

export function publishPhysicsPagePhp(): string {
  return `<?php
require_once '/wordpress/wp-load.php';
wp_set_current_user( 1 );

$post_id = wp_insert_post(
	array(
		'post_title'   => 'x-theme physics',
		'post_status'  => 'publish',
		'post_type'    => 'page',
		'post_content' => ${phpJson(PHYSICS_PAGE_MARKUP)},
		'meta_input'   => array( '_wp_page_template' => 'page-no-title' ),
	),
	true
);

echo "\\n${TAG}" . wp_json_encode(
	is_wp_error( $post_id )
		? array( 'error' => $post_id->get_error_message() )
		: array( 'url' => get_permalink( (int) $post_id ), 'id' => (int) $post_id )
) . "${TAG}";
`;
}

function probeJson(outcome: ThemeProbeOutcome | undefined): Record<string, unknown> {
  if (!outcome) return {};
  try {
    return JSON.parse((outcome.text.split(TAG)[1] ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const tailText = (s: string, n = 4000): string => (s.length > n ? s.slice(-n) : s);

export interface ThemeBuildInput {
  dir: string;
  port?: number;
  timeout_ms?: number;
}

/**
 * The gate: sandbox boot -> activation + roster probes -> physics MEASURED in
 * real Chromium -> zip only on pass. Every failure path returns
 * built:false + failure{code,message,hint} with no zip_path.
 */
export async function buildAndTestTheme(input: ThemeBuildInput): Promise<ThemeBuildResult> {
  const started = Date.now();
  const themeDir = path.resolve(input.dir);
  if (!fs.existsSync(path.join(themeDir, 'style.css')) || !fs.existsSync(path.join(themeDir, 'templates', 'index.html'))) {
    throw errInvalidInput(
      `${themeDir} is not a scaffolded block theme (style.css + templates/index.html required).`,
      'Point dir at a wp_theme_scaffold output.',
    );
  }
  const slug = path.basename(themeDir);
  const themeJsonRaw = fs.readFileSync(path.join(themeDir, 'theme.json'), 'utf8');
  const themeJson = JSON.parse(themeJsonRaw) as {
    settings?: { layout?: { contentSize?: string; wideSize?: string }; custom?: { railWidth?: string } };
    styles?: { spacing?: { padding?: Record<string, string> } };
    templateParts?: Array<{ name: string; area?: string }>;
  };
  const rail = (themeJson.templateParts ?? []).some((p) => p.area === 'rail');

  const emptySmoke: ThemeSmoke = {
    activated: false,
    stylesheet: '',
    theme_name: '',
    templates_resolved: [],
    templates_missing: [],
    page_no_title_present: false,
    parts_resolved: [],
    php_error: '',
  };

  let playwrightEntry = '';
  try {
    playwrightEntry = localRequire.resolve('playwright');
  } catch {
    /* physics pass unavailable without playwright — treated as a build failure below */
  }
  if (!playwrightEntry) {
    return {
      built: false,
      smoke: emptySmoke,
      failure: {
        code: 'build_failed',
        message: 'playwright is not installed, so the theme physics cannot be measured.',
        hint: 'cd x-agent/mcp && npx playwright install chromium',
      },
      timings_ms: { total: Date.now() - started },
    };
  }

  const cliEntry = resolvePlaygroundCli();
  const port = await freeThemePort(input.port ?? (process.env.X_AGENT_THEME_SMOKE_PORT ? Number(process.env.X_AGENT_THEME_SMOKE_PORT) : undefined));
  const timeoutMs = input.timeout_ms ?? (process.env.X_AGENT_THEME_SMOKE_TIMEOUT_MS ? Number(process.env.X_AGENT_THEME_SMOKE_TIMEOUT_MS) : DEFAULT_THEME_SMOKE_TIMEOUT_MS);

  const runDir = path.join(themeDir, '.x-agent-build', 'smoke');
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const runnerPath = path.join(runDir, 'smoke-runner.mjs');
  const configPath = path.join(runDir, 'smoke-config.json');
  const resultPath = path.join(runDir, 'smoke-result.json');
  fs.writeFileSync(runnerPath, THEME_SMOKE_RUNNER_SOURCE, 'utf8');

  const declared: Record<string, unknown> = {
    contentSize: themeJson.settings?.layout?.contentSize ?? '',
    wideSize: themeJson.settings?.layout?.wideSize ?? '',
    rootPadding: themeJson.styles?.spacing?.padding ?? { top: '0px', right: '0px', bottom: '0px', left: '0px' },
  };
  if (rail) declared.railWidth = themeJson.settings?.custom?.railWidth ?? THEME_RAIL_WIDTH;

  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        cliEntry,
        port,
        php: process.env.X_AGENT_SMOKE_PHP || '8.3',
        wp: process.env.X_AGENT_SMOKE_WP || 'latest',
        themeDir,
        themeSlug: slug,
        probes: { roster: themeProbePhp(slug, rail) },
        physics: { publishCode: publishPhysicsPagePhp(), tag: TAG, playwrightEntry, declared },
      },
      null,
      2,
    ),
    'utf8',
  );

  const res = await run(process.execPath, [runnerPath, configPath, resultPath], { cwd: runDir, timeoutMs });
  let raw: ThemeRunnerResult | undefined;
  if (fs.existsSync(resultPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as ThemeRunnerResult;
    } catch {
      /* synthetic failure below */
    }
  }
  const log = [tailText(res.stdout), tailText(res.stderr)].filter(Boolean).join('\n');
  if (!raw || !raw.booted) {
    return {
      built: false,
      smoke: emptySmoke,
      build_log: log,
      failure: {
        code: 'build_failed',
        message: raw?.error
          ? `The theme sandbox failed to boot: ${tailText(raw.error, 800)}`
          : res.timedOut
            ? `The theme sandbox did not finish within ${timeoutMs}ms.`
            : `The theme sandbox exited with code ${res.code} without writing a result.`,
        hint: 'Read build_log; a boot failure is infrastructure, not the spec.',
      },
      timings_ms: { total: Date.now() - started },
    };
  }

  const roster = probeJson(raw.probes?.roster) as {
    stylesheet?: string;
    theme_name?: string;
    resolved?: string[];
    missing?: string[];
    parts?: string[];
    areas?: string[];
  };
  const phpErrors = Object.values(raw.probes ?? {})
    .map((p) => (p.threw ? p.error_text : extractPhpError(p.text)))
    .filter(Boolean);

  const smoke: ThemeSmoke = {
    activated: roster.stylesheet === slug,
    stylesheet: roster.stylesheet ?? '',
    theme_name: roster.theme_name ?? '',
    templates_resolved: roster.resolved ?? [],
    templates_missing: roster.missing ?? [],
    page_no_title_present: (roster.resolved ?? []).includes('page-no-title'),
    parts_resolved: roster.parts ?? [],
    php_error: phpErrors.join('\n'),
  };
  if (rail) smoke.rail_area_registered = (roster.areas ?? []).includes('rail');

  const fail = (message: string, hint = ''): ThemeBuildResult => ({
    built: false,
    smoke,
    ...(raw?.physics?.measured ? { measured: raw.physics.measured } : {}),
    build_log: log,
    failure: { code: 'smoke_failed', message, hint },
    timings_ms: { boot: raw?.boot_ms, total: Date.now() - started },
  });

  if (smoke.php_error) return fail(`PHP errors during the theme probes: ${tailText(smoke.php_error, 600)}`);
  if (!smoke.activated) return fail(`The theme did not activate: active stylesheet is "${smoke.stylesheet}", expected "${slug}".`);
  if (smoke.templates_missing.length > 0) {
    const missing = smoke.templates_missing.join(', ');
    return fail(
      smoke.templates_missing.includes('page-no-title')
        ? `Declared template "page-no-title" does not resolve — the guaranteed no-title template is missing (missing: ${missing}).`
        : `Declared template(s) do not resolve: ${missing}.`,
    );
  }
  const expectedParts = rail ? ['footer', 'header', 'rail'] : ['footer', 'header'];
  const partsSorted = [...smoke.parts_resolved].sort();
  if (JSON.stringify(partsSorted) !== JSON.stringify(expectedParts)) {
    return fail(`Template parts did not resolve: got [${partsSorted.join(', ')}], expected [${expectedParts.join(', ')}].`);
  }
  if (rail && smoke.rail_area_registered !== true) {
    return fail('The rail template-part area is not registered — functions.php must extend default_wp_template_part_areas.');
  }

  if (raw.physics?.error) return fail(`The physics pass crashed: ${tailText(raw.physics.error, 600)}`);
  const m = raw.physics?.measured;
  if (!m) return fail('The physics pass returned no measurements.');
  if (/Fatal error|Warning: |Notice: /.test(m.body_text)) {
    return fail(`The smoke page rendered PHP notices: ${m.body_text.slice(0, 200)}`);
  }
  const close = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;
  if (m.root_gap_px > 1) return fail(`Root block-gap seams measured ${m.root_gap_px.toFixed(1)}px — the flush-band physics did not hold.`);
  if (!close(m.padding_top_px, m.padding_top_declared_px, 1) || !close(m.padding_bottom_px, m.padding_bottom_declared_px, 1)) {
    return fail(
      `Root padding measured ${m.padding_top_px}px/${m.padding_bottom_px}px (top/bottom), declared resolves to ${m.padding_top_declared_px}px/${m.padding_bottom_declared_px}px.`,
    );
  }
  if (m.content_var !== declared.contentSize) {
    return fail(`--wp--style--global--content-size serves "${m.content_var}", theme.json declares "${declared.contentSize}".`);
  }
  if (!close(m.measure_px, m.content_declared_px, 2)) {
    return fail(`Content clamps at ${m.measure_px.toFixed(1)}px, the declared measure resolves to ${m.content_declared_px.toFixed(1)}px.`);
  }
  if (rail) {
    if (!close(m.rail_px, m.rail_declared_px, 8)) {
      return fail(`The rail renders at ${m.rail_px.toFixed(1)}px, declared ${m.rail_declared_px.toFixed(1)}px.`);
    }
  } else if (!close(m.full_px, m.viewport_px, 1)) {
    return fail(`A full band spans ${m.full_px.toFixed(1)}px of a ${m.viewport_px}px viewport — the Layout Cascade is broken at the source.`);
  }
  const pane = m.content_box_px > 0 ? m.content_box_px : m.viewport_px;
  const wideExpected = Math.min(m.wide_declared_px, pane);
  if (m.wide_px > 0 && !close(m.wide_px, wideExpected, 2)) {
    return fail(`A wide band spans ${m.wide_px.toFixed(1)}px, expected ${wideExpected.toFixed(1)}px.`);
  }

  const version = '1.0.0';
  const zipPath = path.join(themeDir, '.x-agent-build', `${slug}-${version}.zip`);
  packageTheme(themeDir, zipPath);
  // The zip must never contain the build dir itself.
  const inspection = inspectThemePackage(zipPath);
  if (!inspection.ok) {
    return {
      built: false,
      smoke,
      measured: m,
      build_log: log,
      failure: { code: 'build_failed', message: `Packaging failed policy: ${inspection.reasons.join('; ')}`, hint: '' },
      timings_ms: { boot: raw.boot_ms, total: Date.now() - started },
    };
  }

  return {
    built: true,
    smoke,
    measured: m,
    zip_path: zipPath,
    build_log: log,
    timings_ms: { boot: raw.boot_ms, total: Date.now() - started },
  };
}
