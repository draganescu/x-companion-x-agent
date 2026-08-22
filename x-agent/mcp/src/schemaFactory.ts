/**
 * ============================================================================
 * THE SCHEMA FACTORY — model a domain, gate it, package it.
 * ============================================================================
 *
 * The backend counterpart of factory.ts. A *schema package* is how storage,
 * taxonomies, meta, block bindings, REST routes and an admin surface enter a
 * WordPress instance: real plugin code registering everything on `init`
 * through core APIs, generated here, smoke-tested in a throwaway Playground,
 * and installed only through `POST /schema/install`.
 *
 * THE GATE (mirrors the block factory's, and is just as non-negotiable):
 *
 *   scaffold -> static policy scan (no $wpdb, no eval/exec) -> boot a
 *   throwaway WordPress -> assert every declared post type in /wp/v2/types,
 *   every declared meta key in the type's REST schema, every taxonomy in
 *   /wp/v2/taxonomies, every route answering as declared (2xx for a valid
 *   nonce'd call, 401/403 for an unauthenticated protected one), every
 *   binding source registered -> deactivate and assert nothing is left
 *   registered -> only then zip.
 *
 * POLICY (enforced twice: statically here, structurally on install):
 *   - registration exclusively via core APIs;
 *   - every meta key carries show_in_rest with a schema — REST-invisible
 *     meta is invisible to bindings and to the agent, so it is an error;
 *   - every route declares its auth mode; 'public-nonce' handlers verify a
 *     REST nonce + honeypot, 'capability' routes name the capability;
 *   - admin UX is the CPT's standard UI (show_ui + list-table columns).
 *
 * Reuses factory.ts's child-process Playground runner (probes mode): stdout
 * of this process is the MCP transport, so the sandbox runs out of process.
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  SMOKE_RUNNER_SOURCE,
  TAG,
  freePort,
  loadAdmZip,
  phpJson,
  resolvePlaygroundCli,
  run,
  type ProbeOutcome,
  type SmokeConfig,
  type SmokeRunnerResult,
} from './factory.js';
import { XError, errInvalidInput } from './errors.js';
import type { Logger } from './companion.js';

/* ========================================================================== */
/* Types                                                                      */
/* ========================================================================== */

export interface SchemaMetaInput {
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  /** show_in_rest schema; defaults to {type}. */
  schema?: Record<string, unknown>;
  single?: boolean;
  default?: unknown;
}

export interface SchemaPostTypeInput {
  slug: string;
  label: string;
  /** Defaults to title + custom-fields. */
  supports?: string[];
  meta?: SchemaMetaInput[];
  taxonomies?: string[];
  /** Public on the front end? Defaults false: agent CPTs are data first. */
  public?: boolean;
  /** Extra registered statuses, e.g. ready / picked-up. */
  statuses?: { slug: string; label: string }[];
}

export interface SchemaTaxonomyInput {
  slug: string;
  label: string;
  object_types: string[];
  hierarchical?: boolean;
}

export interface SchemaRouteInput {
  /** Path under the package namespace, e.g. '/submit'. */
  path: string;
  methods?: ('GET' | 'POST' | 'PUT' | 'DELETE')[];
  auth: 'public-nonce' | 'capability';
  capability?: string;
  /** Post type a scaffolded submit handler writes to; defaults to the first CPT. */
  writes?: string;
}

export interface SchemaBindingInput {
  /** Source name suffix; registered as agent-{slug}/{name}. */
  name: string;
  meta_key: string;
  label?: string;
}

export interface SchemaScaffoldInput {
  slug: string;
  intent: string;
  post_types: SchemaPostTypeInput[];
  taxonomies?: SchemaTaxonomyInput[];
  routes?: SchemaRouteInput[];
  bindings?: SchemaBindingInput[];
  dir?: string;
  version?: string;
  force?: boolean;
}

export interface SchemaScaffoldResult {
  dir: string;
  slug: string;
  files: string[];
}

export interface SchemaProvides {
  post_types: string[];
  taxonomies: string[];
  meta_keys: { post_type: string; key: string }[];
  binding_sources: string[];
  routes: { path: string; methods: string[]; auth: string }[];
}

export interface SchemaPackageMeta {
  slug: string;
  version: string;
  intent: string;
  provides: SchemaProvides;
}

export interface SchemaRouteCheck {
  path: string;
  method: string;
  status: number;
  unauth_status?: number;
  ok: boolean;
}

