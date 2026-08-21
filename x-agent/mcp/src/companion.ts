/**
 * Typed, epoch-aware client for EVERY x-companion route (CONTRACT.md §5).
 *
 * THIS FILE IS THE ONLY PLACE IN THE PACKAGE THAT PERFORMS HTTP.
 * The session/oracle/factory track must call these methods rather than writing
 * `fetch`. That includes `harnessUrl()` + `basicCredentials()` (Playwright
 * navigation) and `installBlockFromFile()` (the raw multipart POST).
 *
 * Base-URL probing (CONTRACT.md preamble): pretty permalinks
 * `${site}/wp-json/x-companion/v1${path}` are tried first; a 404 whose body is a
 * `rest_no_route` WP_Error (or a non-JSON 404) while the form is still unknown
 * flips the client to `${site}/?rest_route=/x-companion/v1${path}`. The winning
 * form is cached for the lifetime of the client.
 *
 * Epoch discipline (CONTRACT.md §8): every request carries the expected
 * fingerprint in the `X-Expected-Fingerprint` header, and `TreeIR.epoch` carries
 * it on `POST /validate`. On `E_EPOCH_MISMATCH` in Diagnostics or an HTTP 409
 * epoch conflict the client refreshes the manifest ONCE, retries ONCE, and then
 * surfaces `epoch_mismatch`. It never loops. `client.stats` and the
 * `onEpochEvent` callback make that observable from tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { XError, errPostureForbidden, errEpochMismatch, redact } from './errors.js';
import type { XConfig } from './config.js';
import {
  DiagnosticsSchema,
  ManifestSchema,
  type Diagnostics,
  type Manifest,
  type TreeIR,
  type DesignTokens,
} from './schemas.js';

export const NAMESPACE = 'x-companion/v1';

export type UrlForm = 'pretty' | 'plain' | 'unknown';

export interface FingerprintResponse {
  fingerprint: string;
  posture: 'toolchain' | 'production';
  interfaces_version: string;
}

export interface PatternEntry {
  name: string;
  title: string;
  categories: string[];
  content: string;
  parsed: unknown[];
}

export interface ParsedBlock {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerBlocks: ParsedBlock[];
  innerHTML: string;
  innerContent: (string | null)[];
}

export interface InstallResult {
  installed: { slug: string; name: string; version: string };
  fingerprint: string;
  replaced_previous: boolean;
}

export interface LibraryEntry {
  slug: string;
  name: string;
  version: string;
  installed_at: string;
  has_prev: boolean;
}

export interface TokensResult {
  theme_json_written: boolean;
  adapters_applied: string[];
  fingerprint: string;
}

export interface CompanionStats {
  requests: number;
  /** How many times the epoch machinery refreshed the manifest. */
  epochRefreshes: number;
  /** How many times a call was retried after such a refresh. */
  epochRetries: number;
  /** How many times `epoch_mismatch` was surfaced to the caller. */
  epochSurfaced: number;
}

export type EpochEvent =
  | { kind: 'detected'; route: string; expected: string | undefined; server: string | undefined }
  | { kind: 'refreshed'; route: string; fingerprint: string }
  | { kind: 'retried'; route: string; fingerprint: string }
  | { kind: 'surfaced'; route: string; expected: string | undefined; server: string | undefined };

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface CompanionClientOptions {
  config: XConfig;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  onEpochEvent?: (e: EpochEvent) => void;
  /** Fixed URL form; skips probing. Used by tests. */
  urlForm?: UrlForm;
}

interface RawResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  json?: unknown;
  bodyStream?: ReadableStream<Uint8Array> | null;
}

interface RequestOptions {
  query?: Record<string, string | undefined>;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  accept?: string;
  /** Do not buffer the body; hand back the stream (snapshot export). */
  stream?: boolean;
}

const EPOCH_CONFLICT_CODES = new Set(['epoch_mismatch', 'rest_epoch_mismatch', 'x_companion_epoch_mismatch']);

export class CompanionClient {
  readonly config: XConfig;
  readonly stats: CompanionStats = { requests: 0, epochRefreshes: 0, epochRetries: 0, epochSurfaced: 0 };

  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly onEpochEvent?: (e: EpochEvent) => void;

