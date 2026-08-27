/**
 * mock-companion — a tiny Node http server that implements the x-companion wire
 * contract from the vendored schemas plus canned fixtures, so the whole agent
 * test suite runs with zero WordPress.
 *
 * It implements, per CONTRACT.md:
 *   - both URL forms: `/wp-json/x-companion/v1/...` and `/?rest_route=/x-companion/v1/...`
 *   - HTTP Basic auth on EVERY route including GET /harness; 401 otherwise
 *   - the exact WP_Error envelope `{code, message, data:{status}}` on every non-2xx
 *   - GET /fingerprint, GET /manifest, GET /patterns, GET /harness
 *   - POST /validate (a real subset of the diagnostic engine), POST /parse, POST /render
 *   - stubs for the extend tier, posture-gated to 403 `posture_forbidden` on production
 *
 * And it is scriptable from tests:
 *   setFingerprint(fp)        bump the epoch mid-run
 *   setPosture(p)             flip toolchain <-> production
 *   setEpochMode(mode)        'off' | 'diagnostics' | 'http409' | 'always'
 *   log                       every request, in order, with the URL form used
 *   countHits('/validate')    convenience counter
 *
 * Usage:
 *   const mock = await startMockCompanion();
 *   ...
 *   await mock.close();
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  MOCK_BLOCKS,
  MOCK_PATTERNS,
  MOCK_SUITES,
  MOCK_THEME_TOKENS,
  DEFAULT_FINGERPRINT,
  type MockBlock,
} from './fixtures.js';

export type Posture = 'toolchain' | 'production';

/**
 * 'off'          never inject a mismatch
 * 'diagnostics'  a stale tree.epoch yields E_EPOCH_MISMATCH in Diagnostics (real behaviour)
 * 'http409'      a stale X-Expected-Fingerprint header yields 409 {code:'epoch_mismatch'}
 * 'always'       every /validate reports E_EPOCH_MISMATCH regardless of the epoch sent
 */
export type EpochMode = 'off' | 'diagnostics' | 'http409' | 'always';

export type UrlFormSupport = 'both' | 'pretty' | 'plain';

export interface MockRequestLogEntry {
  method: string;
  /** Route path relative to the namespace, e.g. `/validate`. */
  route: string;
  /** Which URL form the client used. */
  form: 'pretty' | 'plain' | 'unknown';
  status: number;
  authorized: boolean;
  expectedFingerprintHeader?: string;
  body?: unknown;
  at: number;
}

export interface MockCompanionOptions {
  posture?: Posture;
  fingerprint?: string;
  user?: string;
  password?: string;
  requireAuth?: boolean;
  urlForm?: UrlFormSupport;
  epochMode?: EpochMode;
  wpVersion?: string;
  blocks?: Record<string, MockBlock>;
}

export interface MockCompanion {
  url: string;
  port: number;
  log: MockRequestLogEntry[];
  setFingerprint(fp: string): void;
  getFingerprint(): string;
  setPosture(p: Posture): void;
  setEpochMode(m: EpochMode): void;
  setUrlForm(f: UrlFormSupport): void;
  countHits(route: string, method?: string): number;
  clearLog(): void;
  close(): Promise<void>;
}

const NS = '/x-companion/v1';
const INTERFACES_VERSION = '1';

const GLOBAL_ATTR_WHITELIST = new Set([
  'className',
  'style',
  'lock',
  'metadata',
  'align',
  'anchor',
  'backgroundColor',
  'textColor',
  'gradient',
  'fontSize',
  'fontFamily',
  'borderColor',
  'layout',
  'templateLock',
]);

