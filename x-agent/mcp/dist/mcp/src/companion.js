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
import { DiagnosticsSchema, ManifestSchema, } from './schemas.js';
export const NAMESPACE = 'x-companion/v1';
const EPOCH_CONFLICT_CODES = new Set(['epoch_mismatch', 'rest_epoch_mismatch', 'x_companion_epoch_mismatch']);
export class CompanionClient {
    config;
    stats = { requests: 0, epochRefreshes: 0, epochRetries: 0, epochSurfaced: 0 };
    fetchImpl;
    logger;
    onEpochEvent;
    urlForm;
    _fingerprint;
    _posture;
    _interfacesVersion;
    _manifest;
    _manifestFetchedAt = 0;
    constructor(opts) {
        this.config = opts.config;
        this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
        this.logger = opts.logger ?? silentLogger;
        if (opts.onEpochEvent)
            this.onEpochEvent = opts.onEpochEvent;
        this.urlForm = opts.urlForm ?? 'unknown';
    }
    /* --------------------------------------------------------------- getters */
    get siteUrl() {
        return this.config.site_url;
    }
    get expectedFingerprint() {
        return this._fingerprint;
    }
    get posture() {
        return this._posture;
    }
    get interfacesVersion() {
        return this._interfacesVersion;
    }
    get cachedManifest() {
        return this._manifest;
    }
    get manifestFetchedAt() {
        return this._manifestFetchedAt;
    }
    get resolvedUrlForm() {
        return this.urlForm;
    }
    /** Credentials for Playwright `httpCredentials` — never logged. */
    basicCredentials() {
        return { username: this.config.user, password: this.config.app_password };
    }
    /** `Authorization: Basic ...` value. Never log the return value un-redacted. */
    authHeader() {
        return 'Basic ' + Buffer.from(`${this.config.user}:${this.config.app_password}`, 'utf8').toString('base64');
    }
    /**
     * Absolute URL of `GET /harness`. Basic auth is still required — pass
     * `basicCredentials()` to Playwright's `browser.newContext({httpCredentials})`
     * or set the `Authorization` header via `authHeader()`.
     */
    harnessUrl() {
        return this.buildUrl('/harness', undefined, this.urlForm === 'unknown' ? 'pretty' : this.urlForm);
    }
    /** Alternate harness URL for the other permalink form (probe fallback). */
    harnessUrlAlternate() {
        const other = this.urlForm === 'plain' ? 'pretty' : 'plain';
        return this.buildUrl('/harness', undefined, other);
    }
    /* ------------------------------------------------------------------ URLs */
    buildUrl(routePath, query, form) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query ?? {}))
            if (v !== undefined)
                qs.set(k, v);
        if (form === 'pretty') {
            const base = `${this.config.site_url}/wp-json/${NAMESPACE}${routePath}`;
            const s = qs.toString();
            return s ? `${base}?${s}` : base;
        }
        const rest = new URLSearchParams();
        rest.set('rest_route', `/${NAMESPACE}${routePath}`);
        for (const [k, v] of qs)
            rest.append(k, v);
        return `${this.config.site_url}/?${rest.toString()}`;
    }
    /* -------------------------------------------------------------- requests */
    async raw(method, routePath, opts, form) {
        const url = this.buildUrl(routePath, opts.query, form);
        const headers = {
            Authorization: this.authHeader(),
            Accept: opts.accept ?? 'application/json',
            'User-Agent': 'x-agent-mcp/0.1',
            ...(opts.headers ?? {}),
        };
        if (this._fingerprint)
            headers['X-Expected-Fingerprint'] = this._fingerprint;
        let body = opts.body;
        if (opts.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(opts.json);
        }
        this.stats.requests += 1;
        this.logger.debug(`companion ${method} ${redact(url)}`);
        let res;
        try {
            res = await this.fetchImpl(url, { method, headers, body });
        }
        catch (e) {
            throw new XError('companion_unreachable', `Could not reach ${redact(this.config.site_url)}: ${redact(e.message)}`, 'Check the site URL, that the machine is online, and that the x-companion plugin is active.', { site_url: this.config.site_url });
        }
        if (opts.stream) {
            return { status: res.status, ok: res.ok, headers: res.headers, text: '', bodyStream: res.body };
        }
        const text = await res.text();
        let json;
        if (text) {
            try {
                json = JSON.parse(text);
            }
            catch {
                json = undefined;
            }
        }
        return { status: res.status, ok: res.ok, headers: res.headers, text, json };
    }
    /** Probe-aware request. Throws structured XError on any non-2xx. */
    async request(method, routePath, opts = {}) {
        const firstForm = this.urlForm === 'plain' ? 'plain' : 'pretty';
        let res = await this.raw(method, routePath, opts, firstForm);
        if (res.status === 404 && this.urlForm === 'unknown' && looksLikeMissingRoute(res)) {
            this.logger.debug('pretty permalinks unavailable, falling back to ?rest_route=');
            res = await this.raw(method, routePath, opts, 'plain');
            if (res.status !== 404)
                this.urlForm = 'plain';
        }
        else if (res.ok && this.urlForm === 'unknown') {
            this.urlForm = firstForm;
        }
        if (!res.ok)
            throw this.toError(res, routePath);
        return res;
    }
    toError(res, routePath) {
        const body = (res.json ?? {});
        const wpCode = body.code ?? `http_${res.status}`;
        const message = body.message ?? res.text.slice(0, 400) ?? `HTTP ${res.status}`;
        const extraData = body.data && typeof body.data === 'object' ? { ...body.data } : {};
        if (wpCode === 'posture_forbidden')
            return errPostureForbidden(routePath);
        if (res.status === 401 || wpCode === 'rest_forbidden') {
            return new XError('companion_error', `Authentication rejected by ${redact(this.config.site_url)}: ${redact(message)}`, 'Check X_WP_USER and the WordPress Application Password. The password must be an Application Password, not the account password.', { status: res.status, wp_code: wpCode, route: routePath });
        }
        if (wpCode === 'rest_forbidden_capability') {
            return new XError('companion_error', `The user lacks the capability for ${routePath}: ${redact(message)}`, 'Grant the x_companion_read / x_companion_extend capability to this WordPress user.', { status: res.status, wp_code: wpCode, route: routePath });
        }
        return new XError('companion_error', `${routePath} failed (HTTP ${res.status} ${wpCode}): ${redact(message)}`, 'Inspect the WordPress error log on the instance; the companion returned a WP_Error.', { status: res.status, wp_code: wpCode, route: routePath, ...extraData });
    }
    isEpochConflict(e) {
        if (!(e instanceof XError))
            return false;
        if (e.code !== 'companion_error')
            return false;
        const status = e.extra.status;
        const wpCode = String(e.extra.wp_code ?? '');
        return status === 409 && (EPOCH_CONFLICT_CODES.has(wpCode) || /epoch/i.test(wpCode));
    }
    emit(e) {
        this.onEpochEvent?.(e);
    }
    /**
     * The one and only epoch retry loop. `run` is executed with the current
     * expected fingerprint; if `detectMismatch` says the result is an epoch
     * mismatch (or the call threw a 409 epoch conflict) the manifest is refreshed
     * ONCE and `run` executed ONCE more. A second mismatch surfaces
     * `epoch_mismatch`. Never more than two attempts.
     */
    async withEpochRetry(route, run, detectMismatch) {
        let first;
        try {
            first = await run(this._fingerprint);
        }
        catch (e) {
            if (!this.isEpochConflict(e))
                throw e;
            this.emit({ kind: 'detected', route, expected: this._fingerprint, server: undefined });
            const fp = await this.refreshEpoch(route);
            this.stats.epochRetries += 1;
            this.emit({ kind: 'retried', route, fingerprint: fp });
            try {
                return await run(this._fingerprint);
            }
            catch (e2) {
                if (this.isEpochConflict(e2)) {
                    this.stats.epochSurfaced += 1;
                    this.emit({ kind: 'surfaced', route, expected: this._fingerprint, server: undefined });
                    throw errEpochMismatch(this._fingerprint ?? '(unknown)', String(e2.extra.server_fingerprint ?? 'unknown'));
                }
                throw e2;
            }
        }
        const check = detectMismatch(first);
        if (!check.mismatched)
            return first;
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
    async refreshEpoch(route) {
        this.stats.epochRefreshes += 1;
        const fp = await this.fetchFingerprint();
        await this.fetchManifest();
        this.emit({ kind: 'refreshed', route, fingerprint: fp.fingerprint });
        return fp.fingerprint;
    }
    /* ------------------------------------------------------ introspect routes */
    /** `GET /fingerprint` — always hits the network. */
    async fetchFingerprint() {
        const res = await this.request('GET', '/fingerprint');
        const body = res.json;
        if (!body || typeof body.fingerprint !== 'string') {
            throw new XError('companion_error', 'GET /fingerprint did not return a {fingerprint, posture, interfaces_version} object.', 'Confirm the x-companion plugin version implements interfaces.version "1".', { route: '/fingerprint' });
        }
        this._fingerprint = body.fingerprint;
        this._posture = body.posture;
        this._interfacesVersion = body.interfaces_version;
        return body;
    }
    /** `GET /manifest` — always hits the network, updates the client-held cache. */
    async fetchManifest() {
        const res = await this.request('GET', '/manifest');
        const parsed = ManifestSchema.safeParse(res.json);
        if (!parsed.success) {
            throw new XError('companion_error', `GET /manifest returned a body that does not match manifest.schema.json: ${parsed.error.issues
                .slice(0, 3)
                .map((i) => `${i.path.join('/')}: ${i.message}`)
                .join('; ')}`, 'The instance is running an incompatible x-companion build.', { route: '/manifest' });
        }
        this._manifest = parsed.data;
        this._manifestFetchedAt = Date.now();
        this._fingerprint = parsed.data.fingerprint;
        this._posture = parsed.data.posture;
        this._interfacesVersion = parsed.data.interfaces_version;
        return parsed.data;
    }
    /** `POST /validate` — epoch-aware; rewrites `tree.epoch` on the single retry. */
    async validate(tree) {
        return this.withEpochRetry('/validate', async (fingerprint) => {
            const payload = fingerprint ? { ...tree, epoch: fingerprint } : tree;
            const res = await this.request('POST', '/validate', { json: payload });
            const parsed = DiagnosticsSchema.safeParse(res.json);
            if (!parsed.success) {
                throw new XError('companion_error', 'POST /validate returned a body that does not match diagnostics.schema.json.', 'The instance is running an incompatible x-companion build.', { route: '/validate' });
            }
            return parsed.data;
        }, (d) => ({
            mismatched: d.diagnostics.some((x) => x.code === 'E_EPOCH_MISMATCH'),
            server: d.server_fingerprint,
        }));
    }
    /** `POST /parse` */
    async parse(markup) {
        const res = await this.request('POST', '/parse', { json: { markup } });
        const body = res.json;
        if (!body || !Array.isArray(body.blocks)) {
            throw new XError('companion_error', 'POST /parse did not return {blocks: [...]}.', 'Check the companion version.', {
                route: '/parse',
            });
        }
        return { blocks: body.blocks };
    }
    /** `POST /render` */
    async render(markup) {
        const res = await this.request('POST', '/render', { json: { markup } });
        const body = res.json;
        if (!body || typeof body.html !== 'string') {
            throw new XError('companion_error', 'POST /render did not return {html, enqueued_styles}.', 'Check the companion version.', {
                route: '/render',
            });
        }
        return { html: body.html, enqueued_styles: Array.isArray(body.enqueued_styles) ? body.enqueued_styles : [] };
    }
    /** `POST /placeholder` — extend tier; idempotent per colour (and size). */
    async placeholder(color, width, height) {
        const json = { color };
        if (width !== undefined)
            json.width = width;
        if (height !== undefined)
            json.height = height;
        const res = await this.request('POST', '/placeholder', { json });
        const body = res.json;
        if (!body || typeof body.id !== 'number' || typeof body.url !== 'string') {
            throw new XError('companion_error', 'POST /placeholder did not return {id, url, color, slug, reused}.', 'Check the companion version.', {
                route: '/placeholder',
            });
        }
        return {
            id: body.id,
            url: body.url,
            color: String(body.color ?? ''),
            slug: String(body.slug ?? ''),
            reused: Boolean(body.reused),
        };
    }
    /** `POST /patterns` — extend tier; saving moves the epoch. */
    async patternSave(input) {
        const res = await this.request('POST', '/patterns', { json: input });
        const body = res.json;
        if (!body || typeof body.saved !== 'string' || typeof body.fingerprint !== 'string') {
            throw new XError('companion_error', 'POST /patterns did not return {saved, replaced, total, fingerprint}.', 'Check the companion version.', {
                route: '/patterns',
            });
        }
        return { saved: body.saved, replaced: Boolean(body.replaced), total: Number(body.total ?? 0), fingerprint: body.fingerprint };
    }
    /** `GET /patterns` */
    async patterns() {
        const res = await this.request('GET', '/patterns');
        if (!Array.isArray(res.json)) {
            throw new XError('companion_error', 'GET /patterns did not return an array.', 'Check the companion version.', {
                route: '/patterns',
            });
        }
        return res.json;
    }
    /** `GET /harness` — raw HTML. Playwright normally navigates instead. */
    async harnessHtml() {
        const res = await this.request('GET', '/harness', { accept: 'text/html' });
        return { html: res.text, degraded: res.headers.get('X-Harness-Degraded') };
    }
    /* ---------------------------------------------------------- extend routes */
    assertToolchain(route) {
        if (this._posture === 'production')
            throw errPostureForbidden(route);
    }
    /** `POST /blocks/install` — raw multipart/form-data, field `package`. */
    async installBlockFromFile(zipPath) {
        let bytes;
        try {
            bytes = fs.readFileSync(zipPath);
        }
        catch (e) {
            throw new XError('invalid_input', `Cannot read package zip at ${zipPath}: ${e.message}`, 'Pass a path produced by wp_block_build_test.');
        }
        return this.installBlockBytes(path.basename(zipPath), bytes);
    }
    /** `POST /blocks/install` — raw multipart POST from an in-memory buffer. */
    async installBlockBytes(filename, bytes) {
        this.assertToolchain('/blocks/install');
        const boundary = `----xagent${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
        const head = Buffer.from(`--${boundary}\r\n` +
            `Content-Disposition: form-data; name="package"; filename="${filename.replace(/"/g, '')}"\r\n` +
            `Content-Type: application/zip\r\n\r\n`, 'utf8');
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
        const body = Buffer.concat([head, Buffer.from(bytes), tail]);
        const res = await this.request('POST', '/blocks/install', {
            body: new Uint8Array(body),
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
        });
        const parsed = res.json;
        if (!parsed || typeof parsed.fingerprint !== 'string') {
            throw new XError('companion_error', 'POST /blocks/install did not return {installed, fingerprint, replaced_previous}.', 'Check the companion version.', {
                route: '/blocks/install',
            });
        }
        this._fingerprint = parsed.fingerprint;
        this._manifest = undefined;
        return parsed;
    }
    /** `POST /schema/install` — a schema-package zip from disk. */
    async installSchemaFromFile(zipPath) {
        this.assertToolchain('/schema/install');
        let bytes;
        try {
            bytes = fs.readFileSync(zipPath);
        }
        catch (e) {
            throw new XError('invalid_input', `Cannot read package zip at ${zipPath}: ${e.message}`, 'Pass a path produced by wp_schema_build_test.');
        }
        const boundary = `----xagent${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
        const head = Buffer.from(`--${boundary}\r\n` +
            `Content-Disposition: form-data; name="package"; filename="${path.basename(zipPath).replace(/"/g, '')}"\r\n` +
            `Content-Type: application/zip\r\n\r\n`, 'utf8');
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
        const body = Buffer.concat([head, bytes, tail]);
        const res = await this.request('POST', '/schema/install', {
            body: new Uint8Array(body),
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
        });
        const parsed = res.json;
        if (!parsed || typeof parsed.fingerprint !== 'string') {
            throw new XError('companion_error', 'POST /schema/install did not return {installed, fingerprint, replaced_previous}.', 'Check the companion version — /schema/install is interfaces v2.', {
                route: '/schema/install',
            });
        }
        this._fingerprint = parsed.fingerprint;
        this._manifest = undefined;
        return parsed;
    }
    /** `GET /blocks/library` */
    async blocksLibrary() {
        this.assertToolchain('/blocks/library');
        const res = await this.request('GET', '/blocks/library');
        return (Array.isArray(res.json) ? res.json : []);
    }
    /** `POST /blocks/library/{slug}/rollback` */
    async rollbackBlock(slug) {
        this.assertToolchain('/blocks/library/{slug}/rollback');
        const res = await this.request('POST', `/blocks/library/${encodeURIComponent(slug)}/rollback`);
        const body = res.json;
        this._fingerprint = body?.fingerprint ?? this._fingerprint;
        this._manifest = undefined;
        return body;
    }
    /** `DELETE /blocks/library/{slug}` */
    async deleteBlock(slug) {
        this.assertToolchain('/blocks/library/{slug}');
        const res = await this.request('DELETE', `/blocks/library/${encodeURIComponent(slug)}`);
        const body = res.json;
        this._fingerprint = body?.fingerprint ?? this._fingerprint;
        this._manifest = undefined;
        return body;
    }
    /** `POST /theme/tokens` */
    async themeTokens(tokens) {
        this.assertToolchain('/theme/tokens');
        const res = await this.request('POST', '/theme/tokens', { json: tokens });
        const body = res.json;
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
    async snapshotExport(destPath) {
        this.assertToolchain('/snapshot/export');
        const res = await this.request('POST', '/snapshot/export', { accept: 'application/zip', stream: true });
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const chunks = [];
        if (res.bodyStream) {
            const reader = res.bodyStream.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (value)
                    chunks.push(Buffer.from(value));
            }
        }
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(destPath, buf);
        return { zip_path: destPath, bytes: buf.length };
    }
    /* ------------------------------------------------------------- lifecycle */
    /** Drop every cached epoch/manifest state (wp_disconnect). */
    reset() {
        this._fingerprint = undefined;
        this._manifest = undefined;
        this._manifestFetchedAt = 0;
        this._posture = undefined;
        this._interfacesVersion = undefined;
    }
}
/**
 * Serve the cached manifest unless `refresh` is asked for or the cheap
 * `/fingerprint` probe shows the epoch moved. The probe itself is rate-limited
 * to at most once per 10 s so a burst of tool calls costs one HTTP request.
 */