  private urlForm: UrlForm;
  private _fingerprint?: string;
  private _posture?: 'toolchain' | 'production';
  private _interfacesVersion?: string;
  private _manifest?: Manifest;
  private _manifestFetchedAt = 0;

  constructor(opts: CompanionClientOptions) {
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.logger = opts.logger ?? silentLogger;
    if (opts.onEpochEvent) this.onEpochEvent = opts.onEpochEvent;
    this.urlForm = opts.urlForm ?? 'unknown';
  }

  /* --------------------------------------------------------------- getters */

  get siteUrl(): string {
    return this.config.site_url;
  }
  get expectedFingerprint(): string | undefined {
    return this._fingerprint;
  }
  get posture(): 'toolchain' | 'production' | undefined {
    return this._posture;
  }
  get interfacesVersion(): string | undefined {
    return this._interfacesVersion;
  }
  get cachedManifest(): Manifest | undefined {
    return this._manifest;
  }
  get manifestFetchedAt(): number {
    return this._manifestFetchedAt;
  }
  get resolvedUrlForm(): UrlForm {
    return this.urlForm;
  }

  /** Credentials for Playwright `httpCredentials` — never logged. */
  basicCredentials(): { username: string; password: string } {
    return { username: this.config.user, password: this.config.app_password };
  }