export async function startMockCompanion(opts: MockCompanionOptions = {}): Promise<MockCompanion> {
  const state = {
    posture: opts.posture ?? ('toolchain' as Posture),
    fingerprint: opts.fingerprint ?? DEFAULT_FINGERPRINT,
    user: opts.user ?? 'agent',
    password: opts.password ?? 'aaaa bbbb cccc dddd eeee ffff',
    requireAuth: opts.requireAuth !== false,
    urlForm: opts.urlForm ?? ('both' as UrlFormSupport),
    epochMode: opts.epochMode ?? ('diagnostics' as EpochMode),
    wpVersion: opts.wpVersion ?? '6.7.1',
    blocks: opts.blocks ?? MOCK_BLOCKS,
  };
  const log: MockRequestLogEntry[] = [];

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      sendError(res, 500, 'internal_error', (e as Error).message, { form: 'unknown', route: '?', method: req.method ?? 'GET', log, authorized: true });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://localhost');

    // ---------------- URL form resolution
    let route: string | null = null;
    let form: 'pretty' | 'plain' | 'unknown' = 'unknown';

    if (url.pathname.startsWith(`/wp-json${NS}`)) {
      form = 'pretty';
      route = url.pathname.slice(`/wp-json${NS}`.length) || '/';
    } else if (url.searchParams.has('rest_route')) {
      const rr = url.searchParams.get('rest_route')!;
      if (rr.startsWith(NS)) {
        form = 'plain';
        route = rr.slice(NS.length) || '/';
      }
    }

    const ctxBase = { method, route: route ?? url.pathname, form, log, authorized: false as boolean };

    if (route === null) {
      return sendError(res, 404, 'rest_no_route', 'No route was found matching the URL and request method.', ctxBase);
    }
    if (state.urlForm === 'pretty' && form === 'plain') {
      return sendError(res, 404, 'rest_no_route', 'Plain permalinks are disabled on this instance.', ctxBase);
    }
    if (state.urlForm === 'plain' && form === 'pretty') {
      return sendError(res, 404, 'rest_no_route', 'No route was found matching the URL and request method.', ctxBase);
    }

    // ---------------- Basic auth on EVERY route, including /harness
    const authorized = checkAuth(req.headers.authorization, state.user, state.password);
    ctxBase.authorized = authorized;
    if (state.requireAuth && !authorized) {
      return sendError(res, 401, 'rest_forbidden', 'Sorry, you are not allowed to do that.', ctxBase);
    }

    const expectedHeader = firstHeader(req.headers['x-expected-fingerprint']);
    const body = await readBody(req);

    const ctx = { ...ctxBase, expectedFingerprintHeader: expectedHeader, body };

    // ---------------- HTTP 409 epoch conflict injection
    if (state.epochMode === 'http409' && expectedHeader && expectedHeader !== state.fingerprint && route !== '/fingerprint' && route !== '/manifest') {
      return sendError(res, 409, 'epoch_mismatch', 'The instance registry moved since this batch started.', ctx, {
        server_fingerprint: state.fingerprint,
      });
    }

    const extendRoutes = /^\/(blocks|theme|snapshot)\b/;
    if (extendRoutes.test(route) && state.posture === 'production') {
      return sendError(res, 403, 'posture_forbidden', 'Extend-tier routes are disabled on a production-posture instance.', ctx);
    }

    // ---------------- routing
    if (method === 'GET' && route === '/fingerprint') {
      return sendJson(res, 200, { fingerprint: state.fingerprint, posture: state.posture, interfaces_version: INTERFACES_VERSION }, ctx);
    }
    if (method === 'GET' && route === '/manifest') {
      return sendJson(res, 200, buildManifest(), ctx);
    }
    if (method === 'GET' && route === '/patterns') {
      return sendJson(res, 200, MOCK_PATTERNS, ctx);
    }
    if (method === 'GET' && route === '/harness') {
      return sendHtml(res, 200, harnessHtml(), ctx);
    }
    if (method === 'POST' && route === '/validate') {
      return sendJson(res, 200, runValidate(body), ctx);
    }
    if (method === 'POST' && route === '/parse') {
      const markup = (body as { markup?: string } | undefined)?.markup;
      if (typeof markup !== 'string') return sendError(res, 400, 'rest_invalid_param', 'Invalid parameter(s): markup', ctx);
      return sendJson(res, 200, { blocks: fakeParse(markup) }, ctx);
    }
    if (method === 'POST' && route === '/render') {
      const markup = (body as { markup?: string } | undefined)?.markup;
      if (typeof markup !== 'string') return sendError(res, 400, 'rest_invalid_param', 'Invalid parameter(s): markup', ctx);
      return sendJson(
        res,
        200,
        {
          html: fakeRender(markup),
          enqueued_styles: [`${baseUrl()}/wp-includes/css/dist/block-library/style.min.css`],
        },
        ctx,
      );
    }

    // ---------------- extend tier stubs
    if (method === 'POST' && route === '/blocks/install') {
      state.fingerprint = bump(state.fingerprint);
      return sendJson(
        res,
        200,
        {
          installed: { slug: 'pricing-card', name: 'agent/pricing-card', version: '0.1.0' },
          fingerprint: state.fingerprint,
          replaced_previous: false,
        },
        ctx,
      );
    }
    if (method === 'POST' && route === '/themes/install') {
      state.fingerprint = bump(state.fingerprint);
      return sendJson(
        res,
        200,
        {
          installed: { slug: 'salon-regale', name: 'Salon Regale Theme', version: '1.0.0' },
          fingerprint: state.fingerprint,
          replaced_previous: false,
          previous_theme: 'twentytwentyfive',
        },
        ctx,
      );
    }
    if (method === 'GET' && route === '/blocks/library') {
      return sendJson(
        res,
        200,
        [{ slug: 'testimonial', name: 'agent/testimonial', version: '0.1.0', installed_at: '2026-01-01T00:00:00Z', has_prev: false }],
        ctx,
      );
    }
    if (method === 'POST' && /^\/blocks\/library\/[^/]+\/rollback$/.test(route)) {
      state.fingerprint = bump(state.fingerprint);
      return sendJson(res, 200, { fingerprint: state.fingerprint }, ctx);
    }
    if (method === 'DELETE' && /^\/blocks\/library\/[^/]+$/.test(route)) {
      state.fingerprint = bump(state.fingerprint);
      return sendJson(res, 200, { fingerprint: state.fingerprint }, ctx);
    }
    if (method === 'POST' && route === '/theme/tokens') {
      state.fingerprint = bump(state.fingerprint);
      return sendJson(res, 200, { theme_json_written: true, adapters_applied: ['kadence-blocks'], fingerprint: state.fingerprint }, ctx);
    }
    if (method === 'POST' && route === '/snapshot/export') {
      // A tiny but structurally valid empty-zip byte sequence.
      const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
      logEntry(ctx, 200);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(zip.length) });
      res.end(zip);
      return;
    }

    return sendError(res, 404, 'rest_no_route', 'No route was found matching the URL and request method.', ctx);
  }

  /* ------------------------------------------------------------- validate */

  function runValidate(body: unknown): unknown {
    const diagnostics: { code: string; severity: 'error' | 'warning'; path: string; message: string; fix_hint?: string }[] = [];

    const schemaIssue = treeSchemaIssue(body);
    if (schemaIssue) {
      diagnostics.push({ code: 'E_TREE_SCHEMA', severity: 'error', path: schemaIssue.path, message: schemaIssue.message });
      return { valid: false, epoch_ok: false, server_fingerprint: state.fingerprint, diagnostics };
    }

    const tree = body as { epoch: string; blocks: BlockNodeLike[] };
    const epochOk = state.epochMode === 'always' ? false : tree.epoch === state.fingerprint;
    if (!epochOk) {
      diagnostics.push({
        code: 'E_EPOCH_MISMATCH',
        severity: 'error',
        path: '/epoch',
        message: `Tree epoch ${tree.epoch} does not match the instance fingerprint ${state.fingerprint}.`,
        fix_hint: 'Refresh the manifest and regenerate the tree at the new epoch.',
      });
    }

    const staticSeen = new Set<string>();
    walk(tree.blocks ?? [], '/blocks', [], null);

    function walk(nodes: BlockNodeLike[], base: string, ancestors: string[], parentName: string | null): void {
      nodes.forEach((node, i) => {
        const ptr = `${base}/${i}`;
        const def = state.blocks[node.name];
        if (!def) {
          diagnostics.push({
            code: 'E_UNKNOWN_BLOCK',
            severity: 'error',
            path: ptr,
            message: `Block "${node.name}" is not registered on this instance.`,
            fix_hint: 'Use wp_manifest to list the real vocabulary, or install the block via the R7 ladder.',
          });
          return; // children of an unknown block are not further checked
        }

        if (def.parent && def.parent.length > 0 && (parentName === null || !def.parent.includes(parentName))) {
          diagnostics.push({
            code: 'E_NEST_PARENT',
            severity: 'error',
            path: ptr,
            message: `"${node.name}" declares parent [${def.parent.join(', ')}] but its immediate parent here is ${parentName ?? 'the tree root'}.`,
          });
        }
        if (def.ancestor && def.ancestor.length > 0 && !def.ancestor.some((a) => ancestors.includes(a))) {
          diagnostics.push({
            code: 'E_NEST_ANCESTOR',
            severity: 'error',
            path: ptr,
            message: `"${node.name}" declares ancestor [${def.ancestor.join(', ')}] but none appear in the chain [${ancestors.join(', ')}].`,
          });
        }

        for (const [key, value] of Object.entries(node.attributes ?? {})) {
          const spec = (def.attributes ?? {})[key] as { type?: string | string[]; enum?: unknown[] } | undefined;
          if (!spec) {
            if (!GLOBAL_ATTR_WHITELIST.has(key)) {
              diagnostics.push({
                code: 'W_ATTR_UNKNOWN',
                severity: 'warning',
                path: `${ptr}/attributes/${key}`,
                message: `Attribute "${key}" is not declared by ${node.name}.`,
              });
            }
            continue;
          }
          if (spec.type !== undefined && !typeMatches(value, spec.type)) {
            diagnostics.push({
              code: 'E_ATTR_TYPE',
              severity: 'error',
              path: `${ptr}/attributes/${key}`,
              message: `Attribute "${key}" of ${node.name} must be ${JSON.stringify(spec.type)}, got ${jsonType(value)}.`,
            });
          } else if (Array.isArray(spec.enum) && !spec.enum.some((e) => e === value)) {
            diagnostics.push({
              code: 'E_ATTR_ENUM',
              severity: 'error',
              path: `${ptr}/attributes/${key}`,
              message: `Attribute "${key}" of ${node.name} must be one of ${JSON.stringify(spec.enum)}, got ${JSON.stringify(value)}.`,
            });
          }
        }

        const hints = (def.agent_hints ?? {}) as { allowed_blocks?: string[] | null; template_lock?: string | boolean | null };
        if (Array.isArray(hints.allowed_blocks) && (node.innerBlocks ?? []).length) {
          for (const [j, child] of (node.innerBlocks ?? []).entries()) {
            if (!hints.allowed_blocks.includes(child.name)) {
              diagnostics.push({
                code: 'W_HINT_ALLOWED_BLOCKS',
                severity: 'warning',
                path: `${ptr}/innerBlocks/${j}`,
                message: `${node.name} declares allowed_blocks [${hints.allowed_blocks.join(', ')}]; "${child.name}" is not one of them.`,
              });
            }
          }
        }
        if ((hints.template_lock === 'all' || hints.template_lock === 'insert') && (node.innerBlocks ?? []).length) {
          diagnostics.push({
            code: 'W_HINT_TEMPLATE_LOCK',
            severity: 'warning',
            path: ptr,
            message: `${node.name} declares template_lock "${hints.template_lock}" but the tree adds children.`,
          });
        }

        if (def.is_dynamic === false && !staticSeen.has(node.name)) {
          staticSeen.add(node.name);
          diagnostics.push({
            code: 'W_STATIC_NEEDS_HARNESS',
            severity: 'warning',
            path: ptr,
            message: `${node.name} is a static block.`,
            fix_hint: 'canonical markup must come from harness compile, do not hand-serialize',
          });
        }

        if (node.innerBlocks?.length) walk(node.innerBlocks, `${ptr}/innerBlocks`, [...ancestors, node.name], node.name);
      });
    }

    return {
      valid: !diagnostics.some((d) => d.severity === 'error'),
      epoch_ok: epochOk,
      server_fingerprint: state.fingerprint,
      diagnostics,
    };
  }

  /* --------------------------------------------------------------- helpers */

  function buildManifest() {
    const blocks = state.blocks;
    const names = Object.keys(blocks).sort();
    const dynamic = names.filter((n) => blocks[n]!.is_dynamic).length;
    return {
      fingerprint: state.fingerprint,
      generated_at: new Date(0).toISOString(),
      wp_version: state.wpVersion,
      site_url: baseUrl(),
      posture: state.posture,
      interfaces_version: INTERFACES_VERSION,
      theme: { slug: 'twentytwentyfive', name: 'Twenty Twenty-Five', version: '1.0' },
      blocks: Object.fromEntries(names.map((n) => [n, blocks[n]!])),
      patterns: MOCK_PATTERNS.map((p) => ({
        name: p.name,
        title: p.title,
        categories: p.categories,
        source: 'theme',
        has_content: true,
      })),
      theme_tokens: MOCK_THEME_TOKENS,
      suites: MOCK_SUITES,
      counts: { blocks: names.length, dynamic_blocks: dynamic, static_blocks: names.length - dynamic, patterns: MOCK_PATTERNS.length },
    };
  }

  function baseUrl(): string {
    const addr = server.address() as AddressInfo | null;
    return `http://127.0.0.1:${addr?.port ?? 0}`;
  }

  function logEntry(ctx: LogCtx, status: number): void {
    const e: MockRequestLogEntry = {
      method: ctx.method,
      route: ctx.route,
      form: ctx.form,
      status,
      authorized: ctx.authorized,
      at: Date.now(),
    };
    if (ctx.expectedFingerprintHeader !== undefined) e.expectedFingerprintHeader = ctx.expectedFingerprintHeader;
    if (ctx.body !== undefined) e.body = ctx.body;
    log.push(e);
  }

  function sendJson(res: http.ServerResponse, status: number, payload: unknown, ctx: LogCtx): void {
    logEntry(ctx, status);
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(buf.length) });
    res.end(buf);
  }

  function sendHtml(res: http.ServerResponse, status: number, html: string, ctx: LogCtx): void {
    logEntry(ctx, status);
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(buf.length) });
    res.end(buf);
  }

  function sendError(
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string,
    ctx: LogCtx,
    extraData: Record<string, unknown> = {},
  ): void {
    logEntry(ctx, status);
    // Exact WP_Error envelope, CONTRACT.md §2.
    const body = JSON.stringify({ code, message, data: { status, ...extraData } });
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(buf.length) });
    res.end(buf);
  }

  function harnessHtml(): string {
    const names = JSON.stringify(Object.keys(state.blocks).sort());
    return [
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>x-companion harness</title></head><body>',
      '<script>',
      'window.__version = "1";',
      `window.__registryNames = ${names};`,
      'window.__registry = function () { return window.__registryNames; };',
      'window.__ready = Promise.resolve();',
      'window.__compile = function (blocks) { return { markup: "", all_valid: true, invalid: [] }; };',
      '</script></body></html>',
    ].join('\n');
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    log,
    setFingerprint: (fp: string) => {
      state.fingerprint = fp;
    },
    getFingerprint: () => state.fingerprint,
    setPosture: (p: Posture) => {
      state.posture = p;
    },
    setEpochMode: (m: EpochMode) => {
      state.epochMode = m;
    },
    setUrlForm: (f: UrlFormSupport) => {
      state.urlForm = f;
    },
    countHits: (route: string, method?: string) =>
      log.filter((e) => e.route === route && (method === undefined || e.method === method.toUpperCase())).length,
    clearLog: () => {
      log.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

/* -------------------------------------------------------------- utilities */

interface LogCtx {
  method: string;
  route: string;
  form: 'pretty' | 'plain' | 'unknown';
  authorized: boolean;
  expectedFingerprintHeader?: string;
  body?: unknown;
  log: MockRequestLogEntry[];
}

interface BlockNodeLike {
  name: string;
  attributes?: Record<string, unknown>;
  innerBlocks?: BlockNodeLike[];
  [k: string]: unknown;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function checkAuth(header: string | undefined, user: string, password: string): boolean {
  if (!header || !/^Basic\s+/i.test(header)) return false;
  const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  return decoded.slice(0, idx) === user && decoded.slice(idx + 1) === password;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c as Buffer));
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks);
  const ct = String(req.headers['content-type'] ?? '');
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return { __unparseable: raw.toString('utf8').slice(0, 200) };
    }
  }
  if (ct.includes('multipart/form-data')) return { __multipart_bytes: raw.length };
  return raw.toString('utf8').slice(0, 500);
}

