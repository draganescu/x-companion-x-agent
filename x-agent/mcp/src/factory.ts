/**
 * ============================================================================
 * THE BLOCK FACTORY — scaffold, build, smoke-test, package, install.
 * ============================================================================
 *
 * Step 3 of the vocabulary-gap ladder. Everything here exists to answer one
 * question honestly: *is this PHP safe to put on a WordPress instance?*
 *
 * WHY THIS FILE IS THE SAFETY GATE
 * --------------------------------
 * `POST /blocks/install` (CONTRACT.md §5) does **structural** validation only —
 * "No `php -l`, no `exec`". The companion will happily accept a package whose
 * `render.php` is a parse error waiting to fatal the front page. The contract
 * puts the real gate here, on the agent side:
 *
 *     build -> stage the exact bytes that will ship -> boot a throwaway
 *     WordPress -> register the block -> assert it in /wp/v2/block-types ->
 *     render it -> only then zip.
 *
 * A failure at any step returns structured detail and **no zip**, so there is
 * nothing for `wp_block_install` to send. `wp_block_build_test` is the only
 * producer of `zip_path` and `wp_block_install` is the only consumer.
 *
 * ALWAYS DYNAMIC
 * --------------
 * The spec's non-goals say "No static block generation under any
 * circumstances." There is no code path in this file that emits a `save()`
 * returning markup: the scaffolded `src/index.js` hard-codes `save: () => null`
 * and `block.json` always carries a `render` entry. A static block freezes its
 * output into every post that uses it, which makes the markup un-fixable after
 * the fact and makes `wp_verify` lie.
 *
 * PROCESS ISOLATION
 * -----------------
 * stdout of this process is the MCP stdio transport. `@wp-playground/cli` boots
 * worker threads and an Express server and is under no obligation to keep quiet,
 * and a PHP-wasm fatal is a real crash. So the Playground smoke test runs in a
 * **child `node` process** whose stdout/stderr are piped into a log string and
 * whose result comes back through a JSON file. Nothing it prints can corrupt the
 * MCP wire, and nothing it crashes can take the server down.
 *
 * NO `fetch` HERE
 * ---------------
 * Per the seam contract (context.ts note 3) `companion.ts` is the only HTTP
 * surface. The smoke test never speaks HTTP at all: it dispatches
 * `/wp/v2/block-types` and the block renderer through `rest_do_request()` inside
 * the sandbox, which is both faster and immune to auth plumbing.
 * ============================================================================
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerFactoryProvider, type Ctx } from './context.js';
import { XError, errInvalidInput } from './errors.js';
import type { Logger } from './companion.js';

/* ========================================================================== */
/* Types                                                                      */
/* ========================================================================== */

export type AttributeControl = 'text' | 'textarea' | 'number' | 'toggle' | 'select';
export type AttributeType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

export interface ScaffoldAttribute {
  name: string;
  type: AttributeType;
  default?: unknown;
  control: AttributeControl;
  options?: { label: string; value: string }[];
}

export interface ScaffoldInput {
  slug: string;
  title: string;
  attributes?: ScaffoldAttribute[];
  render_intent: string;
  /** Parent directory the scaffold is created *inside*. Defaults to the workspace. */
  dir?: string;
  description?: string;
  version?: string;
  /** Overwrite an existing scaffold directory instead of refusing. */
  force?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  name: string;
  files: string[];
}

export interface BuildTestInput {
  dir: string;
  sample_attributes?: Record<string, unknown>;
  /** Hard ceiling for `npm install` + `wp-scripts build`, ms. */
  timeout_ms?: number;
  /** Hard ceiling for the Playground boot + smoke, ms. */
  smoke_timeout_ms?: number;
  /** Re-run the dependency install even when node_modules is already there. */
  force_install?: boolean;
  /** Fixed port for the sandbox; otherwise the first free port in the range. */
  port?: number;
}

export interface SmokeResult {
  registered: boolean;
  rendered_html: string;
  php_error?: string;
}

export interface PackageEntry {
  name: string;
  bytes: number;
}

export interface BuildTestResult {
  built: boolean;
  smoke: SmokeResult;
  zip_path?: string;
  build_log?: string;
  failure?: { code: 'build_failed' | 'smoke_failed'; message: string; hint: string };
  package?: { entries: PackageEntry[]; zip_bytes: number; uncompressed_bytes: number };
  timings_ms?: Record<string, number>;
  deviations?: string[];
}

/* ========================================================================== */
/* Constants + environment knobs                                              */
/* ========================================================================== */

/** CONTRACT.md §5: `name` must match `^agent/[a-z0-9-]+$`. */
export const BLOCK_NAMESPACE = 'agent';
export const SLUG_RE = /^[a-z0-9-]+$/;
export const BLOCK_NAME_RE = /^agent\/[a-z0-9-]+$/;
/** CONTRACT.md §5: "total size ≤ 5 MB". */
export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;

const DEFAULT_WP_SCRIPTS_VERSION = '^34.0.0';
const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 5 * 60_000;
/** Ports the smoke sandbox may bind. Overridable so parallel agents do not collide. */
const DEFAULT_PORT_RANGE: [number, number] = [9440, 9449];

const BUILD_DIRNAME = '.x-agent-build';
const SMOKE_PLUGIN_SLUG = 'x-agent-smoke';

const here = path.dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(import.meta.url);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function portRange(): [number, number] {
  const raw = process.env.X_AGENT_SMOKE_PORT_RANGE;
  if (raw) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(raw.trim());
    if (m) return [Number(m[1]), Number(m[2])];
  }
  return DEFAULT_PORT_RANGE;
}

/** Where scaffolds land when the caller does not name a directory. */
export function defaultWorkspace(): string {
  return process.env.X_AGENT_BLOCK_WORKSPACE || path.join(os.tmpdir(), 'x-agent-blocks');
}

/* ========================================================================== */
/* adm-zip — no bundled types, so bind it through a minimal typed surface      */
/* ========================================================================== */

export interface ZipEntry {
  entryName: string;
  isDirectory: boolean;
  header: { size: number; compressedSize: number };
  getData(): Buffer;
}
export interface ZipArchive {
  addFile(entryName: string, data: Buffer): void;
  getEntries(): ZipEntry[];
  writeZip(target: string): void;
  toBuffer(): Buffer;
}
export type ZipCtor = new (existing?: string) => ZipArchive;

/** `adm-zip` ships no `.d.ts`; this is the only place that knows that. */
export function loadAdmZip(): ZipCtor {
  return localRequire('adm-zip') as ZipCtor;
}

/* ========================================================================== */
/* Template resolution                                                        */
/* ========================================================================== */

/**
 * `x-agent/templates/dynamic-block`. Resolved by walking up from this module so
 * it works from `src/` (tsx/vitest) and from a compiled `dist/` tree alike.
 */