export class ManifestCache {
    client;
    static FINGERPRINT_MIN_INTERVAL_MS = 10_000;
    lastFingerprintCheckAt = 0;
    /** Observable counters for tests. */
    stats = { fingerprintProbes: 0, manifestFetches: 0, cacheHits: 0 };
    constructor(client) {
        this.client = client;
    }
    get lastProbeAt() {
        return this.lastFingerprintCheckAt;
    }
    clear() {
        this.lastFingerprintCheckAt = 0;
        this.stats.fingerprintProbes = 0;
        this.stats.manifestFetches = 0;
        this.stats.cacheHits = 0;
    }
    async get(opts = {}) {
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
function looksLikeMissingRoute(res) {
    const code = res.json?.code;
    if (!code)
        return true; // non-JSON 404 = the site has no /wp-json/ prefix at all
    return code === 'rest_no_route' || code === 'rest_not_found' || code === 'rest_no_route_matched';
}
export const silentLogger = {
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
};
/** stderr logger — stdout belongs to the MCP stdio transport. */
export function stderrLogger(enabled = false) {
    const write = (level) => (msg, meta) => {
        if (!enabled && level === 'debug')
            return;
        const suffix = meta === undefined ? '' : ' ' + redact(JSON.stringify(meta));
        process.stderr.write(`[x-agent ${level}] ${redact(msg)}${suffix}\n`);
    };
    return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
//# sourceMappingURL=companion.js.map