/** TreeIR schema check, mirroring tree-ir.schema.json closely enough to matter. */
function treeSchemaIssue(body: unknown): { path: string; message: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { path: '/', message: 'Body must be a TreeIR object.' };
  const t = body as Record<string, unknown>;
  if (t.version !== 1) return { path: '/version', message: 'version must be the literal 1.' };
  if (typeof t.epoch !== 'string') return { path: '/epoch', message: 'epoch must be a string.' };
  if (!Array.isArray(t.blocks)) return { path: '/blocks', message: 'blocks must be an array.' };
  return walkNodes(t.blocks, '/blocks');

  function walkNodes(nodes: unknown[], base: string): { path: string; message: string } | null {
    for (let i = 0; i < nodes.length; i++) {
      const ptr = `${base}/${i}`;
      const n = nodes[i];
      if (!n || typeof n !== 'object' || Array.isArray(n)) return { path: ptr, message: 'BlockNode must be an object.' };
      const node = n as Record<string, unknown>;
      if (typeof node.name !== 'string' || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(node.name)) {
        return { path: `${ptr}/name`, message: 'name must match ^[a-z0-9-]+/[a-z0-9-]+$.' };
      }
      for (const key of Object.keys(node)) {
        if (!['name', 'attributes', 'innerBlocks'].includes(key)) {
          return {
            path: `${ptr}/${key}`,
            message: `BlockNode is additionalProperties:false; "${key}" is not allowed. innerHTML is a compiler output, never tree input.`,
          };
        }
      }
      if (node.attributes !== undefined && (typeof node.attributes !== 'object' || node.attributes === null || Array.isArray(node.attributes))) {
        return { path: `${ptr}/attributes`, message: 'attributes must be an object.' };
      }
      if (node.innerBlocks !== undefined) {
        if (!Array.isArray(node.innerBlocks)) return { path: `${ptr}/innerBlocks`, message: 'innerBlocks must be an array.' };
        const deeper = walkNodes(node.innerBlocks, `${ptr}/innerBlocks`);
        if (deeper) return deeper;
      }
    }
    return null;
  }
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number';
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'null':
        return value === null;
      default:
        return true;
    }
  });
}