export function templateDir(): string {
  const override = process.env.X_AGENT_BLOCK_TEMPLATE_DIR;
  if (override) {
    if (!fs.existsSync(path.join(override, 'block.json'))) {
      throw errInvalidInput(
        `X_AGENT_BLOCK_TEMPLATE_DIR=${override} does not contain a block.json.`,
        'Point it at x-agent/templates/dynamic-block, or unset it.',
      );
    }
    return override;
  }
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'templates', 'dynamic-block');
    if (fs.existsSync(path.join(candidate, 'block.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new XError(
    'internal',
    'Could not locate templates/dynamic-block relative to the installed x-agent package.',
    'Set X_AGENT_BLOCK_TEMPLATE_DIR to the absolute path of x-agent/templates/dynamic-block.',
  );
}

/* ========================================================================== */
/* Interpolation                                                              */
/* ========================================================================== */

const PLACEHOLDER_RE = /\{\{([a-z0-9_]+)\}\}/g;

/**
 * Single-pass `{{key}}` substitution. Single pass on purpose: an attribute
 * default that happens to contain `{{...}}` must never be re-expanded.
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  const missing = new Set<string>();
  const out = template.replace(PLACEHOLDER_RE, (whole, key: string) => {
    if (!(key in vars)) {
      missing.add(key);
      return whole;
    }
    return vars[key] ?? '';
  });
  if (missing.size) {
    throw new XError(
      'internal',
      `Template placeholder(s) with no value: ${[...missing].join(', ')}.`,
      'The template and the scaffolder disagree; this is an agent-side bug.',
    );
  }
  return out;
}

/* ========================================================================== */
/* Validation                                                                 */
/* ========================================================================== */

const RESERVED_SLUGS = new Set(['build', 'src', 'node_modules', 'core', 'agent']);

export function assertSlug(slug: unknown): string {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw errInvalidInput('slug is required and must be a string.', 'Pass a lowercase slug like "pricing-card".');
  }
  // Traversal, separators and uppercase are all caught by the regex, but say so
  // explicitly: this is the check that keeps a scaffold inside its workspace.
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\') || path.isAbsolute(slug)) {
    throw errInvalidInput(
      `slug "${slug}" contains a path separator or a traversal segment.`,
      'The slug is a single path segment matching ^[a-z0-9-]+$ — it becomes the block directory name and the block name agent/{slug}.',
      { slug },
    );
  }
  if (!SLUG_RE.test(slug)) {
    throw errInvalidInput(
      `slug "${slug}" does not match ^[a-z0-9-]+$.`,
      'Use lowercase letters, digits and hyphens only — no uppercase, no underscores, no dots, no spaces.',
      { slug },
    );
  }
  if (slug.startsWith('-') || slug.endsWith('-')) {
    throw errInvalidInput(`slug "${slug}" may not start or end with a hyphen.`, 'Use e.g. "pricing-card".', { slug });
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw errInvalidInput(`slug "${slug}" is reserved.`, 'Pick a slug that names the block, e.g. "pricing-card".', { slug });
  }
  return slug;
}

const JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function assertAttributes(input: unknown): ScaffoldAttribute[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw errInvalidInput('attributes must be an array.', 'Pass [{name,type,control,default?,options?}, ...].');
  }
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const a = raw as Partial<ScaffoldAttribute>;
    if (!a || typeof a.name !== 'string' || !JS_IDENT_RE.test(a.name)) {
      throw errInvalidInput(
        `attributes[${i}].name must be a JavaScript identifier (it becomes a block.json attribute key).`,
        'Use camelCase, e.g. "planName".',
      );
    }
    if (seen.has(a.name)) throw errInvalidInput(`attributes[${i}].name "${a.name}" is declared twice.`, 'Attribute names must be unique.');
    seen.add(a.name);

    const type = a.type ?? 'string';
    if (!['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(type)) {
      throw errInvalidInput(`attributes[${i}].type "${String(type)}" is not a block attribute type.`, 'Use string|number|integer|boolean|array|object.');
    }
    const control = a.control ?? 'text';
    if (!['text', 'textarea', 'number', 'toggle', 'select'].includes(control)) {
      throw errInvalidInput(`attributes[${i}].control "${String(control)}" is unknown.`, 'Use text|textarea|number|toggle|select.');
    }
    if (control === 'select' && (!Array.isArray(a.options) || a.options.length === 0)) {
      throw errInvalidInput(`attributes[${i}] uses control "select" but declares no options.`, 'Pass options: [{label, value}, ...].');
    }
    const out: ScaffoldAttribute = { name: a.name, type: type as AttributeType, control: control as AttributeControl };
    if (a.default !== undefined) out.default = a.default;
    if (a.options) out.options = a.options;
    return out;
  });
}

/* ========================================================================== */
/* Code generation helpers                                                    */
/* ========================================================================== */

export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

export function snake(name: string): string {
  return kebab(name).replace(/-/g, '_');
}

function jsString(v: string): string {
  return JSON.stringify(v);
}

/** A PHP literal for a JSON-ish default value. */
export function phpLiteral(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) return `array( ${value.map(phpLiteral).join(', ')} )`;
  if (typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${phpLiteral(k)} => ${phpLiteral(v)}`);
    return `array( ${parts.join(', ')} )`;
  }
  return 'null';
}

function fallbackDefault(a: ScaffoldAttribute): unknown {
  if (a.default !== undefined) return a.default;
  switch (a.type) {
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return 0;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return '';
  }
}

/** block.json `attributes` object. Always an object, `{}` when none declared. */
export function attributesJson(attrs: ScaffoldAttribute[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs) {
    const entry: Record<string, unknown> = { type: a.type };
    if (a.default !== undefined) entry.default = a.default;
    if (a.control === 'select' && a.options) entry.enum = a.options.map((o) => o.value);
    out[a.name] = entry;
  }
  return out;
}

/** Unique `$snake_case` PHP local per attribute. */
function phpLocals(attrs: ScaffoldAttribute[]): Map<string, string> {
  const used = new Set<string>(['attributes', 'content', 'block', 'wrapper_attributes']);
  const map = new Map<string, string>();
  for (const a of attrs) {
    let name = snake(a.name) || 'attr';
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${name}_${i}`)) i += 1;
      name = `${name}_${i}`;
    }
    used.add(name);
    map.set(a.name, name);
  }
  return map;
}

/**
 * The render intent, verbatim, as a PHPDoc comment body. `*\u200b/` is neutralised so
 * an intent that mentions a comment terminator cannot close the docblock early
 * and turn the scaffold into a parse error.
 */