  /** `Authorization: Basic ...` value. Never log the return value un-redacted. */
  authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.config.user}:${this.config.app_password}`, 'utf8').toString('base64');
  }

  /**
   * Absolute URL of `GET /harness`. Basic auth is still required — pass
   * `basicCredentials()` to Playwright's `browser.newContext({httpCredentials})`
   * or set the `Authorization` header via `authHeader()`.
   */
  harnessUrl(): string {
    return this.buildUrl('/harness', undefined, this.urlForm === 'unknown' ? 'pretty' : this.urlForm);
  }

  /** Alternate harness URL for the other permalink form (probe fallback). */
  harnessUrlAlternate(): string {
    const other = this.urlForm === 'plain' ? 'pretty' : 'plain';
    return this.buildUrl('/harness', undefined, other);
  }

  /* ------------------------------------------------------------------ URLs */

  private buildUrl(routePath: string, query: Record<string, string | undefined> | undefined, form: 'pretty' | 'plain'): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, v);
    if (form === 'pretty') {
      const base = `${this.config.site_url}/wp-json/${NAMESPACE}${routePath}`;
      const s = qs.toString();
      return s ? `${base}?${s}` : base;
    }
    const rest = new URLSearchParams();
    rest.set('rest_route', `/${NAMESPACE}${routePath}`);
    for (const [k, v] of qs) rest.append(k, v);
    return `${this.config.site_url}/?${rest.toString()}`;
  }

  /* -------------------------------------------------------------- requests */

  private async raw(method: string, routePath: string, opts: RequestOptions, form: 'pretty' | 'plain'): Promise<RawResponse> {
    const url = this.buildUrl(routePath, opts.query, form);
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: opts.accept ?? 'application/json',
      'User-Agent': 'x-agent-mcp/0.1',
      ...(opts.headers ?? {}),
    };
    if (this._fingerprint) headers['X-Expected-Fingerprint'] = this._fingerprint;

    let body: BodyInit | undefined = opts.body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }

    this.stats.requests += 1;
    this.logger.debug(`companion ${method} ${redact(url)}`);

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body });
    } catch (e) {
      throw new XError(
        'companion_unreachable',
        `Could not reach ${redact(this.config.site_url)}: ${redact((e as Error).message)}`,
        'Check the site URL, that the machine is online, and that the x-companion plugin is active.',
        { site_url: this.config.site_url },
      );
    }

    if (opts.stream) {
      return { status: res.status, ok: res.ok, headers: res.headers, text: '', bodyStream: res.body };
    }

    const text = await res.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: res.status, ok: res.ok, headers: res.headers, text, json };
  }

  /** Probe-aware request. Throws structured XError on any non-2xx. */
  private async request(method: string, routePath: string, opts: RequestOptions = {}): Promise<RawResponse> {
    const firstForm: 'pretty' | 'plain' = this.urlForm === 'plain' ? 'plain' : 'pretty';
    let res = await this.raw(method, routePath, opts, firstForm);

    if (res.status === 404 && this.urlForm === 'unknown' && looksLikeMissingRoute(res)) {
      this.logger.debug('pretty permalinks unavailable, falling back to ?rest_route=');
      res = await this.raw(method, routePath, opts, 'plain');
      if (res.status !== 404) this.urlForm = 'plain';
    } else if (res.ok && this.urlForm === 'unknown') {
      this.urlForm = firstForm;
    }

    if (!res.ok) throw this.toError(res, routePath);
    return res;
  }

  private toError(res: RawResponse, routePath: string): XError {
    const body = (res.json ?? {}) as { code?: string; message?: string; data?: { status?: number; [k: string]: unknown } };
    const wpCode = body.code ?? `http_${res.status}`;
    const message = body.message ?? res.text.slice(0, 400) ?? `HTTP ${res.status}`;
    const extraData = body.data && typeof body.data === 'object' ? { ...body.data } : {};

    if (wpCode === 'posture_forbidden') return errPostureForbidden(routePath);

    if (res.status === 401 || wpCode === 'rest_forbidden') {
      return new XError(
        'companion_error',
        `Authentication rejected by ${redact(this.config.site_url)}: ${redact(message)}`,
        'Check X_WP_USER and the WordPress Application Password. The password must be an Application Password, not the account password.',
        { status: res.status, wp_code: wpCode, route: routePath },
      );
    }
    if (wpCode === 'rest_forbidden_capability') {
      return new XError(
        'companion_error',
        `The user lacks the capability for ${routePath}: ${redact(message)}`,
        'Grant the x_companion_read / x_companion_extend capability to this WordPress user.',
        { status: res.status, wp_code: wpCode, route: routePath },
      );
    }
    return new XError(
      'companion_error',
      `${routePath} failed (HTTP ${res.status} ${wpCode}): ${redact(message)}`,
      'Inspect the WordPress error log on the instance; the companion returned a WP_Error.',
      { status: res.status, wp_code: wpCode, route: routePath, ...extraData },
    );
  }

  private isEpochConflict(e: unknown): boolean {
    if (!(e instanceof XError)) return false;
    if (e.code !== 'companion_error') return false;
    const status = e.extra.status;
    const wpCode = String(e.extra.wp_code ?? '');
    return status === 409 && (EPOCH_CONFLICT_CODES.has(wpCode) || /epoch/i.test(wpCode));
  }

  private emit(e: EpochEvent): void {
    this.onEpochEvent?.(e);
  }

  /**
   * The one and only epoch retry loop. `run` is executed with the current
   * expected fingerprint; if `detectMismatch` says the result is an epoch
   * mismatch (or the call threw a 409 epoch conflict) the manifest is refreshed
   * ONCE and `run` executed ONCE more. A second mismatch surfaces
   * `epoch_mismatch`. Never more than two attempts.
   */
  private async withEpochRetry<T>(
    route: string,
    run: (fingerprint: string | undefined) => Promise<T>,
    detectMismatch: (result: T) => { mismatched: boolean; server?: string },
  ): Promise<T> {
    let first: T;
    try {
      first = await run(this._fingerprint);
    } catch (e) {
      if (!this.isEpochConflict(e)) throw e;
      this.emit({ kind: 'detected', route, expected: this._fingerprint, server: undefined });
      const fp = await this.refreshEpoch(route);
      this.stats.epochRetries += 1;
      this.emit({ kind: 'retried', route, fingerprint: fp });
      try {
        return await run(this._fingerprint);
      } catch (e2) {
        if (this.isEpochConflict(e2)) {
          this.stats.epochSurfaced += 1;
          this.emit({ kind: 'surfaced', route, expected: this._fingerprint, server: undefined });
          throw errEpochMismatch(this._fingerprint ?? '(unknown)', String((e2 as XError).extra.server_fingerprint ?? 'unknown'));
        }
        throw e2;
      }
    }

    const check = detectMismatch(first);
    if (!check.mismatched) return first;

    this.emit({ kind: 'detected', route, expected: this._fingerprint, server: check.server });
    const fp = await this.refreshEpoch(route);
    this.stats.epochRetries += 1;
    this.emit({ kind: 'retried', route, fingerprint: fp });

    const second = await run(this._fingerprint);
    const recheck = detectMismatch(second);
    if (recheck.mismatched) {
      this.stats.epochSurfaced += 1;
      this.emit({ kind: 'surfaced', route, expected: this._fingerprint, server: recheck.server });
      throw errEpochMismatch(this._fingerprint ?? '(unknown)', recheck.server ?? '(unknown)');
    }
    return second;
  }

  /** Refresh fingerprint + manifest exactly once. Returns the new fingerprint. */
  private async refreshEpoch(route: string): Promise<string> {
    this.stats.epochRefreshes += 1;
    const fp = await this.fetchFingerprint();
    await this.fetchManifest();
    this.emit({ kind: 'refreshed', route, fingerprint: fp.fingerprint });
    return fp.fingerprint;
  }

  /* ------------------------------------------------------ introspect routes */

  /** `GET /fingerprint` — always hits the network. */
  async fetchFingerprint(): Promise<FingerprintResponse> {
    const res = await this.request('GET', '/fingerprint');
    const body = res.json as FingerprintResponse | undefined;
    if (!body || typeof body.fingerprint !== 'string') {
      throw new XError(
        'companion_error',
        'GET /fingerprint did not return a {fingerprint, posture, interfaces_version} object.',
        'Confirm the x-companion plugin version implements interfaces.version "1".',
        { route: '/fingerprint' },
      );
    }
    this._fingerprint = body.fingerprint;
    this._posture = body.posture;
    this._interfacesVersion = body.interfaces_version;
    return body;
  }

  /** `GET /manifest` — always hits the network, updates the client-held cache. */
  async fetchManifest(): Promise<Manifest> {
    const res = await this.request('GET', '/manifest');
    const parsed = ManifestSchema.safeParse(res.json);
    if (!parsed.success) {
      throw new XError(
        'companion_error',
        `GET /manifest returned a body that does not match manifest.schema.json: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('/')}: ${i.message}`)
          .join('; ')}`,
        'The instance is running an incompatible x-companion build.',
        { route: '/manifest' },
      );
    }
    this._manifest = parsed.data;
    this._manifestFetchedAt = Date.now();
    this._fingerprint = parsed.data.fingerprint;
    this._posture = parsed.data.posture;
    this._interfacesVersion = parsed.data.interfaces_version;
    return parsed.data;
  }

  /** `POST /validate` — epoch-aware; rewrites `tree.epoch` on the single retry. */
  async validate(tree: TreeIR): Promise<Diagnostics> {
    return this.withEpochRetry(
      '/validate',
      async (fingerprint) => {
        const payload: TreeIR = fingerprint ? { ...tree, epoch: fingerprint } : tree;
        const res = await this.request('POST', '/validate', { json: payload });
        const parsed = DiagnosticsSchema.safeParse(res.json);
        if (!parsed.success) {
          throw new XError(
            'companion_error',
            'POST /validate returned a body that does not match diagnostics.schema.json.',
            'The instance is running an incompatible x-companion build.',
            { route: '/validate' },
          );
        }
        return parsed.data;
      },
      (d) => ({
        mismatched: d.diagnostics.some((x) => x.code === 'E_EPOCH_MISMATCH'),
        server: d.server_fingerprint,
      }),
    );
  }

  /** `POST /parse` */
  async parse(markup: string): Promise<{ blocks: ParsedBlock[] }> {
    const res = await this.request('POST', '/parse', { json: { markup } });
    const body = res.json as { blocks?: ParsedBlock[] } | undefined;
    if (!body || !Array.isArray(body.blocks)) {
      throw new XError('companion_error', 'POST /parse did not return {blocks: [...]}.', 'Check the companion version.', {
        route: '/parse',
      });
    }
    return { blocks: body.blocks };
  }

  /** `POST /render` */
  async render(markup: string): Promise<{ html: string; enqueued_styles: string[] }> {
    const res = await this.request('POST', '/render', { json: { markup } });
    const body = res.json as { html?: string; enqueued_styles?: string[] } | undefined;
    if (!body || typeof body.html !== 'string') {
      throw new XError('companion_error', 'POST /render did not return {html, enqueued_styles}.', 'Check the companion version.', {
        route: '/render',
      });
    }
    return { html: body.html, enqueued_styles: Array.isArray(body.enqueued_styles) ? body.enqueued_styles : [] };
  }

  /** `GET /patterns` */
  async patterns(): Promise<PatternEntry[]> {
    const res = await this.request('GET', '/patterns');
    if (!Array.isArray(res.json)) {
      throw new XError('companion_error', 'GET /patterns did not return an array.', 'Check the companion version.', {
        route: '/patterns',
      });
    }
    return res.json as PatternEntry[];
  }

  /** `GET /harness` — raw HTML. Playwright normally navigates instead. */
  async harnessHtml(): Promise<{ html: string; degraded: string | null }> {
    const res = await this.request('GET', '/harness', { accept: 'text/html' });
    return { html: res.text, degraded: res.headers.get('X-Harness-Degraded') };
  }

  /* ---------------------------------------------------------- extend routes */

  private assertToolchain(route: string): void {
    if (this._posture === 'production') throw errPostureForbidden(route);
  }

  /** `POST /blocks/install` — raw multipart/form-data, field `package`. */
  async installBlockFromFile(zipPath: string): Promise<InstallResult> {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(zipPath);
    } catch (e) {
      throw new XError('invalid_input', `Cannot read package zip at ${zipPath}: ${(e as Error).message}`, 'Pass a path produced by wp_block_build_test.');
    }
    return this.installBlockBytes(path.basename(zipPath), bytes);
  }

  /** `POST /blocks/install` — raw multipart POST from an in-memory buffer. */
  async installBlockBytes(filename: string, bytes: Uint8Array): Promise<InstallResult> {
    this.assertToolchain('/blocks/install');
    const boundary = `----xagent${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="package"; filename="${filename.replace(/"/g, '')}"\r\n` +
        `Content-Type: application/zip\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, Buffer.from(bytes), tail]);

    const res = await this.request('POST', '/blocks/install', {
      body: new Uint8Array(body),
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
    });
    const parsed = res.json as InstallResult | undefined;
    if (!parsed || typeof parsed.fingerprint !== 'string') {
      throw new XError('companion_error', 'POST /blocks/install did not return {installed, fingerprint, replaced_previous}.', 'Check the companion version.', {
        route: '/blocks/install',
      });
    }
    this._fingerprint = parsed.fingerprint;
    this._manifest = undefined;
    return parsed;
  }

  /** `GET /blocks/library` */
  async blocksLibrary(): Promise<LibraryEntry[]> {
    this.assertToolchain('/blocks/library');
    const res = await this.request('GET', '/blocks/library');
    return (Array.isArray(res.json) ? res.json : []) as LibraryEntry[];
  }

  /** `POST /blocks/library/{slug}/rollback` */
  async rollbackBlock(slug: string): Promise<{ fingerprint: string }> {
    this.assertToolchain('/blocks/library/{slug}/rollback');
    const res = await this.request('POST', `/blocks/library/${encodeURIComponent(slug)}/rollback`);
    const body = res.json as { fingerprint: string };
    this._fingerprint = body?.fingerprint ?? this._fingerprint;
    this._manifest = undefined;
    return body;
  }

  /** `DELETE /blocks/library/{slug}` */
  async deleteBlock(slug: string): Promise<{ fingerprint: string }> {
    this.assertToolchain('/blocks/library/{slug}');
    const res = await this.request('DELETE', `/blocks/library/${encodeURIComponent(slug)}`);
    const body = res.json as { fingerprint: string };
    this._fingerprint = body?.fingerprint ?? this._fingerprint;
    this._manifest = undefined;
    return body;
  }

  /** `POST /theme/tokens` */
  async themeTokens(tokens: DesignTokens): Promise<TokensResult> {
    this.assertToolchain('/theme/tokens');
    const res = await this.request('POST', '/theme/tokens', { json: tokens });
    const body = res.json as TokensResult | undefined;
    if (!body || typeof body.fingerprint !== 'string') {
      throw new XError('companion_error', 'POST /theme/tokens did not return {theme_json_written, adapters_applied, fingerprint}.', 'Check the companion version.', {
        route: '/theme/tokens',
      });
    }
    this._fingerprint = body.fingerprint;
    this._manifest = undefined;
    return body;
  }

  /** `POST /snapshot/export` — streams the zip to `destPath`. */
  async snapshotExport(destPath: string): Promise<{ zip_path: string; bytes: number }> {
    this.assertToolchain('/snapshot/export');
    const res = await this.request('POST', '/snapshot/export', { accept: 'application/zip', stream: true });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const chunks: Buffer[] = [];
    if (res.bodyStream) {
      const reader = res.bodyStream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(Buffer.from(value));
      }
    }
    const buf = Buffer.concat(chunks);
    fs.writeFileSync(destPath, buf);
    return { zip_path: destPath, bytes: buf.length };
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Drop every cached epoch/manifest state (wp_disconnect). */
  reset(): void {
    this._fingerprint = undefined;
    this._manifest = undefined;
    this._manifestFetchedAt = 0;
    this._posture = undefined;
    this._interfacesVersion = undefined;
  }
}

/* --------------------------------------------------------- manifest caching */

export interface ManifestGetOptions {
  refresh?: boolean;
  /** Minimum interval between cheap `/fingerprint` freshness probes. */
  fingerprintMinIntervalMs?: number;
  now?: number;
}

/**
 * Serve the cached manifest unless `refresh` is asked for or the cheap
 * `/fingerprint` probe shows the epoch moved. The probe itself is rate-limited
 * to at most once per 10 s so a burst of tool calls costs one HTTP request.
 */
export class ManifestCache {
  static readonly FINGERPRINT_MIN_INTERVAL_MS = 10_000;

  private lastFingerprintCheckAt = 0;
  /** Observable counters for tests. */
  readonly stats = { fingerprintProbes: 0, manifestFetches: 0, cacheHits: 0 };

  constructor(private readonly client: CompanionClient) {}

  get lastProbeAt(): number {
    return this.lastFingerprintCheckAt;
  }

  clear(): void {
    this.lastFingerprintCheckAt = 0;
    this.stats.fingerprintProbes = 0;
    this.stats.manifestFetches = 0;
    this.stats.cacheHits = 0;
  }

  async get(opts: ManifestGetOptions = {}): Promise<Manifest> {
    const now = opts.now ?? Date.now();
    const minInterval = opts.fingerprintMinIntervalMs ?? ManifestCache.FINGERPRINT_MIN_INTERVAL_MS;
    const cached = this.client.cachedManifest;

    if (opts.refresh || !cached) {
      this.stats.manifestFetches += 1;
      this.lastFingerprintCheckAt = now;
      return this.client.fetchManifest();
    }

    if (now - this.lastFingerprintCheckAt >= minInterval) {
      this.lastFingerprintCheckAt = now;
      this.stats.fingerprintProbes += 1;
      const fp = await this.client.fetchFingerprint();
      if (fp.fingerprint !== cached.fingerprint) {
        this.stats.manifestFetches += 1;
        return this.client.fetchManifest();
      }
    }

    this.stats.cacheHits += 1;
    return cached;
  }
}

/* ------------------------------------------------------------------ helpers */

function looksLikeMissingRoute(res: RawResponse): boolean {
  const code = (res.json as { code?: string } | undefined)?.code;
  if (!code) return true; // non-JSON 404 = the site has no /wp-json/ prefix at all
  return code === 'rest_no_route' || code === 'rest_not_found' || code === 'rest_no_route_matched';
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** stderr logger — stdout belongs to the MCP stdio transport. */
export function stderrLogger(enabled = false): Logger {
  const write = (level: string) => (msg: string, meta?: unknown) => {
    if (!enabled && level === 'debug') return;
    const suffix = meta === undefined ? '' : ' ' + redact(JSON.stringify(meta));
    process.stderr.write(`[x-agent ${level}] ${redact(msg)}${suffix}\n`);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