export interface SchemaSmoke {
  booted: boolean;
  types_registered: Record<string, boolean>;
  meta_in_rest: Record<string, boolean>;
  taxonomies_registered: Record<string, boolean>;
  routes: SchemaRouteCheck[];
  bindings_registered: Record<string, boolean>;
  uninstall_clean: boolean;
  php_error?: string;
}

export interface SchemaBuildTestResult {
  built: boolean;
  smoke: SchemaSmoke;
  zip_path?: string;
  build_log?: string;
  failure?: { code: 'schema_policy' | 'smoke_failed'; message: string; hint: string };
}

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

export const SCHEMA_SLUG_RE = /^[a-z0-9-]+$/;
/** Install policy: total package size ≤ 1 MB. */
export const MAX_SCHEMA_PACKAGE_BYTES = 1024 * 1024;
export const SCHEMA_PLUGIN_PREFIX = 'agent-schema-';
export const SCHEMA_META_FILE = 'schema.json';

/** Where schema scaffolds land when the caller does not name a directory. */
export function schemaWorkspace(): string {
  return process.env.X_AGENT_SCHEMA_WORKSPACE || path.join(process.env.TMPDIR || '/tmp', 'x-agent-schemas');
}

/* ========================================================================== */
/* Static policy scan                                                        */
/* ========================================================================== */

const FORBIDDEN_TOKENS: { re: RegExp; what: string }[] = [
  { re: /\$wpdb\b/, what: 'direct $wpdb use' },
  { re: /\bmysqli?_/, what: 'direct SQL driver use' },
  { re: /\beval\s*\(/, what: 'eval()' },
  { re: /\b(?:exec|shell_exec|passthru|proc_open|popen|system)\s*\(/, what: 'process execution' },
  { re: /\bfile_put_contents\s*\(\s*['"]\/(?!tmp)/, what: 'absolute-path filesystem write' },
];

export interface PolicyViolation {
  file: string;
  what: string;
  line: number;
}

/** Scan every .php file in the package for policy violations. */
export function policyScan(dir: string): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.php')) continue;
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const { re, what } of FORBIDDEN_TOKENS) {
        if (re.test(line)) violations.push({ file, what, line: i + 1 });
      }
    });
  }
  return violations;
}

/* ========================================================================== */
/* Code generation                                                            */
/* ========================================================================== */

function assertSchemaSlug(slug: unknown, what: string): string {
  if (typeof slug !== 'string' || !SCHEMA_SLUG_RE.test(slug)) {
    throw errInvalidInput(`${what} ${JSON.stringify(slug)} must match ${SCHEMA_SLUG_RE}.`, 'lowercase letters, digits and hyphens only');
  }
  return slug;
}

const RESERVED_POST_TYPES = new Set([
  'post', 'page', 'attachment', 'revision', 'nav_menu_item', 'custom_css', 'customize_changeset',
  'oembed_cache', 'user_request', 'wp_block', 'wp_template', 'wp_template_part', 'wp_global_styles',
  'wp_navigation', 'wp_font_family', 'wp_font_face', 'action', 'author', 'order', 'theme',
]);