function renderIntentComment(intent: string): string {
  return String(intent)
    .replace(/\*\//g, '* /')
    .split(/\r?\n/)
    .map((line) => (line.trim() ? ` * ${line.replace(/\s+$/, '')}` : ' *'))
    .join('\n');
}

export function renderAttributeLocals(attrs: ScaffoldAttribute[]): string {
  if (attrs.length === 0) return '// This block declares no attributes.';
  const locals = phpLocals(attrs);
  return attrs
    .map((a) => {
      const v = locals.get(a.name)!;
      return `$${v} = isset( $attributes[${phpLiteral(a.name)}] ) ? $attributes[${phpLiteral(a.name)}] : ${phpLiteral(fallbackDefault(a))};`;
    })
    .join('\n');
}

export function renderAttributeOutput(attrs: ScaffoldAttribute[], cssClass: string, textdomain = 'agent'): string {
  if (attrs.length === 0) {
    return `\t<?php echo esc_html( $content ); ?>`;
  }
  const locals = phpLocals(attrs);
  return attrs
    .map((a) => {
      const v = `$${locals.get(a.name)!}`;
      const cls = `${cssClass}__${kebab(a.name)}`;
      if (a.control === 'toggle' || a.type === 'boolean') {
        return `\t<?php if ( ${v} ) : ?><span class="${cls}"><?php echo esc_html__( ${phpLiteral(labelFor(a.name))}, ${phpLiteral(textdomain)} ); ?></span><?php endif; ?>`;
      }
      if (a.type === 'array' || a.type === 'object') {
        return `\t<div class="${cls}"><?php echo esc_html( (string) wp_json_encode( ${v} ) ); ?></div>`;
      }
      if (a.control === 'textarea') {
        return `\t<div class="${cls}"><?php echo wp_kses_post( wpautop( (string) ${v} ) ); ?></div>`;
      }
      return `\t<div class="${cls}"><?php echo esc_html( (string) ${v} ); ?></div>`;
    })
    .join('\n');
}

const CTRL_INDENT = '\t\t\t\t\t';

export function renderInspectorControls(attrs: ScaffoldAttribute[], textdomain: string): string {
  if (attrs.length === 0) {
    return `${CTRL_INDENT}<p>{ __( 'This block declares no attributes yet.', ${jsString(textdomain)} ) }</p>`;
  }
  return attrs
    .map((a) => {
      const label = jsString(labelFor(a.name));
      const td = jsString(textdomain);
      const set = (expr: string) => `setAttributes( { ${a.name}: ${expr} } )`;
      if (a.control === 'toggle') {
        return [
          `${CTRL_INDENT}<ToggleControl`,
          `${CTRL_INDENT}\tlabel={ __( ${label}, ${td} ) }`,
          `${CTRL_INDENT}\tchecked={ !! attributes.${a.name} }`,
          `${CTRL_INDENT}\tonChange={ ( value ) => ${set('value')} }`,
          `${CTRL_INDENT}/>`,
        ].join('\n');
      }
      if (a.control === 'select') {
        const options = (a.options ?? []).map((o) => `{ label: __( ${jsString(o.label)}, ${td} ), value: ${jsString(o.value)} }`).join(', ');
        return [
          `${CTRL_INDENT}<SelectControl`,
          `${CTRL_INDENT}\tlabel={ __( ${label}, ${td} ) }`,
          `${CTRL_INDENT}\tvalue={ attributes.${a.name} }`,
          `${CTRL_INDENT}\toptions={ [ ${options} ] }`,
          `${CTRL_INDENT}\tonChange={ ( value ) => ${set('value')} }`,
          `${CTRL_INDENT}/>`,
        ].join('\n');
      }
      if (a.control === 'textarea') {
        return [
          `${CTRL_INDENT}<TextareaControl`,
          `${CTRL_INDENT}\tlabel={ __( ${label}, ${td} ) }`,
          `${CTRL_INDENT}\tvalue={ attributes.${a.name} }`,
          `${CTRL_INDENT}\tonChange={ ( value ) => ${set('value')} }`,
          `${CTRL_INDENT}/>`,
        ].join('\n');
      }
      if (a.control === 'number') {
        const cast = a.type === 'integer' ? 'parseInt( value, 10 )' : 'Number( value )';
        return [
          `${CTRL_INDENT}<TextControl`,
          `${CTRL_INDENT}\ttype="number"`,
          `${CTRL_INDENT}\tlabel={ __( ${label}, ${td} ) }`,
          `${CTRL_INDENT}\tvalue={ attributes.${a.name} }`,
          `${CTRL_INDENT}\tonChange={ ( value ) => ${set(`value === '' ? undefined : ${cast}`)} }`,
          `${CTRL_INDENT}/>`,
        ].join('\n');
      }
      return [
        `${CTRL_INDENT}<TextControl`,
        `${CTRL_INDENT}\tlabel={ __( ${label}, ${td} ) }`,
        `${CTRL_INDENT}\tvalue={ attributes.${a.name} }`,
        `${CTRL_INDENT}\tonChange={ ( value ) => ${set('value')} }`,
        `${CTRL_INDENT}/>`,
      ].join('\n');
    })
    .join('\n');
}

const PREVIEW_INDENT = '\t\t\t\t';

export function renderEditorPreview(attrs: ScaffoldAttribute[], cssClass: string, title: string): string {
  if (attrs.length === 0) {
    return `${PREVIEW_INDENT}<p className="${cssClass}__placeholder">{ ${jsString(title)} }</p>`;
  }
  return attrs
    .map((a) => {
      const cls = `${cssClass}__${kebab(a.name)}`;
      let expr: string;
      if (a.control === 'toggle' || a.type === 'boolean') expr = `String( !! attributes.${a.name} )`;
      else if (a.type === 'array' || a.type === 'object') expr = `JSON.stringify( attributes.${a.name} )`;
      else if (a.type === 'number' || a.type === 'integer') expr = `String( attributes.${a.name} )`;
      else expr = `attributes.${a.name}`;
      return `${PREVIEW_INDENT}<div className="${cls}">{ ${expr} }</div>`;
    })
    .join('\n');
}

function labelFor(name: string): string {
  const words = kebab(name).split('-').filter(Boolean);
  if (words.length === 0) return name;
  const first = words[0] ?? '';
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

/* ========================================================================== */
/* Scaffold                                                                   */
/* ========================================================================== */

export const SCAFFOLD_FILES = ['block.json', 'render.php', 'package.json', 'src/index.js', 'src/edit.js'] as const;

export function scaffold(input: ScaffoldInput): ScaffoldResult {
  const slug = assertSlug(input.slug);
  const attrs = assertAttributes(input.attributes);
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : labelFor(slug);
  const renderIntent = typeof input.render_intent === 'string' ? input.render_intent : '';
  if (!renderIntent.trim()) {
    throw errInvalidInput(
      'render_intent is required.',
      'Describe in plain language what render.php must output; it is embedded in the file as the comment you then implement against.',
    );
  }

  const parent = path.resolve(input.dir ?? defaultWorkspace());
  const dir = path.join(parent, slug);
  if (path.relative(parent, dir).startsWith('..')) {
    throw errInvalidInput(`Refusing to scaffold outside ${parent}.`, 'Check the slug and dir arguments.');
  }
  if (fs.existsSync(dir)) {
    const notEmpty = fs.readdirSync(dir).length > 0;
    if (notEmpty && !input.force) {
      throw errInvalidInput(
        `${dir} already exists and is not empty.`,
        'Pass force:true to overwrite it, or scaffold into a different dir.',
        { dir },
      );
    }
    if (notEmpty) fs.rmSync(dir, { recursive: true, force: true });
  }

  const textdomain = `${BLOCK_NAMESPACE}-${slug}`;
  const cssClass = `${BLOCK_NAMESPACE}-${slug}`;
  const version = input.version ?? '0.1.0';
  const description = input.description ?? `${title} — dynamic block scaffolded by x-agent.`;

  const vars: Record<string, string> = {
    slug,
    title,
    description,
    version,
    textdomain,
    css_class: cssClass,
    wp_scripts_version: process.env.X_AGENT_WP_SCRIPTS_VERSION || DEFAULT_WP_SCRIPTS_VERSION,
    attributes_json: indentJson(attributesJson(attrs), '\t'),
    render_intent_comment: renderIntentComment(renderIntent),
    attribute_locals: renderAttributeLocals(attrs),
    attribute_output: renderAttributeOutput(attrs, cssClass, textdomain),
    inspector_controls: renderInspectorControls(attrs, textdomain),
    editor_preview: renderEditorPreview(attrs, cssClass, title),
  };

  const tpl = templateDir();
  const written: string[] = [];
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const rel of SCAFFOLD_FILES) {
    const src = path.join(tpl, rel);
    if (!fs.existsSync(src)) {
      throw new XError('internal', `Template file missing: ${rel}`, 'The x-agent templates/dynamic-block directory is incomplete.');
    }
    const out = interpolate(fs.readFileSync(src, 'utf8'), vars);
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out, 'utf8');
    written.push(rel);
  }

  // Fail loudly rather than ship a block.json that WordPress will reject.
  const blockJsonPath = path.join(dir, 'block.json');
  let parsedBlockJson: Record<string, unknown>;
  try {
    parsedBlockJson = JSON.parse(fs.readFileSync(blockJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new XError('internal', `The scaffolded block.json is not valid JSON: ${(e as Error).message}`, 'This is an agent-side template bug.');
  }
  if (parsedBlockJson.name !== `${BLOCK_NAMESPACE}/${slug}` || parsedBlockJson.apiVersion !== 3 || typeof parsedBlockJson.render !== 'string') {
    throw new XError(
      'internal',
      'The scaffolded block.json is missing apiVersion 3, the agent/ name, or the render entry.',
      'This is an agent-side template bug.',
    );
  }

  return { dir, name: `${BLOCK_NAMESPACE}/${slug}`, files: written.sort() };
}

function indentJson(value: unknown, indent: string): string {
  return JSON.stringify(value, null, '\t')
    .split('\n')
    .map((line, i) => (i === 0 ? line : indent + line))
    .join('\n');
}

/* ========================================================================== */
/* Package staging + zip (CONTRACT.md §5 install policy)                      */
/* ========================================================================== */

export interface BlockMetadata {
  name: string;
  version: string;
  render: string;
  /** Every `file:./…` reference in block.json, as repo-relative posix paths. */
  fileRefs: string[];
  raw: Record<string, unknown>;
}

const FILE_REF_KEYS = ['render', 'editorScript', 'script', 'viewScript', 'viewScriptModule', 'editorStyle', 'style', 'viewStyle'];

export function readBlockMetadata(dir: string): BlockMetadata {
  const p = path.join(dir, 'block.json');
  if (!fs.existsSync(p)) {
    throw errInvalidInput(`${dir} has no block.json.`, 'Pass the directory returned by wp_block_scaffold.', { dir });
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw errInvalidInput(`${p} is not valid JSON: ${(e as Error).message}`, 'Fix block.json and run wp_block_build_test again.');
  }
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!BLOCK_NAME_RE.test(name)) {
    throw errInvalidInput(
      `block.json name "${name}" does not match ^agent/[a-z0-9-]+$.`,
      'The companion install policy pins the agent/ namespace; re-scaffold rather than renaming by hand.',
    );
  }
  const render = typeof raw.render === 'string' ? raw.render : '';
  if (!render) {
    throw errInvalidInput(
      'block.json has no "render" entry.',
      'This factory only produces DYNAMIC blocks. A block without render is a static block, and static blocks are never generated.',
    );
  }
  const fileRefs: string[] = [];
  for (const key of FILE_REF_KEYS) {
    const v = raw[key];
    const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
    for (const item of list) {
      if (typeof item === 'string' && item.startsWith('file:')) {
        fileRefs.push(item.slice('file:'.length).replace(/^\.\//, ''));
      }
    }
  }
  return { name, version: typeof raw.version === 'string' ? raw.version : '0.1.0', render, fileRefs, raw };
}

/** Files that belong in the shipped package, relative to the block root. */
export function packageFileList(dir: string, meta: BlockMetadata): string[] {
  const files = new Set<string>(['block.json']);
  for (const ref of meta.fileRefs) files.add(ref);
  // `index.asset.php` is not referenced by block.json but WordPress reads it
  // next to every `file:` script to learn its dependencies and version.
  for (const ref of meta.fileRefs) {
    if (ref.endsWith('.js')) {
      const asset = ref.replace(/\.js$/, '.asset.php');
      if (fs.existsSync(path.join(dir, asset))) files.add(asset);
    }
  }
  for (const extra of ['readme.txt', 'style.css']) {
    if (fs.existsSync(path.join(dir, extra))) files.add(extra);
  }
  return [...files].sort();
}

export interface StageResult {
  stageDir: string;
  blockDir: string;
  slug: string;
  meta: BlockMetadata;
  files: string[];
  missing: string[];
}

/**
 * Copy exactly the bytes that will ship into `<dir>/.x-agent-build/plugin/<slug>`,
 * alongside a one-line loader plugin. The smoke test mounts this directory, so
 * the sandbox exercises the package, not the working tree.
 */
export function stagePackage(dir: string): StageResult {
  const meta = readBlockMetadata(dir);
  const slug = meta.name.slice(`${BLOCK_NAMESPACE}/`.length);
  const stageDir = path.join(dir, BUILD_DIRNAME, 'plugin');
  const blockDir = path.join(stageDir, slug);

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(blockDir, { recursive: true });

  const files = packageFileList(dir, meta);
  const missing: string[] = [];
  for (const rel of files) {
    const src = path.join(dir, rel);
    if (!fs.existsSync(src)) {
      missing.push(rel);
      continue;
    }
    const dest = path.join(blockDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  fs.writeFileSync(path.join(stageDir, `${SMOKE_PLUGIN_SLUG}.php`), loaderPlugin(slug, meta.name), 'utf8');
  return { stageDir, blockDir, slug, meta, files, missing };
}

/** The one-line loader plugin the smoke sandbox activates. */
export function loaderPlugin(slug: string, blockName: string): string {
  return `<?php
/**
 * Plugin Name: x-agent smoke loader (${blockName})
 * Description: Generated by wp_block_build_test. Registers the staged block from
 *              the directory mounted next to this file, so the throwaway sandbox
 *              exercises exactly the bytes that go into the install package.
 * Version: 0.0.0
 */

add_action( 'init', static function () { register_block_type( __DIR__ . '/${slug}' ); } );
`;
}

export interface PackageInspection {
  ok: boolean;
  reasons: string[];
  entries: PackageEntry[];
  zip_bytes: number;
  uncompressed_bytes: number;
  root: string | null;
  block_json: Record<string, unknown> | null;
}

/**
 * Read a zip back and check it against every structural rule the companion
 * enforces in `POST /blocks/install` (CONTRACT.md §5). Run on our own output so
 * a 422 `block_policy` can never be the first time we hear about a problem.
 */
export function inspectPackage(zipPath: string): PackageInspection {
  const Zip = loadAdmZip();
  const zip = new Zip(zipPath);
  const rawEntries = zip.getEntries();
  const reasons: string[] = [];
  const entries: PackageEntry[] = [];
  let uncompressed = 0;

  for (const e of rawEntries) {
    if (e.isDirectory) continue;
    entries.push({ name: e.entryName, bytes: e.header.size });
    uncompressed += e.header.size;
  }

  for (const e of entries) {
    const n = e.name;
    if (n.startsWith('/') || /^[A-Za-z]:[\\/]/.test(n) || n.startsWith('\\')) reasons.push(`absolute path in zip entry: ${n}`);
    if (n.split(/[\\/]/).includes('..')) reasons.push(`traversal segment in zip entry: ${n}`);
  }

  const zipBytes = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
  if (zipBytes > MAX_PACKAGE_BYTES) reasons.push(`package is ${zipBytes} bytes, over the 5 MB install limit`);
  if (uncompressed > MAX_PACKAGE_BYTES) reasons.push(`package expands to ${uncompressed} bytes, over the 5 MB install limit`);

  // "exactly one top-level dir, or flat files, with block.json at the block root"
  const tops = new Set(entries.map((e) => (e.name.includes('/') ? e.name.split('/')[0]! : '')));
  let root: string | null = null;
  if (tops.size === 1 && [...tops][0] !== '') {
    root = [...tops][0]!;
  } else if (tops.size === 1 && [...tops][0] === '') {
    root = '';
  } else {
    reasons.push(`zip has ${tops.size} top-level entries (${[...tops].map((t) => t || '(flat)').join(', ')}); exactly one top-level dir, or flat files, is allowed`);
  }

  const prefix = root ? `${root}/` : '';
  const blockJsonEntry = entries.find((e) => e.name === `${prefix}block.json`);
  let blockJson: Record<string, unknown> | null = null;
  if (!blockJsonEntry) {
    reasons.push('block.json is not at the block root of the zip');
  } else {
    const data = rawEntries.find((e) => e.entryName === blockJsonEntry.name)!.getData().toString('utf8');
    try {
      blockJson = JSON.parse(data) as Record<string, unknown>;
    } catch (e) {
      reasons.push(`block.json does not parse: ${(e as Error).message}`);
    }
  }

  if (blockJson) {
    const name = typeof blockJson.name === 'string' ? blockJson.name : '';
    if (!BLOCK_NAME_RE.test(name)) reasons.push(`block.json name "${name}" does not match ^agent/[a-z0-9-]+$`);
    const render = blockJson.render;
    if (typeof render !== 'string' || !render.startsWith('file:')) {
      reasons.push('block.json has no "render" entry pointing at a file (static blocks are never produced)');
    }
    const present = new Set(entries.map((e) => e.name));
    for (const key of FILE_REF_KEYS) {
      const v = blockJson[key];
      const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
      for (const item of list) {
        if (typeof item !== 'string' || !item.startsWith('file:')) continue;
        const rel = item.slice('file:'.length).replace(/^\.\//, '');
        if (!present.has(`${prefix}${rel}`)) reasons.push(`block.json references "${item}" but ${prefix}${rel} is not in the zip`);
      }
    }
  }

  return { ok: reasons.length === 0, reasons, entries, zip_bytes: zipBytes, uncompressed_bytes: uncompressed, root, block_json: blockJson };
}

/** Zip `<blockDir>` as a single top-level directory named after the block slug. */
export function packageBlock(blockDir: string, zipPath: string): string {
  const Zip = loadAdmZip();
  const zip = new Zip();
  const root = path.basename(blockDir);
  const walk = (abs: string, rel: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) zip.addFile(`${root}/${childRel}`, fs.readFileSync(childAbs));
    }
  };
  walk(blockDir, '');
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  zip.writeZip(zipPath);
  return zipPath;
}

/* ========================================================================== */
/* Build                                                                      */
/* ========================================================================== */

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

function run(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}), CI: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s: string, chunk: string) => (s.length > 200_000 ? s : s + chunk);
    child.stdout.on('data', (d: Buffer) => (stdout = cap(stdout, d.toString('utf8'))));
    child.stderr.on('data', (d: Buffer) => (stderr = cap(stderr, d.toString('utf8'))));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: stderr + String(e), timedOut, ms: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - started });
    });
  });
}