/** Extremely small block-comment parser — enough for parse/render round trips. */
function fakeParse(markup: string): unknown[] {
  const out: unknown[] = [];
  const re = /<!--\s+wp:([a-z0-9-]+\/[a-z0-9-]+)(\s+(\{.*?\}))?\s+(\/)?-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup)) !== null) {
    let attrs: Record<string, unknown> = {};
    if (m[3]) {
      try {
        attrs = JSON.parse(m[3]) as Record<string, unknown>;
      } catch {
        attrs = {};
      }
    }
    out.push({ blockName: m[1], attrs, innerBlocks: [], innerHTML: '', innerContent: [] });
  }
  out.push({ blockName: null, attrs: {}, innerBlocks: [], innerHTML: '\n', innerContent: ['\n'] });
  return out;
}

function fakeRender(markup: string): string {
  const names = [...markup.matchAll(/<!--\s+wp:([a-z0-9-]+\/[a-z0-9-]+)/g)].map((m) => m[1]);
  return `<div class="entry-content">${names.map((n) => `<div class="wp-block-${String(n).replace('/', '-')}"></div>`).join('')}</div>`;
}

function bump(fp: string): string {
  const n = (parseInt(fp.slice(0, 8), 16) + 1) >>> 0;
  return n.toString(16).padStart(8, '0') + fp.slice(8);
}

export { MOCK_BLOCKS, MOCK_PATTERNS, DEFAULT_FINGERPRINT } from './fixtures.js';
export { BUMPED_FINGERPRINT } from './fixtures.js';