function phpArray(value: unknown, indent = ''): string {
  if (Array.isArray(value)) {
    const items = value.map((v) => phpArray(v, indent + '\t')).join(', ');
    return `array( ${items} )`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k).replace(/\$/g, '\\$')} => ${phpArray(v, indent + '\t')}`)
      .join(', ');
    return `array( ${entries} )`;
  }
  if (typeof value === 'string') return JSON.stringify(value).replace(/\$/g, '\\$');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'null';
  return String(value);
}

function funcPrefix(slug: string): string {
  return 'agent_schema_' + slug.replace(/-/g, '_');
}

/** {slug}.php — registrations on init, admin columns, bindings, loader. */
function mainPluginPhp(input: SchemaScaffoldInput, version: string): string {
  const p = funcPrefix(input.slug);
  const ns = `agent-${input.slug}/v1`;
  const lines: string[] = [];

  lines.push('<?php');
  lines.push('/**');
  lines.push(` * Plugin Name:       Agent schema: ${input.slug}`);
  lines.push(` * Description:       Agent-fabricated schema package (${SCHEMA_PLUGIN_PREFIX}${input.slug}). Registers the domain model through core APIs on init; nothing here touches the database directly.`);
  lines.push(` * Version:           ${version}`);
  lines.push(' * Requires at least: 6.5');
  lines.push(' * Requires PHP:      8.1');
  lines.push(' * License:           GPL-2.0-or-later');
  lines.push(' *');
  lines.push(' * =========================================================================');
  lines.push(' * INTENT — the domain this package models. Implement against this.');
  lines.push(' * =========================================================================');
  for (const intentLine of input.intent.split('\n')) lines.push(` * ${intentLine}`);
  lines.push(' * =========================================================================');
  lines.push(' */');
  lines.push('');
  lines.push("defined( 'ABSPATH' ) || exit;");
  lines.push('');
  lines.push(`define( '${p.toUpperCase()}_VERSION', '${version}' );`);
  lines.push(`define( '${p.toUpperCase()}_REST_NS', '${ns}' );`);
  lines.push('');
  lines.push('/** Every registration happens here, on every request. */');
  lines.push(`function ${p}_register(): void {`);

  for (const tax of input.taxonomies ?? []) {
    lines.push(`\tregister_taxonomy( '${assertSchemaSlug(tax.slug, 'taxonomy slug').replace(/-/g, '_')}', ${phpArray(tax.object_types.map((t) => t.replace(/-/g, '_')))}, array(`);
    lines.push(`\t\t'label'        => ${phpJson(tax.label)},`);
    lines.push(`\t\t'public'       => false,`);
    lines.push(`\t\t'show_ui'      => true,`);
    lines.push(`\t\t'show_in_rest' => true,`);
    lines.push(`\t\t'hierarchical' => ${tax.hierarchical ? 'true' : 'false'},`);
    lines.push('\t) );');
    lines.push('');
  }

  for (const cpt of input.post_types) {
    const slug = cpt.slug.replace(/-/g, '_');
    const supports = cpt.supports && cpt.supports.length ? cpt.supports : ['title', 'custom-fields'];
    lines.push(`\tregister_post_type( '${slug}', array(`);
    lines.push(`\t\t'label'         => ${phpJson(cpt.label)},`);
    lines.push(`\t\t'public'        => ${cpt.public ? 'true' : 'false'},`);
    lines.push(`\t\t'show_ui'       => true,`);
    lines.push(`\t\t'show_in_menu'  => true,`);
    lines.push(`\t\t'show_in_rest'  => true,`);
    lines.push(`\t\t'menu_icon'     => 'dashicons-database',`);
    lines.push(`\t\t'supports'      => ${phpArray(supports)},`);
    if (cpt.taxonomies && cpt.taxonomies.length) {
      lines.push(`\t\t'taxonomies'    => ${phpArray(cpt.taxonomies.map((t) => t.replace(/-/g, '_')))},`);
    }
    lines.push('\t) );');
    lines.push('');

    for (const status of cpt.statuses ?? []) {
      lines.push(`\tregister_post_status( '${assertSchemaSlug(status.slug, 'status slug').replace(/-/g, '_')}', array(`);
      lines.push(`\t\t'label'                     => ${phpJson(status.label)},`);
      lines.push("\t\t'public'                    => false,");
      lines.push("\t\t'internal'                  => false,");
      lines.push("\t\t'show_in_admin_all_list'    => true,");
      lines.push("\t\t'show_in_admin_status_list' => true,");
      lines.push('\t) );');
      lines.push('');
    }

    for (const meta of cpt.meta ?? []) {
      const schema = meta.schema ?? { type: meta.type };
      lines.push(`\tregister_post_meta( '${slug}', ${phpJson(meta.key)}, array(`);
      lines.push(`\t\t'type'         => ${phpJson(meta.type)},`);
      lines.push(`\t\t'single'       => ${meta.single === false ? 'false' : 'true'},`);
      if (meta.default !== undefined) lines.push(`\t\t'default'      => ${phpArray(meta.default)},`);
      lines.push("\t\t// POLICY: REST-invisible meta is invisible to bindings and to the agent.");
      lines.push(`\t\t'show_in_rest' => array( 'schema' => ${phpArray(schema)} ),`);
      lines.push("\t\t'sanitize_callback' => static function ( $value ) { return is_string( $value ) ? sanitize_text_field( $value ) : $value; },");
      lines.push('\t) );');
      lines.push('');
    }
  }

  for (const binding of input.bindings ?? []) {
    lines.push(`\tif ( function_exists( 'register_block_bindings_source' ) ) {`);
    lines.push(`\t\tregister_block_bindings_source( 'agent-${input.slug}/${assertSchemaSlug(binding.name, 'binding name')}', array(`);
    lines.push(`\t\t\t'label'              => ${phpJson(binding.label ?? binding.name)},`);
    lines.push(`\t\t\t'uses_context'       => array( 'postId' ),`);
    lines.push("\t\t\t'get_value_callback' => static function ( array $args, $block ) {");
    lines.push("\t\t\t\t$post_id = isset( $block->context['postId'] ) ? (int) $block->context['postId'] : get_the_ID();");
    lines.push(`\t\t\t\treturn $post_id ? get_post_meta( $post_id, ${phpJson(binding.meta_key)}, true ) : null;`);
    lines.push('\t\t\t},');
    lines.push('\t\t) );');
    lines.push('\t}');
    lines.push('');
  }

  lines.push('}');
  lines.push(`add_action( 'init', '${p}_register' );`);
  lines.push('');

  // Standard admin list-table columns for the registered meta.
  for (const cpt of input.post_types) {
    const slug = cpt.slug.replace(/-/g, '_');
    const metaKeys = (cpt.meta ?? []).map((m) => m.key);
    if (!metaKeys.length) continue;
    lines.push(`add_filter( 'manage_${slug}_posts_columns', static function ( array $columns ): array {`);
    for (const key of metaKeys) {
      lines.push(`\t$columns[${phpJson(key)}] = ${phpJson(key.replace(/[_-]/g, ' '))};`);
    }
    lines.push('\treturn $columns;');
    lines.push('} );');
    lines.push(`add_action( 'manage_${slug}_posts_custom_column', static function ( string $column, int $post_id ): void {`);
    lines.push(`\tif ( in_array( $column, ${phpArray(metaKeys)}, true ) ) {`);
    lines.push("\t\techo esc_html( (string) get_post_meta( $post_id, $column, true ) );");
    lines.push('\t}');
    lines.push('}, 10, 2 );');
    lines.push('');
  }

  lines.push("require_once __DIR__ . '/routes.php';");
  lines.push('');
  return lines.join('\n');
}

/** routes.php — register_rest_route with explicit auth per route. */
function routesPhp(input: SchemaScaffoldInput): string {
  const p = funcPrefix(input.slug);
  const lines: string[] = [];
  const firstCpt = input.post_types[0]?.slug.replace(/-/g, '_') ?? 'post';

  lines.push('<?php');
  lines.push('/**');
  lines.push(` * REST routes for ${SCHEMA_PLUGIN_PREFIX}${input.slug}. Namespace ${p.toUpperCase()}_REST_NS.`);
  lines.push(' *');
  lines.push(' * POLICY: every route declares its auth. public-nonce routes verify a REST');
  lines.push(' * nonce and an empty honeypot before touching anything; capability routes');
  lines.push(' * name the capability in permission_callback. Handlers sanitize every input');
  lines.push(' * and write exclusively through core APIs.');
  lines.push(' */');
  lines.push('');
  lines.push("defined( 'ABSPATH' ) || exit;");
  lines.push('');
  lines.push(`add_action( 'rest_api_init', static function (): void {`);

  for (const route of input.routes ?? []) {
    const methods = route.methods && route.methods.length ? route.methods : ['POST'];
    const routePath = route.path.startsWith('/') ? route.path : '/' + route.path;
    const writes = (route.writes ?? firstCpt).replace(/-/g, '_');
    const writesMeta = input.post_types.find((c) => c.slug.replace(/-/g, '_') === writes)?.meta ?? [];

    lines.push(`\tregister_rest_route( ${p.toUpperCase()}_REST_NS, ${phpJson(routePath)}, array(`);
    lines.push(`\t\t'methods'             => ${phpJson(methods.join(','))},`);
    if (route.auth === 'capability') {
      const cap = route.capability ?? 'edit_posts';
      lines.push(`\t\t'permission_callback' => static function () { return current_user_can( ${phpJson(cap)} ); },`);
    } else {
      lines.push("\t\t// public-nonce: open at the permission layer, verified in the handler.");
      lines.push("\t\t'permission_callback' => '__return_true',");
    }
    lines.push("\t\t'callback'            => static function ( WP_REST_Request $request ) {");

    if (route.auth === 'public-nonce') {
      lines.push("\t\t\t$nonce = (string) ( $request->get_param( '_wpnonce' ) ?? $request->get_header( 'X-WP-Nonce' ) );");
      lines.push("\t\t\tif ( ! wp_verify_nonce( $nonce, 'wp_rest' ) ) {");
      lines.push("\t\t\t\treturn new WP_Error( 'rest_cookie_invalid_nonce', 'Nonce check failed.', array( 'status' => 403 ) );");
      lines.push('\t\t\t}');
      lines.push("\t\t\tif ( '' !== trim( (string) $request->get_param( 'hp_website' ) ) ) {");
      lines.push("\t\t\t\treturn new WP_Error( 'rest_invalid_param', 'Submission could not be verified.', array( 'status' => 400 ) );");
      lines.push('\t\t\t}');
    }

    lines.push(`\t\t\t// Default handler: create a ${writes} entry from the declared meta.`);
    lines.push('\t\t\t// Implement the real behavior against the package intent.');
    lines.push(`\t\t\t$post_id = wp_insert_post( array(`);
    lines.push(`\t\t\t\t'post_type'   => '${writes}',`);
    lines.push("\t\t\t\t'post_status' => 'pending',");
    lines.push("\t\t\t\t'post_title'  => sanitize_text_field( (string) ( $request->get_param( 'title' ) ?? 'Submission' ) ),");
    lines.push('\t\t\t), true );');
    lines.push('\t\t\tif ( is_wp_error( $post_id ) ) {');
    lines.push("\t\t\t\treturn new WP_Error( 'rest_cannot_create', $post_id->get_error_message(), array( 'status' => 500 ) );");
    lines.push('\t\t\t}');
    for (const meta of writesMeta) {
      lines.push(`\t\t\tif ( null !== $request->get_param( ${phpJson(meta.key)} ) ) {`);
      lines.push(`\t\t\t\tupdate_post_meta( $post_id, ${phpJson(meta.key)}, sanitize_text_field( (string) $request->get_param( ${phpJson(meta.key)} ) ) );`);
      lines.push('\t\t\t}');
    }
    lines.push("\t\t\treturn rest_ensure_response( array( 'created' => $post_id ) );");
    lines.push('\t\t},');
    lines.push('\t) );');
    lines.push('');
  }

  lines.push('} );');
  lines.push('');
  return lines.join('\n');
}

/** uninstall.php — content removal is opt-in; registrations vanish with the code. */
function uninstallPhp(input: SchemaScaffoldInput): string {
  const lines: string[] = [];
  lines.push('<?php');
  lines.push('/**');
  lines.push(` * Uninstall for ${SCHEMA_PLUGIN_PREFIX}${input.slug}.`);
  lines.push(' *');
  lines.push(' * Registrations are hook-based and vanish with the plugin. Content removal');
  lines.push(' * is destructive and therefore opt-in: define');
  lines.push(' * X_AGENT_SCHEMA_UNINSTALL_CONTENT true to also delete the stored entries.');
  lines.push(' */');
  lines.push("defined( 'WP_UNINSTALL_PLUGIN' ) || exit;");
  lines.push('');
  lines.push("if ( defined( 'X_AGENT_SCHEMA_UNINSTALL_CONTENT' ) && X_AGENT_SCHEMA_UNINSTALL_CONTENT ) {");
  for (const cpt of input.post_types) {
    const slug = cpt.slug.replace(/-/g, '_');
    lines.push(`\tforeach ( get_posts( array( 'post_type' => '${slug}', 'post_status' => 'any', 'numberposts' => -1, 'fields' => 'ids' ) ) as $x_id ) {`);
    lines.push('\t\twp_delete_post( (int) $x_id, true );');
    lines.push('\t}');
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/** The machine-readable package manifest. */
export function packageMeta(input: SchemaScaffoldInput, version: string): SchemaPackageMeta {
  const metaKeys: { post_type: string; key: string }[] = [];
  for (const cpt of input.post_types) {
    for (const meta of cpt.meta ?? []) metaKeys.push({ post_type: cpt.slug.replace(/-/g, '_'), key: meta.key });
  }
  return {
    slug: input.slug,
    version,
    intent: input.intent,
    provides: {
      post_types: input.post_types.map((c) => c.slug.replace(/-/g, '_')),
      taxonomies: (input.taxonomies ?? []).map((t) => t.slug.replace(/-/g, '_')),
      meta_keys: metaKeys,
      binding_sources: (input.bindings ?? []).map((b) => `agent-${input.slug}/${b.name}`),
      routes: (input.routes ?? []).map((r) => ({
        path: r.path.startsWith('/') ? r.path : '/' + r.path,
        methods: r.methods && r.methods.length ? r.methods : ['POST'],
        auth: r.auth,
      })),
    },
  };
}

/* ========================================================================== */
/* Scaffold                                                                   */
/* ========================================================================== */

export function schemaScaffold(input: SchemaScaffoldInput): SchemaScaffoldResult {
  assertSchemaSlug(input.slug, 'package slug');
  if (!input.intent || typeof input.intent !== 'string') {
    throw errInvalidInput('intent is required.', 'One or two sentences describing the domain this package models — it is embedded as the implementation contract.');
  }
  if (!Array.isArray(input.post_types) || input.post_types.length === 0) {
    throw errInvalidInput('post_types must declare at least one post type.', 'A schema package with no model is a plugin, not a schema.');
  }
  for (const cpt of input.post_types) {
    assertSchemaSlug(cpt.slug, 'post type slug');
    const normalized = cpt.slug.replace(/-/g, '_');
    if (RESERVED_POST_TYPES.has(normalized) || normalized.length > 20) {
      throw errInvalidInput(`post type slug "${cpt.slug}" is reserved or too long (max 20 chars).`, 'Pick a distinct, short slug; WordPress caps post type names at 20 characters.');
    }
  }

  const version = input.version ?? '1.0.0';
  const parent = input.dir ?? schemaWorkspace();
  const dir = path.join(parent, input.slug);

  if (fs.existsSync(dir) && !input.force) {
    throw errInvalidInput(`${dir} already exists.`, 'Pass force:true to overwrite, or pick a different slug/dir.');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const files: Record<string, string> = {
    [`${input.slug}.php`]: mainPluginPhp(input, version),
    'routes.php': routesPhp(input),
    'uninstall.php': uninstallPhp(input),
    [SCHEMA_META_FILE]: JSON.stringify(packageMeta(input, version), null, 2) + '\n',
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }

  return { dir, slug: input.slug, files: Object.keys(files).sort() };
}

/* ========================================================================== */
/* Probe generation                                                           */
/* ========================================================================== */

function modelProbePhp(meta: SchemaPackageMeta): string {
  return `<?php
require_once '/wordpress/wp-load.php';
wp_set_current_user( 1 );

$declared = json_decode( ${phpJson(JSON.stringify(meta.provides))}, true );
$out      = array( 'types' => array(), 'meta' => array(), 'taxonomies' => array(), 'bindings' => array() );

$req   = new WP_REST_Request( 'GET', '/wp/v2/types' );
$types = rest_do_request( $req );
$type_data = ( ! is_wp_error( $types ) && 200 === $types->get_status() ) ? (array) $types->get_data() : array();

foreach ( $declared['post_types'] as $slug ) {
	$out['types'][ $slug ] = isset( $type_data[ $slug ] );
}

foreach ( $declared['meta_keys'] as $mk ) {
	$keys = get_registered_meta_keys( 'post', $mk['post_type'] );
	$args = $keys[ $mk['key'] ] ?? null;
	$out['meta'][ $mk['post_type'] . ':' . $mk['key'] ] = (bool) ( $args && ! empty( $args['show_in_rest'] ) );
}

$req  = new WP_REST_Request( 'GET', '/wp/v2/taxonomies' );
$req->set_param( 'context', 'edit' );
$taxes = rest_do_request( $req );
$tax_data = ( ! is_wp_error( $taxes ) && 200 === $taxes->get_status() ) ? (array) $taxes->get_data() : array();
foreach ( $declared['taxonomies'] as $slug ) {
	$out['taxonomies'][ $slug ] = isset( $tax_data[ $slug ] ) || taxonomy_exists( $slug );
}

foreach ( $declared['binding_sources'] as $source ) {
	$out['bindings'][ $source ] = class_exists( 'WP_Block_Bindings_Registry' )
		&& null !== WP_Block_Bindings_Registry::get_instance()->get_registered( $source );
}

echo "\\n${TAG}" . wp_json_encode( $out ) . "${TAG}";
`;
}

function routesProbePhp(meta: SchemaPackageMeta, slug: string): string {
  return `<?php
require_once '/wordpress/wp-load.php';

$ns     = ${phpJson(`agent-${slug}/v1`)};
$routes = json_decode( ${phpJson(JSON.stringify(meta.provides.routes))}, true );
$out    = array();

foreach ( $routes as $route ) {
	$method = strtoupper( explode( ',', (string) $route['methods'][0] )[0] );
	$path   = '/' . $ns . $route['path'];

	// Valid call: anonymous for public-nonce (with a uid-0 REST nonce),
	// admin for capability routes.
	if ( 'public-nonce' === $route['auth'] ) {
		wp_set_current_user( 0 );
		$req = new WP_REST_Request( $method, $path );
		$req->set_param( '_wpnonce', wp_create_nonce( 'wp_rest' ) );
		$req->set_param( 'hp_website', '' );
		$req->set_param( 'title', 'Smoke sample' );
	} else {
		wp_set_current_user( 1 );
		$req = new WP_REST_Request( $method, $path );
	}
	$res    = rest_do_request( $req );
	$status = is_wp_error( $res ) ? 500 : $res->get_status();

	// Unauthenticated probe for protected routes.
	$unauth = null;
	if ( 'capability' === $route['auth'] ) {
		wp_set_current_user( 0 );
		$ures   = rest_do_request( new WP_REST_Request( $method, $path ) );
		$unauth = is_wp_error( $ures ) ? 500 : $ures->get_status();
	}

	$out[] = array(
		'path'          => $route['path'],
		'method'        => $method,
		'status'        => (int) $status,
		'unauth_status' => $unauth,
	);
}

echo "\\n${TAG}" . wp_json_encode( $out ) . "${TAG}";
`;
}

function uninstallProbePhp(meta: SchemaPackageMeta, pluginSlug: string, pluginFile: string): string {
  return `<?php
require_once '/wordpress/wp-load.php';
wp_set_current_user( 1 );

// Deactivate; the NEXT request must show none of the declared registrations.
require_once ABSPATH . 'wp-admin/includes/plugin.php';
deactivate_plugins( ${phpJson(`${pluginSlug}/${pluginFile}`)} );

echo "\\n${TAG}" . wp_json_encode( array( 'deactivated' => ! is_plugin_active( ${phpJson(`${pluginSlug}/${pluginFile}`)} ) ) ) . "${TAG}";
`;
}

function postUninstallProbePhp(meta: SchemaPackageMeta): string {
  return `<?php
require_once '/wordpress/wp-load.php';

$declared = json_decode( ${phpJson(JSON.stringify(meta.provides))}, true );
$leftover = array();

foreach ( $declared['post_types'] as $slug ) {
	if ( post_type_exists( $slug ) ) {
		$leftover[] = 'post_type:' . $slug;
	}
}
foreach ( $declared['taxonomies'] as $slug ) {
	if ( taxonomy_exists( $slug ) ) {
		$leftover[] = 'taxonomy:' . $slug;
	}
}
foreach ( $declared['binding_sources'] as $source ) {
	if ( class_exists( 'WP_Block_Bindings_Registry' ) && null !== WP_Block_Bindings_Registry::get_instance()->get_registered( $source ) ) {
		$leftover[] = 'binding:' . $source;
	}
}

echo "\\n${TAG}" . wp_json_encode( array( 'leftover' => $leftover ) ) . "${TAG}";
`;
}

/* ========================================================================== */
/* Build test                                                                 */
/* ========================================================================== */

function readTaggedJson(outcome: ProbeOutcome | undefined): any {
  if (!outcome) return null;
  const parts = String(outcome.text ?? '').split(TAG);
  if (parts.length < 3) return null;
  try {
    return JSON.parse(parts[1] ?? '');
  } catch {
    return null;
  }
}

export async function schemaBuildTest(
  dir: string,
  opts: { timeoutMs?: number; port?: number; logger?: Logger } = {},
): Promise<SchemaBuildTestResult> {
  const metaPath = path.join(dir, SCHEMA_META_FILE);
  if (!fs.existsSync(metaPath)) {
    throw errInvalidInput(`${dir} has no ${SCHEMA_META_FILE}.`, 'Point at a directory produced by wp_schema_scaffold.');
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as SchemaPackageMeta;
  const pluginSlug = SCHEMA_PLUGIN_PREFIX + meta.slug;
  const pluginFile = `${meta.slug}.php`;

  const emptySmoke: SchemaSmoke = {
    booted: false,
    types_registered: {},
    meta_in_rest: {},
    taxonomies_registered: {},
    routes: [],
    bindings_registered: {},
    uninstall_clean: false,
  };

  // 1. Static policy scan — cheap, specific, before any sandbox.
  const violations = policyScan(dir);
  if (violations.length) {
    return {
      built: false,
      smoke: emptySmoke,
      failure: {
        code: 'schema_policy',
        message: violations.map((v) => `${v.file}:${v.line} — ${v.what}`).join('; '),
        hint: 'Schema packages register exclusively through core APIs (register_post_type, register_post_meta, register_rest_route, ...). Remove the direct database/process access.',
      },
    };
  }

  // 2. Sandbox: mount, activate, probe.
  const cliEntry = resolvePlaygroundCli();
  const port = await freePort(opts.port);
  const runDir = path.join(dir, '.x-agent-build');
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
    pluginDir: dir,
    pluginSlug,
    pluginFile,
    probes: {
      model: modelProbePhp(meta),
      routes: routesProbePhp(meta, meta.slug),
      uninstall: uninstallProbePhp(meta, pluginSlug, pluginFile),
      post_uninstall: postUninstallProbePhp(meta),
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  opts.logger?.info(`schema smoke: ${pluginSlug} in a throwaway WordPress on port ${port}`);
  const res = await run(process.execPath, [runnerPath, configPath, resultPath], {
    cwd: runDir,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
  });

  let raw: SmokeRunnerResult | undefined;
  if (fs.existsSync(resultPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as SmokeRunnerResult;
    } catch {
      raw = undefined;
    }
  }
  const log = `${res.stdout}\n${res.stderr}`.slice(-8000);

  if (!raw || !raw.booted) {
    return {
      built: false,
      smoke: emptySmoke,
      build_log: log,
      failure: {
        code: 'smoke_failed',
        message: raw?.error || 'The throwaway WordPress never booted.',
        hint: 'Read build_log. A PHP parse error in the package fatals plugin activation — fix the file it names and rerun.',
      },
    };
  }

  const model = readTaggedJson(raw.probes?.model);
  const routes = readTaggedJson(raw.probes?.routes);
  const postUninstall = readTaggedJson(raw.probes?.post_uninstall);

  const phpError =
    [raw.probes?.model, raw.probes?.routes, raw.probes?.uninstall, raw.probes?.post_uninstall]
      .filter((p): p is ProbeOutcome => Boolean(p?.threw))
      .map((p) => p.error_text)
      .join(' | ') || undefined;

  const smoke: SchemaSmoke = {
    booted: true,
    types_registered: (model?.types ?? {}) as Record<string, boolean>,
    meta_in_rest: (model?.meta ?? {}) as Record<string, boolean>,
    taxonomies_registered: (model?.taxonomies ?? {}) as Record<string, boolean>,
    bindings_registered: (model?.bindings ?? {}) as Record<string, boolean>,
    routes: Array.isArray(routes)
      ? routes.map((r: any) => ({
          path: String(r.path),
          method: String(r.method),
          status: Number(r.status),
          ...(r.unauth_status !== null && r.unauth_status !== undefined ? { unauth_status: Number(r.unauth_status) } : {}),
          ok:
            Number(r.status) >= 200 &&
            Number(r.status) < 300 &&
            (r.unauth_status === null || r.unauth_status === undefined || [401, 403].includes(Number(r.unauth_status))),
        }))
      : [],
    uninstall_clean: Array.isArray(postUninstall?.leftover) && postUninstall.leftover.length === 0,
    ...(phpError ? { php_error: phpError } : {}),
  };

  const failures: string[] = [];
  for (const [slug, ok] of Object.entries(smoke.types_registered)) if (!ok) failures.push(`post type "${slug}" missing from /wp/v2/types`);
  for (const [key, ok] of Object.entries(smoke.meta_in_rest)) if (!ok) failures.push(`meta "${key}" not REST-visible (show_in_rest with a schema is policy)`);
  for (const [slug, ok] of Object.entries(smoke.taxonomies_registered)) if (!ok) failures.push(`taxonomy "${slug}" not registered`);
  for (const [source, ok] of Object.entries(smoke.bindings_registered)) if (!ok) failures.push(`binding source "${source}" not registered`);
  for (const r of smoke.routes) if (!r.ok) failures.push(`route ${r.method} ${r.path} answered ${r.status}${r.unauth_status !== undefined ? ` / unauth ${r.unauth_status}` : ''}`);
  if (!smoke.uninstall_clean) failures.push(`uninstall leaves registrations behind: ${JSON.stringify(postUninstall?.leftover ?? 'unknown')}`);
  if (phpError) failures.push(`php error: ${phpError}`);

  if (failures.length) {
    return {
      built: false,
      smoke,
      build_log: log,
      failure: {
        code: 'smoke_failed',
        message: failures.join('; '),
        hint: 'The gate is the safety mechanism — fix the package and rerun. Nothing was sent to any instance.',
      },
    };
  }

  // 3. Zip — the only artifact wp_schema_install accepts.
  const AdmZip = loadAdmZip();
  const zip = new AdmZip();
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.php') || file === SCHEMA_META_FILE) {
      zip.addFile(file, fs.readFileSync(path.join(dir, file)));
    }
  }
  const buffer = zip.toBuffer();
  if (buffer.length > MAX_SCHEMA_PACKAGE_BYTES) {
    return {
      built: false,
      smoke,
      failure: { code: 'smoke_failed', message: `package is ${buffer.length} bytes; the policy cap is ${MAX_SCHEMA_PACKAGE_BYTES}.`, hint: 'A schema package is registrations, not assets.' },
    };
  }
  const zipPath = path.join(runDir, `${pluginSlug}-${meta.version}.zip`);
  zip.writeZip(zipPath);

  return { built: true, smoke, zip_path: zipPath, build_log: log };
}