/**
 * `npm ci` when a lockfile is available, `npm install` otherwise, then
 * `wp-scripts build`.
 *
 * Cold `npm install` of `@wordpress/scripts` is ~1500 packages and about a
 * minute of wall clock. That is paid once: the resolved `node_modules` and its
 * lockfile are parked in a content-addressed cache keyed by the scaffold's
 * devDependencies, and later scaffolds with the same dependency set get a
 * symlink instead of a download. Set `X_AGENT_BLOCK_CACHE=0` to opt out.
 */
export async function buildBlock(
  dir: string,
  opts: { timeoutMs?: number; forceInstall?: boolean; logger?: Logger } = {},
): Promise<{ ok: boolean; log: string; installMs: number; buildMs: number; cached: boolean }> {
  const timeoutMs = opts.timeoutMs ?? envInt('X_AGENT_BLOCK_BUILD_TIMEOUT_MS', DEFAULT_BUILD_TIMEOUT_MS);
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw errInvalidInput(`${dir} has no package.json.`, 'Pass the directory returned by wp_block_scaffold.', { dir });
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { devDependencies?: Record<string, string> };
  const cacheDir = dependencyCacheDir(pkg.devDependencies ?? {});
  const nodeModules = path.join(dir, 'node_modules');
  const parts: string[] = [];
  let installMs = 0;
  let cached = false;
  const deadline = Date.now() + timeoutMs;

  if (opts.forceInstall) fs.rmSync(nodeModules, { recursive: true, force: true });

  if (!fs.existsSync(nodeModules)) {
    if (cacheDir && fs.existsSync(path.join(cacheDir, 'node_modules'))) {
      try {
        fs.symlinkSync(path.join(cacheDir, 'node_modules'), nodeModules, 'dir');
        const lock = path.join(cacheDir, 'package-lock.json');
        if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(dir, 'package-lock.json'));
        cached = true;
        parts.push(`$ (dependency cache hit) ${cacheDir}`);
      } catch (e) {
        parts.push(`# dependency cache unusable (${(e as Error).message}); installing fresh`);
      }
    }
    if (!cached) {
      const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'));
      const args = hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
      parts.push(`$ npm ${args.join(' ')}`);
      const res = await run('npm', args, { cwd: dir, timeoutMs: Math.max(1, deadline - Date.now()) });
      installMs = res.ms;
      parts.push(tail(res.stdout), tail(res.stderr));
      if (res.code !== 0) {
        return {
          ok: false,
          log: parts.filter(Boolean).join('\n'),
          installMs,
          buildMs: 0,
          cached,
        };
      }
      if (cacheDir) primeCache(cacheDir, dir, opts.logger);
    }
  } else {
    parts.push('$ (node_modules already present, skipping install)');
    cached = true;
  }

  parts.push('$ npm run build');
  const build = await run('npm', ['run', 'build'], { cwd: dir, timeoutMs: Math.max(1, deadline - Date.now()) });
  parts.push(tail(build.stdout), tail(build.stderr));
  return { ok: build.code === 0, log: parts.filter(Boolean).join('\n'), installMs, buildMs: build.ms, cached };
}

function tail(s: string, max = 8000): string {
  const t = s.trim();
  return t.length > max ? `…\n${t.slice(-max)}` : t;
}

function dependencyCacheDir(devDeps: Record<string, string>): string | null {
  if (process.env.X_AGENT_BLOCK_CACHE === '0') return null;
  const key = crypto.createHash('sha256').update(JSON.stringify(devDeps)).digest('hex').slice(0, 16);
  return path.join(defaultWorkspace(), '.deps', key);
}

function primeCache(cacheDir: string, dir: string, logger?: Logger): void {
  try {
    if (fs.existsSync(path.join(cacheDir, 'node_modules'))) return;
    fs.mkdirSync(cacheDir, { recursive: true });
    const from = path.join(dir, 'node_modules');
    const to = path.join(cacheDir, 'node_modules');
    fs.renameSync(from, to);
    fs.symlinkSync(to, from, 'dir');
    const lock = path.join(dir, 'package-lock.json');
    if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(cacheDir, 'package-lock.json'));
  } catch (e) {
    logger?.warn(`could not prime the block dependency cache: ${(e as Error).message}`);
  }
}

/* ========================================================================== */
/* Smoke test — real Playground boot, in a child process                      */
/* ========================================================================== */

/** Locate `@wp-playground/cli` without depending on this package's node_modules. */
export function resolvePlaygroundCli(): string {
  const override = process.env.X_AGENT_PLAYGROUND_CLI;
  if (override && fs.existsSync(override)) return override;
  try {
    return localRequire.resolve('@wp-playground/cli');
  } catch {
    /* fall through to the directory walk */
  }
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    for (const rel of ['node_modules/@wp-playground/cli/index.js', 'tools/node_modules/@wp-playground/cli/index.js']) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new XError(
    'smoke_failed',
    '@wp-playground/cli is not installed anywhere this package can reach, so the block cannot be smoke-tested.',
    'Install @wp-playground/cli (e.g. `cd tools && npm install`) or point X_AGENT_PLAYGROUND_CLI at its index.js. Nothing is packaged without a passing smoke test.',
  );
}

async function freePort(preferred?: number): Promise<number> {
  const check = (p: number) =>
    new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(p);
    });
  if (preferred) {
    if (await check(preferred)) return preferred;
    throw new XError('smoke_failed', `Port ${preferred} is busy.`, 'Pick another port, or leave `port` unset and let the factory choose.');
  }
  const [lo, hi] = portRange();
  for (let p = lo; p <= hi; p += 1) if (await check(p)) return p;
  throw new XError(
    'smoke_failed',
    `No free port in ${lo}-${hi} for the smoke sandbox.`,
    'Stop a stale Playground instance, or set X_AGENT_SMOKE_PORT_RANGE to a free range like "9460-9469".',
  );
}

export interface SmokeConfig {
  cliEntry: string;
  port: number;
  php: string;
  wp: string;
  pluginDir: string;
  pluginSlug: string;
  registerCode: string;
  renderCode: string;
}

/** One PHP probe as the runner reports it back. */
export interface ProbeOutcome {
  text: string;
  threw: boolean;
  error_text: string;
  exit_code: number | null;
}

export interface SmokeRunnerResult {
  booted: boolean;
  boot_ms: number;
  register?: ProbeOutcome;
  render?: ProbeOutcome;
  error: string;
}

export interface SmokeOutcome {
  booted: boolean;
  boot_ms: number;
  registered: boolean;
  block_type_count: number;
  agent_blocks: string[];
  rendered_html: string;
  render_source: string;
  php_error: string;
  php_notices: string[];
  error: string;
}

/**
 * The child-process runner, written to disk next to the staged package.
 *
 * Deliberately dumb: it boots Playground, runs two PHP snippets that this module
 * generated, and hands back raw text. All parsing happens back in the parent —
 * a runner with no regexes in it is a runner that cannot be wrong about a PHP
 * fatal. It is a separate process because this process's stdout is the MCP
 * transport and Playground is under no obligation to keep quiet on it, and
 * because a PHP-wasm fatal is a real crash that must not reach the server.
 */
const SMOKE_RUNNER_SOURCE = [
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
  '\t\treturn {',
  '\t\t\ttext,',
  '\t\t\tthrew: true,',
  "\t\t\terror_text: text || String( e?.message ?? e ),",
  '\t\t\texit_code: e?.response?.exitCode ?? null,',
  '\t\t};',
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
  "\t\tmount: [ { hostPath: cfg.pluginDir, vfsPath: '/wordpress/wp-content/plugins/' + cfg.pluginSlug } ],",
  '\t\tblueprint: {',
  '\t\t\tpreferredVersions: { php: cfg.php, wp: cfg.wp },',
  '\t\t\tsteps: [ {',
  "\t\t\t\tstep: 'activatePlugin',",
  "\t\t\t\tpluginPath: cfg.pluginSlug + '/' + cfg.pluginSlug + '.php',",
  '\t\t\t\tpluginName: cfg.pluginSlug,',
  '\t\t\t} ],',
  '\t\t},',
  '\t} );',
  '\tresult.booted = true;',
  '\tresult.boot_ms = Date.now() - t0;',
  '',
  '\tresult.register = await probe( server, cfg.registerCode );',
  '\tresult.render = await probe( server, cfg.renderCode );',
  '} catch ( e ) {',
  "\tresult.error = String( e?.stack ?? e?.message ?? e );",
  '} finally {',
  '\ttry { if ( server ) await server[ Symbol.asyncDispose ](); } catch {}',
  '\twrite();',
  '\tprocess.exit( 0 );',
  '}',
  '',
].join('\n');

const TAG = '<<<XSMOKE>>>';

/** PHP that asserts the block is in `/wp/v2/block-types`. */
export function registrationProbePhp(blockName: string): string {
  return `<?php
require_once '/wordpress/wp-load.php';
wp_set_current_user( 1 );

$req   = new WP_REST_Request( 'GET', '/wp/v2/block-types' );
$res   = rest_do_request( $req );
$names = array();
if ( ! is_wp_error( $res ) && 200 === $res->get_status() ) {
	foreach ( (array) $res->get_data() as $bt ) {
		$names[] = is_array( $bt ) ? $bt['name'] : $bt->name;
	}
}
$agent = array_values(
	array_filter(
		$names,
		static function ( $n ) {
			return 0 === strpos( (string) $n, 'agent/' );
		}
	)
);

echo "\\n${TAG}" . wp_json_encode(
	array(
		'registered' => in_array( ${phpJson(blockName)}, $names, true ),
		'count'      => count( $names ),
		'agent'      => $agent,
		'active'     => array_values( (array) get_option( 'active_plugins', array() ) ),
	)
) . "${TAG}";
`;
}

/**
 * PHP that renders the sample attributes through the sandbox's own REST block
 * renderer, cross-checks with `do_blocks()`, and reports any diagnostic raised
 * from inside the package directory.
 */
export function renderProbePhp(blockName: string, markup: string, attributes: Record<string, unknown>, vfsBlockDir: string): string {
  return `<?php
$x_pkg     = ${phpJson(vfsBlockDir)};
$x_notices = array();
set_error_handler(
	static function ( $no, $str, $file = '', $line = 0 ) use ( &$x_notices, $x_pkg ) {
		if ( '' !== $file && false !== strpos( (string) $file, $x_pkg ) ) {
			$x_notices[] = sprintf( '%s in %s on line %d', $str, $file, (int) $line );
		}
		return true;
	}
);

require_once '/wordpress/wp-load.php';
wp_set_current_user( 1 );

$name   = ${phpJson(blockName)};
$markup = ${phpJson(markup)};
$attrs  = json_decode( ${phpJson(JSON.stringify(attributes))}, true );

$rest_html  = null;
$rest_error = null;
$req = new WP_REST_Request( 'POST', '/wp/v2/block-renderer/' . $name );
$req->set_param( 'context', 'edit' );
$req->set_param( 'attributes', is_array( $attrs ) ? $attrs : array() );
$res = rest_do_request( $req );
if ( is_wp_error( $res ) ) {
	$rest_error = $res->get_error_message();
} elseif ( 200 === $res->get_status() ) {
	$data      = $res->get_data();
	$rest_html = ( is_array( $data ) && isset( $data['rendered'] ) ) ? $data['rendered'] : null;
} else {
	$d          = $res->get_data();
	$rest_error = ( is_array( $d ) && isset( $d['message'] ) ) ? $d['message'] : 'HTTP ' . $res->get_status();
}

$do_blocks_html = do_blocks( $markup );

echo "\\n${TAG}" . wp_json_encode(
	array(
		'rest_html'      => $rest_html,
		'rest_error'     => $rest_error,
		'do_blocks_html' => $do_blocks_html,
		'notices'        => $x_notices,
	)
) . "${TAG}";
`;
}

/** A PHP literal for a string, via JSON — safe for anything we generate. */
function phpJson(value: string): string {
  return JSON.stringify(value).replace(/\$/g, '\\$');
}

/** Pull the payload back out of a tagged PHP echo. */
export function readTagged(text: string): Record<string, unknown> | null {
  const parts = String(text ?? '').split(TAG);
  if (parts.length < 3) return null;
  try {
    return JSON.parse(parts[1] ?? '') as Record<string, unknown>;
  } catch {
    return null;
  }
}

const PHP_ERROR_LEVELS = 'Parse error|Fatal error|Warning|Notice|Deprecated|Recoverable fatal error|Uncaught \\w*Error';

/**
 * Extract the human-readable PHP diagnostic from sandbox output. WordPress wraps
 * it in `<b>…</b>` on its error page and PHP emits it plain on the CLI, so try
 * both shapes.
 */
export function extractPhpError(text: string): string {
  const s = String(text ?? '');
  const html = new RegExp(`<b>(${PHP_ERROR_LEVELS})</b>:([\\s\\S]{0,800}?)<br\\s*/?>`).exec(s);
  if (html) return decodeHtml(`${html[1]}:${html[2]}`);
  const plain = new RegExp(`(${PHP_ERROR_LEVELS})[^\\n]{0,800}`).exec(s);
  return plain ? decodeHtml(plain[0]) : '';
}

function decodeHtml(s: string): string {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Turn the runner's raw probe text into the smoke facts we report. */
export function interpretSmoke(raw: SmokeRunnerResult): SmokeOutcome {
  const out: SmokeOutcome = {
    booted: !!raw.booted,
    boot_ms: raw.boot_ms ?? 0,
    registered: false,
    block_type_count: 0,
    agent_blocks: [],
    rendered_html: '',
    render_source: '',
    php_error: '',
    php_notices: [],
    error: raw.error ?? '',
  };

  if (raw.register) {
    const info = readTagged(raw.register.text);
    if (info) {
      out.registered = info.registered === true;
      out.block_type_count = typeof info.count === 'number' ? info.count : 0;
      out.agent_blocks = Array.isArray(info.agent) ? (info.agent as string[]) : [];
    } else if (!out.error) {
      out.error = 'Could not read the registration probe result from the sandbox.';
    }
    const err = extractPhpError(raw.register.threw ? raw.register.error_text : raw.register.text);
    if (err) out.php_error = err;
  }

  if (raw.render) {
    const info = readTagged(raw.render.text);
    if (info) {
      const rest = typeof info.rest_html === 'string' ? info.rest_html : '';
      const doBlocks = typeof info.do_blocks_html === 'string' ? info.do_blocks_html : '';
      if (rest.trim()) {
        out.rendered_html = rest;
        out.render_source = 'rest:/wp/v2/block-renderer';
      } else if (doBlocks.trim()) {
        out.rendered_html = doBlocks;
        out.render_source = 'do_blocks';
      } else if (!out.error && typeof info.rest_error === 'string' && info.rest_error) {
        out.error = `The block renderer returned no HTML: ${info.rest_error}`;
      }
      if (Array.isArray(info.notices)) out.php_notices = info.notices as string[];
    } else if (!out.error) {
      out.error = 'Could not read the render probe result from the sandbox.';
    }
    const err = extractPhpError(raw.render.threw ? raw.render.error_text : raw.render.text);
    if (err && !out.php_error) out.php_error = err;
  }

  if (!out.php_error && out.php_notices.length) out.php_error = out.php_notices.join(' | ');
  return out;
}

export async function smokeTest(
  stage: StageResult,
  sampleAttributes: Record<string, unknown>,
  opts: { timeoutMs?: number; port?: number; logger?: Logger } = {},
): Promise<{ result: SmokeOutcome; log: string; ms: number; port: number; markup: string; attributes: Record<string, unknown> }> {
  const timeoutMs = opts.timeoutMs ?? envInt('X_AGENT_BLOCK_SMOKE_TIMEOUT_MS', DEFAULT_SMOKE_TIMEOUT_MS);
  const cliEntry = resolvePlaygroundCli();
  const port = await freePort(opts.port ?? (process.env.X_AGENT_SMOKE_PORT ? Number(process.env.X_AGENT_SMOKE_PORT) : undefined));

  const attributes = mergedSampleAttributes(stage.meta, sampleAttributes);
  const markup = blockMarkup(stage.meta.name, attributes);
  const vfsBlockDir = `/wordpress/wp-content/plugins/${SMOKE_PLUGIN_SLUG}/${stage.slug}`;

  const runDir = path.join(path.dirname(stage.stageDir), 'smoke');
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const runnerPath = path.join(runDir, 'smoke-runner.mjs');
  const configPath = path.join(runDir, 'smoke-config.json');
  const resultPath = path.join(runDir, 'smoke-result.json');
  fs.writeFileSync(runnerPath, SMOKE_RUNNER_SOURCE, 'utf8');

  const config: SmokeConfig = {
    cliEntry,
    port,
    php: process.env.X_AGENT_SMOKE_PHP || '8.3',
    wp: process.env.X_AGENT_SMOKE_WP || 'latest',
    pluginDir: stage.stageDir,
    pluginSlug: SMOKE_PLUGIN_SLUG,
    registerCode: registrationProbePhp(stage.meta.name),
    renderCode: renderProbePhp(stage.meta.name, markup, attributes, vfsBlockDir),
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  opts.logger?.info(`smoke-testing ${stage.meta.name} in a throwaway WordPress on port ${port}`);
  const started = Date.now();
  const res = await run(process.execPath, [runnerPath, configPath, resultPath], { cwd: runDir, timeoutMs });
  const ms = Date.now() - started;

  let raw: SmokeRunnerResult | undefined;
  if (fs.existsSync(resultPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as SmokeRunnerResult;
    } catch {
      /* fall through to the synthetic failure below */
    }
  }
  const log = [tail(res.stdout), tail(res.stderr)].filter(Boolean).join('\n');
  if (!raw) {
    raw = {
      booted: false,
      boot_ms: 0,
      error: res.timedOut
        ? `The smoke sandbox did not finish within ${timeoutMs}ms.`
        : `The smoke sandbox exited with code ${res.code} without writing a result. ${tail(res.stderr, 2000)}`.trim(),
    };
  }
  return { result: interpretSmoke(raw), log, ms, port, markup, attributes };
}

/** Sample attributes, with block.json defaults filling every gap. */
export function mergedSampleAttributes(meta: BlockMetadata, sample: Record<string, unknown>): Record<string, unknown> {
  const declared = (meta.raw.attributes ?? {}) as Record<string, { default?: unknown }>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(declared)) if (v && v.default !== undefined) out[k] = v.default;
  for (const [k, v] of Object.entries(sample ?? {})) out[k] = v;
  return out;
}

/** `<!-- wp:agent/slug {"a":1} /-->` — the canonical self-closing form. */
export function blockMarkup(name: string, attributes: Record<string, unknown>): string {
  const attrs = Object.keys(attributes).length ? ` ${JSON.stringify(attributes)}` : '';
  return `<!-- wp:${name}${attrs} /-->`;
}

/* ========================================================================== */
/* The factory                                                                */
/* ========================================================================== */

export class BlockFactory {
  constructor(private readonly logger?: Logger) {}

  scaffold(input: ScaffoldInput): ScaffoldResult {
    const out = scaffold(input);
    this.logger?.info(`scaffolded ${out.name} at ${out.dir}`);
    return out;
  }

  /**
   * build -> stage -> smoke -> package. The zip is produced on the success path
   * only; every failure returns structured detail and no `zip_path`, so there is
   * nothing for `wp_block_install` to send.
   */
  async buildAndTest(input: BuildTestInput): Promise<BuildTestResult> {
    const dir = path.resolve(input.dir ?? '');
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw errInvalidInput(`${input.dir} is not a directory.`, 'Pass the `dir` returned by wp_block_scaffold.', { dir: input.dir });
    }
    const timings: Record<string, number> = {};
    const deviations: string[] = [];

    // 1. Build. -----------------------------------------------------------
    const buildOpts: { timeoutMs?: number; forceInstall?: boolean; logger?: Logger } = {};
    if (input.timeout_ms) buildOpts.timeoutMs = input.timeout_ms;
    if (input.force_install) buildOpts.forceInstall = true;
    if (this.logger) buildOpts.logger = this.logger;
    const build = await buildBlock(dir, buildOpts);
    timings.install = build.installMs;
    timings.build = build.buildMs;
    // A cache hit is not a deviation — it is the same wp-scripts build with the
    // same node_modules, just not re-downloaded. It is recorded in build_log.
    timings.install_cached = build.cached ? 1 : 0;
    if (!build.ok) {
      return {
        built: false,
        smoke: { registered: false, rendered_html: '' },
        build_log: build.log,
        failure: {
          code: 'build_failed',
          message: 'npm install / wp-scripts build failed; see build_log.',
          hint: 'Fix the JavaScript build errors in src/ and call wp_block_build_test again. Nothing is packaged and nothing is sent to an instance until the build passes.',
        },
        timings_ms: timings,
        deviations,
      };
    }

    // 2. Stage the exact bytes that will ship. -----------------------------
    const stage = stagePackage(dir);
    if (stage.missing.length) {
      return {
        built: true,
        smoke: { registered: false, rendered_html: '' },
        build_log: build.log,
        failure: {
          code: 'build_failed',
          message: `block.json references file(s) the build did not produce: ${stage.missing.join(', ')}.`,
          hint: 'Run the build again, or correct the file: paths in block.json. The companion rejects a package whose block.json references a missing file.',
        },
        timings_ms: timings,
        deviations,
      };
    }

    // 3. Smoke test in a real, throwaway WordPress. ------------------------
    const smokeOpts: { timeoutMs?: number; port?: number; logger?: Logger } = {};
    if (input.smoke_timeout_ms) smokeOpts.timeoutMs = input.smoke_timeout_ms;
    if (input.port) smokeOpts.port = input.port;
    if (this.logger) smokeOpts.logger = this.logger;
    const smoke = await smokeTest(stage, input.sample_attributes ?? {}, smokeOpts);
    timings.smoke = smoke.ms;
    timings.smoke_boot = smoke.result.boot_ms;

    const smokeOut: SmokeResult = { registered: smoke.result.registered, rendered_html: smoke.result.rendered_html };
    if (smoke.result.php_error) smokeOut.php_error = smoke.result.php_error;

    const log = [build.log, smoke.log].filter(Boolean).join('\n');

    if (smoke.result.php_error || !smoke.result.registered || !smoke.result.rendered_html) {
      return {
        built: true,
        smoke: smokeOut,
        build_log: log,
        failure: {
          code: 'smoke_failed',
          message: smoke.result.php_error
            ? `The block produced a PHP error in the sandbox: ${smoke.result.php_error}`
            : !smoke.result.booted
              ? `The smoke sandbox did not boot: ${smoke.result.error}`
              : !smoke.result.registered
                ? `${stage.meta.name} did not appear in /wp/v2/block-types after registration. ${smoke.result.error}`.trim()
                : `${stage.meta.name} registered but rendered nothing. ${smoke.result.error}`.trim(),
          hint: 'Fix render.php (or block.json) and run wp_block_build_test again. No package was produced, so nothing can be installed onto an instance in this state.',
        },
        timings_ms: timings,
        deviations,
      };
    }

    // 4. Package — success path only. --------------------------------------
    const zipPath = path.join(dir, BUILD_DIRNAME, `${stage.slug}-${stage.meta.version}.zip`);
    packageBlock(stage.blockDir, zipPath);
    const inspection = inspectPackage(zipPath);
    if (!inspection.ok) {
      fs.rmSync(zipPath, { force: true });
      return {
        built: true,
        smoke: smokeOut,
        build_log: log,
        failure: {
          code: 'build_failed',
          message: `The package would violate the companion install policy: ${inspection.reasons.join('; ')}.`,
          hint: 'CONTRACT.md §5 pins the install policy. The zip was deleted rather than handed to you.',
        },
        timings_ms: timings,
        deviations,
      };
    }

    return {
      built: true,
      smoke: smokeOut,
      zip_path: zipPath,
      build_log: log,
      package: { entries: inspection.entries, zip_bytes: inspection.zip_bytes, uncompressed_bytes: inspection.uncompressed_bytes },
      timings_ms: timings,
      deviations,
    };
  }
}

/* ========================================================================== */
/* Seam registration (context.ts note 2b)                                     */
/* ========================================================================== */

registerFactoryProvider({
  create: (ctx: Ctx) => new BlockFactory(ctx.logger),
});

/** `getFactory(ctx)` returns `unknown`; this narrows it at the call site. */
export function asFactory(v: unknown): BlockFactory {
  if (v instanceof BlockFactory) return v;
  throw new XError('internal', 'The block factory provider produced an unexpected instance.', 'This is an agent-side bug.');
}
