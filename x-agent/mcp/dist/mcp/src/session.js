import { registerSessionProvider } from './context.js';
import { XError, errInvalidInput } from './errors.js';
/* ------------------------------------------------------------------- flags */
/**
 * EDITOR FALLBACK — detection is always on, the fallback itself is OFF unless
 * `X_AGENT_HARNESS_FALLBACK=1`.
 *
 * When `GET /harness` cannot register a block client-side, CONTRACT.md §6 names
 * one documented escape hatch: load `wp-admin/post-new.php` and inject
 * `harness.js` into the editor iframe, because the real editor loads every
 * block's editor script by construction.
 *
 * It is default-off for a reason you will hit immediately if you turn it on:
 * WordPress core refuses Application Password authentication for non-API
 * requests (`wp_validate_application_password()` bails unless the
 * `application_password_is_api_request` filter says yes). wp-admin therefore
 * 302s to wp-login.php no matter how correct the Basic header is. The fallback
 * consequently needs a real cookie session, which this package will only ever
 * take as a pre-recorded Playwright storage state — never by asking for an
 * account password.
 */
export const FALLBACK_ENV = 'X_AGENT_HARNESS_FALLBACK';
export const STORAGE_STATE_ENV = 'X_AGENT_STORAGE_STATE';
export const HARNESS_GAP_HINT = 'The block is registered on the server but never registered client-side on GET /harness, so its save() is unavailable and any markup produced would be wrong. ' +
    'Fix the block\'s editor_script_handles on the instance, drop the block from the tree, or enable the documented editor-injection fallback with ' +
    'X_AGENT_HARNESS_FALLBACK=1 (it additionally needs a logged-in browser profile in X_AGENT_STORAGE_STATE — see x-agent/tests/live/README.md).';
export function fallbackEnabled(env = process.env) {
    return env[FALLBACK_ENV] === '1' || env[FALLBACK_ENV] === 'true';
}
/* --------------------------------------------------------------- the session */
export class HarnessSession {
    stats = { browser_launches: 0, harness_loads: 0, compiles: 0, reloads: 0, warm_compile_ms: [] };
    ctx;
    browser;
    context;
    harness;
    measure;
    loadedFingerprint;
    loadedUrl;
    registryCache;
    clientCapture;
    pageErrors = [];
    degradedHeader = null;
    usedEditorFallback = false;
    closing = false;
    constructor(ctx) {
        this.ctx = ctx;
    }
    /** Adopt the newest Ctx (same connection identity) without re-launching. */
    adopt(ctx) {
        this.ctx = ctx;
    }
    get harnessLoaded() {
        return this.harness !== undefined && !this.harness.isClosed();
    }
    get fingerprint() {
        return this.loadedFingerprint;
    }
    get harnessDegraded() {
        return this.degradedHeader;
    }
    get viaEditorFallback() {
        return this.usedEditorFallback;
    }
    /**
     * The live harness Page. Exposed so a test can reach into the page and do
     * things only the page can do — notably `wp.blocks.unregisterBlockType`, which
     * is the only honest way to manufacture a registry gap.
     */
    get harnessPageHandle() {
        return this.harnessLoaded ? this.harness : undefined;
    }
    /** Drop the memoised `window.__registry()` result. */
    invalidateRegistry() {
        this.registryCache = undefined;
        this.clientCapture = undefined;
    }
    /* ----------------------------------------------------------- the browser */
    async ensureBrowser() {
        if (this.browser && this.browser.isConnected())
            return this.browser;
        const t0 = Date.now();
        let chromium;
        try {
            ({ chromium } = await import('playwright'));
        }
        catch (e) {
            throw new XError('internal', `Playwright is not importable from this package: ${e.message}`, 'Run `npm install` in x-agent/mcp, then `npx playwright install chromium`.');
        }
        try {
            this.browser = await chromium.launch({ headless: true });
        }
        catch (e) {
            throw new XError('internal', `Could not launch headless chromium: ${e.message}`, 'Run `npx playwright install chromium` from x-agent/mcp — the bundled Playwright pins a browser build that must be downloaded once.');
        }
        this.stats.browser_launches += 1;
        this.ctx.logger.debug(`chromium launched in ${Date.now() - t0}ms`);
        return this.browser;
    }
    /**
     * The authenticated browser context. Basic auth is set BOTH as
     * `httpCredentials` and as an explicit `Authorization` header, because
     * `httpCredentials` alone does not authenticate a page navigation against
     * WordPress: Chromium only replays Basic credentials after a 401 carrying
     * `WWW-Authenticate`, and WP's `rest_forbidden` 401 does not carry one.
     * Measured, not guessed. (proof/lib/env.mjs documents the same finding.)
     */
    async ensureContext() {
        if (this.context)
            return this.context;
        const browser = await this.ensureBrowser();
        const { username, password } = this.ctx.companion.basicCredentials();
        const storageState = process.env[STORAGE_STATE_ENV];
        this.context = await browser.newContext({
            httpCredentials: { username, password, origin: this.ctx.companion.siteUrl, send: 'always' },
            extraHTTPHeaders: { Authorization: this.ctx.companion.authHeader() },
            ignoreHTTPSErrors: true,
            ...(storageState ? { storageState } : {}),
        });
        this.context.setDefaultTimeout(45_000);
        return this.context;
    }
    /**
     * A page for measuring or screenshotting. Warm by default: the same page is
     * reused and merely resized, which is what makes wp_verify cheap in a loop.
     */
    async page(opts = {}) {
        const context = await this.ensureContext();
        const viewport = opts.viewport ?? { width: 1440, height: 900 };
        if (opts.fresh) {
            const p = await context.newPage();
            await p.setViewportSize(viewport);
            return p;
        }
        if (!this.measure || this.measure.isClosed()) {
            this.measure = await context.newPage();
        }
        await this.measure.setViewportSize(viewport);
        return this.measure;
    }
    /* ---------------------------------------------------------- harness page */
    /** Load (or re-use) GET /harness and wait for `window.__ready`. */
    async ensureHarness() {
        const expected = this.ctx.companion.expectedFingerprint;
        if (this.harnessLoaded && (!expected || !this.loadedFingerprint || expected === this.loadedFingerprint)) {
            return this.harness;
        }
        if (this.harnessLoaded && expected && expected !== this.loadedFingerprint) {
            return this.reload(expected);
        }
        return this.loadHarness();
    }
    async loadHarness() {
        const context = await this.ensureContext();
        if (!this.harness || this.harness.isClosed()) {
            this.harness = await context.newPage();
            this.pageErrors = [];
            this.harness.on('pageerror', (e) => this.pageErrors.push(`pageerror: ${e.message}`));
            this.harness.on('console', (m) => {
                if (m.type() === 'error')
                    this.pageErrors.push(`console.error: ${m.text()}`);
            });
        }
        this.pageErrors.length = 0;
        const candidates = [this.ctx.companion.harnessUrl(), this.ctx.companion.harnessUrlAlternate()];
        let lastStatus = 0;
        let lastBody = '';
        let target;
        for (const url of candidates) {
            const res = await this.harness.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => {
                throw new XError('companion_unreachable', `Could not navigate to the harness page (${url}): ${e.message}`, 'Check the site URL and that the machine can reach the instance.');
            });
            lastStatus = res ? res.status() : 0;
            if (res && res.ok()) {
                target = url;
                this.degradedHeader = res.headers()['x-harness-degraded'] ?? null;
                break;
            }
            lastBody = res ? (await res.text().catch(() => '')).slice(0, 400) : '';
        }
        if (!target) {
            const parsed = safeJson(lastBody);
            const wpCode = parsed?.code ?? `http_${lastStatus}`;
            const detail = parsed?.message ?? lastBody;
            if (lastStatus === 501 || wpCode === 'not_implemented') {
                throw new XError('companion_error', `GET /harness answered HTTP 501 ${wpCode}: ${detail}`, 'The connected x-companion build registers the harness route but does not implement it yet (CONTRACT.md §6). wp_compile cannot work until it does; wp_render, wp_validate and wp_verify still can.', { status: lastStatus, wp_code: wpCode, route: '/harness' });
            }
            throw new XError('companion_error', `GET /harness failed (HTTP ${lastStatus} ${wpCode}): ${detail}`, 'Confirm the x-companion plugin is active and the user holds x_companion_read.', { status: lastStatus, wp_code: wpCode, route: '/harness' });
        }
        await this.awaitReady(this.harness, target);
        this.loadedUrl = target;
        this.loadedFingerprint = this.ctx.companion.expectedFingerprint;
        this.registryCache = undefined;
        this.clientCapture = undefined;
        this.usedEditorFallback = false;
        this.stats.harness_loads += 1;
        this.ctx.logger.debug(`harness loaded at epoch ${this.loadedFingerprint ?? '(unknown)'} (${target})`);
        return this.harness;
    }
    async awaitReady(page, target) {
        try {
            await page.waitForFunction(() => typeof window.__ready !== 'undefined', undefined, { timeout: 60_000 });
            await page.evaluate(() => window.__ready);
        }
        catch (e) {
            throw new XError('companion_error', `window.__ready never resolved on ${target}: ${e.message}`, `The harness page loaded but harness.js did not finish booting. Page errors: ${this.pageErrors.join(' | ') || '(none)'}`, { route: '/harness', page_errors: this.pageErrors.slice(0, 10) });
        }
        const version = await page.evaluate(() => window.__version ?? null);
        if (version !== null && version !== '1') {
            throw new XError('companion_error', `The harness page reports window.__version = ${JSON.stringify(version)}; this client speaks interfaces version "1".`, 'Upgrade or downgrade the x-companion plugin so both sides are on interfaces version 1.', { route: '/harness', harness_version: version });
        }
    }
    /** Re-navigate the harness onto a new epoch. Wired to `onEpochChange`. */
    async reload(fingerprint) {
        this.stats.reloads += 1;
        this.registryCache = undefined;
        this.clientCapture = undefined;
        this.ctx.logger.info(`epoch moved (${(this.loadedFingerprint ?? '(none)').slice(0, 12)} -> ${(fingerprint ?? '(unknown)').slice(0, 12)}); reloading the harness page`);
        const page = await this.loadHarness();
        if (fingerprint)
            this.loadedFingerprint = fingerprint;
        return page;
    }
    /* -------------------------------------------------------------- registry */
    /** `window.__registry()` — the block names that actually exist client-side. */
    async registry(opts = {}) {
        if (!opts.refresh && this.registryCache)
            return this.registryCache;
        const page = await this.ensureHarness();
        const names = await page.evaluate(() => {
            const w = window;
            return typeof w.__registry === 'function' ? w.__registry() : null;
        });
        if (!Array.isArray(names)) {
            throw new XError('companion_error', 'The harness page does not expose window.__registry().', 'CONTRACT.md §6 requires harness.js to expose __version, __ready, __registry and __compile. The instance is running an incompatible build.', { route: '/harness' });
        }
        this.registryCache = names;
        return names;
    }
    /** manifest.blocks keys that never registered client-side. */
    async registryGaps(manifestBlockNames) {
        const present = new Set(await this.registry());
        return manifestBlockNames.filter((n) => !present.has(n)).sort();
    }
    /* -------------------------------------------------- client registry capture */
    /**
     * Capture client-registered block variations and styles from the harness
     * page — the registrations that only exist in editor JavaScript
     * (registerBlockVariation / registerBlockStyle) and are therefore invisible
     * to the server manifest. Cached per fingerprint: the second call at the
     * same epoch performs zero harness navigations.
     */
    async captureClient(opts = {}) {
        const expected = this.ctx.companion.expectedFingerprint;
        if (!opts.refresh &&
            this.clientCapture &&
            (!expected || this.clientCapture.fingerprint === expected)) {
            return { capture: this.clientCapture, from_cache: true };
        }
        const page = await this.ensureHarness();
        const raw = await page.evaluate(() => {
            const w = window;
            const wp = w.wp;
            if (!wp || !wp.blocks)
                return { variations: {}, styles: {} };
            const plain = (v) => {
                try {
                    return JSON.parse(JSON.stringify(v));
                }
                catch {
                    return undefined;
                }
            };
            const names = typeof w.__registry === 'function'
                ? w.__registry()
                : wp.blocks.getBlockTypes().map((t) => t.name);
            const variations = {};
            const styles = {};
            for (const name of names) {
                let vars = [];
                try {
                    if (typeof wp.blocks.getBlockVariations === 'function') {
                        vars = wp.blocks.getBlockVariations(name) ?? [];
                    }
                    else if (wp.data && typeof wp.data.select === 'function') {
                        vars = wp.data.select('core/blocks')?.getBlockVariations?.(name) ?? [];
                    }
                }
                catch {
                    vars = [];
                }
                const trimmedVars = vars
                    .filter((v) => v && typeof v.name === 'string')
                    .map((v) => {
                    const entry = { name: v.name, title: typeof v.title === 'string' ? v.title : v.name };
                    if (typeof v.description === 'string' && v.description)
                        entry.description = v.description;
                    if (Array.isArray(v.scope))
                        entry.scope = v.scope.map(String);
                    if (v.isDefault === true)
                        entry.isDefault = true;
                    const attrs = plain(v.attributes);
                    if (attrs && typeof attrs === 'object' && !Array.isArray(attrs))
                        entry.attributes = attrs;
                    const inner = plain(v.innerBlocks);
                    if (Array.isArray(inner))
                        entry.innerBlocks = inner;
                    return entry;
                });
                if (trimmedVars.length)
                    variations[name] = trimmedVars;
                let sts = [];
                try {
                    if (wp.data && typeof wp.data.select === 'function') {
                        sts = wp.data.select('core/blocks')?.getBlockStyles?.(name) ?? [];
                    }
                }
                catch {
                    sts = [];
                }
                const trimmedStyles = sts
                    .filter((s) => s && typeof s.name === 'string')
                    .map((s) => ({ name: s.name, label: typeof s.label === 'string' ? s.label : s.name }));
                if (trimmedStyles.length)
                    styles[name] = trimmedStyles;
            }
            return { variations, styles };
        });
        const capture = {
            fingerprint: expected ?? this.loadedFingerprint ?? '',
            variations: (raw?.variations ?? {}),
            styles: (raw?.styles ?? {}),
        };
        this.clientCapture = capture;
        return { capture, from_cache: false };
    }
    /* --------------------------------------------------------------- compile */
    /**
     * Compile `blocks` — **the array**, not the TreeIR envelope (CONTRACT.md §6).
     */
    async compile(blocks) {
        const started = Date.now();
        const cold = !this.harnessLoaded;
        const pageStart = Date.now();
        const page = await this.ensureHarness();
        const pageMs = Date.now() - pageStart;
        const manifest = await this.ctx.manifestCache.get();
        const manifestNames = Object.keys(manifest.blocks);
        const registry = new Set(await this.registry());
        const gaps = manifestNames.filter((n) => !registry.has(n)).sort();
        const used = collectBlockNames(blocks);
        const gapSet = new Set(gaps);
        const blockedByGap = used.filter((n) => gapSet.has(n));
        if (blockedByGap.length > 0) {
            throw new XError('harness_gap', `The tree uses ${blockedByGap.length === 1 ? 'a block that is' : 'blocks that are'} in the instance manifest but missing from the harness page's client-side registry: ${blockedByGap.join(', ')}.`, HARNESS_GAP_HINT, { blocks: blockedByGap, registry_gaps: gaps, fallback_flag: FALLBACK_ENV });
        }
        const manifestSet = new Set(manifestNames);
        const unknown = used.filter((n) => !manifestSet.has(n) && !registry.has(n));
        if (unknown.length > 0) {
            throw errInvalidInput(`The tree uses ${unknown.length === 1 ? 'a block' : 'blocks'} the instance does not have at all: ${unknown.join(', ')}.`, 'Run wp_validate first — an unknown block is E_UNKNOWN_BLOCK, not a harness problem. Use wp_manifest to see the real vocabulary at this epoch.', { blocks: unknown });
        }
        const compileStart = Date.now();
        let raw;
        try {
            raw = await page.evaluate((payload) => {
                const w = window;
                if (typeof w.__compile !== 'function')
                    return { error: 'window.__compile is not a function' };
                return w.__compile(payload);
            }, blocks);
        }
        catch (e) {
            throw new XError('internal', `window.__compile threw out of the page context: ${e.message}`, `Page errors: ${this.pageErrors.join(' | ') || '(none)'}. Re-run with X_AGENT_DEBUG=1.`, { page_errors: this.pageErrors.slice(0, 10) });
        }
        const compileMs = Date.now() - compileStart;
        if (raw && typeof raw.error === 'string') {
            throw new XError('internal', `The harness compiler refused the tree: ${raw.error}`, 'window.__compile wraps everything in try/catch and returns {error}. The message above comes from wp.blocks.createBlock/serialize — usually a malformed attribute value.', { harness_error: raw.error });
        }
        if (!raw || typeof raw.markup !== 'string' || typeof raw.all_valid !== 'boolean') {
            throw new XError('companion_error', 'window.__compile did not return {markup, all_valid, invalid} as CONTRACT.md §6 requires.', 'The instance is running an incompatible harness.js.', { route: '/harness', got: JSON.stringify(raw).slice(0, 300) });
        }
        this.stats.compiles += 1;
        const total = Date.now() - started;
        if (cold)
            this.stats.cold_compile_ms = total;
        else
            this.stats.warm_compile_ms.push(total);
        return {
            markup: raw.markup,
            all_valid: raw.all_valid,
            invalid: Array.isArray(raw.invalid) ? raw.invalid : [],
            registry_gaps: gaps,
            epoch: this.ctx.companion.expectedFingerprint ?? manifest.fingerprint,
            timing: { total_ms: total, page_ms: pageMs, compile_ms: compileMs, cold },
        };
    }
    /* ----------------------------------------------------------------- parse */
    /**
     * Parse serialized markup with the EDITOR'S OWN `wp.blocks.parse` on the
     * harness page. Unlike PHP `parse_blocks` (the companion /parse route), the
     * client parser extracts SOURCED attributes — image url/alt, paragraph
     * content — out of the HTML, so `parseMarkup` → mutate → `compile` is the
     * editor's exact load/save cycle and loses nothing. This is the only correct
     * way to lift a page you intend to recompile.
     */
    async parseMarkup(markup) {
        const page = await this.ensureHarness();
        let raw;
        try {
            raw = await page.evaluate((text) => {
                const w = window;
                if (typeof w.wp?.blocks?.parse !== 'function')
                    return { error: 'wp.blocks.parse is not available on the harness page' };
                let dropped = 0;
                const strip = (nodes) => {
                    const out = [];
                    for (const n of nodes ?? []) {
                        if (!n || typeof n.name !== 'string' || n.name === '' || n.name === 'core/freeform' || n.name === 'core/missing') {
                            dropped += 1;
                            continue;
                        }
                        const node = { name: n.name };
                        const attrs = n.attributes ?? {};
                        if (attrs && typeof attrs === 'object' && Object.keys(attrs).length > 0)
                            node.attributes = attrs;
                        const inner = strip(Array.isArray(n.innerBlocks) ? n.innerBlocks : []);
                        if (inner.length)
                            node.innerBlocks = inner;
                        out.push(node);
                    }
                    return out;
                };
                try {
                    return { blocks: strip(w.wp.blocks.parse(text)), dropped };
                }
                catch (e) {
                    return { error: e.message };
                }
            }, markup);
        }
        catch (e) {
            throw new XError('internal', `wp.blocks.parse threw out of the page context: ${e.message}`, `Page errors: ${this.pageErrors.join(' | ') || '(none)'}. Re-run with X_AGENT_DEBUG=1.`, { page_errors: this.pageErrors.slice(0, 10) });
        }
        if (raw && typeof raw.error === 'string') {
            throw new XError('internal', `The harness page could not parse the markup: ${raw.error}`, 'The instance is running an incompatible harness.js.', {
                harness_error: raw.error,
            });
        }
        return { blocks: (raw.blocks ?? []), dropped: Number(raw.dropped ?? 0) };
    }
    /* ------------------------------------------------ editor-injection fallback */
    /**
     * The documented fallback (CONTRACT.md §6), DEFAULT OFF. Loads
     * `wp-admin/post-new.php`, waits for the block-editor iframe, and installs the
     * §6 `window.__*` API inside it.
     *
     * Refuses loudly rather than silently, because it cannot work on Application
     * Password credentials alone — see the FALLBACK_ENV comment above.
     */
    async loadEditorFallback() {
        if (!fallbackEnabled()) {
            throw new XError('harness_gap', 'The editor-injection fallback is disabled.', `Set ${FALLBACK_ENV}=1 to enable it, and ${STORAGE_STATE_ENV}=/path/to/storage-state.json to give it a logged-in wp-admin cookie session. See x-agent/tests/live/README.md.`, { fallback_flag: FALLBACK_ENV });
        }
        const context = await this.ensureContext();
        const page = await context.newPage();
        const url = `${this.ctx.companion.siteUrl}/wp-admin/post-new.php`;
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        const landed = page.url();
        if (!res || !res.ok() || /wp-login\.php/.test(landed)) {
            await page.close();
            throw new XError('harness_gap', `The editor-injection fallback could not open ${url} (status ${res ? res.status() : 'none'}, landed on ${landed}).`, `wp-admin does not accept Application Password Basic auth: WordPress core's wp_validate_application_password() bails unless application_password_is_api_request is true. Record a logged-in Playwright storage state and point ${STORAGE_STATE_ENV} at it, or fix the block's editor_script_handles so GET /harness registers it.`, { url, status: res ? res.status() : 0, landed });
        }
        const frame = await page.waitForSelector('iframe[name="editor-canvas"]', { timeout: 60_000 }).catch(() => null);
        const target = frame ? await frame.contentFrame() : null;
        const scope = target ?? page.mainFrame();
        // Install the CONTRACT.md §6 surface on top of the editor's own wp.blocks.
        await scope.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; };').catch(() => { });
        await scope.evaluate(() => {
            const w = window;
            if (!w.wp || !w.wp.blocks)
                throw new Error('wp.blocks is not present in the editor frame');
            w.__version = '1';
            w.__ready = Promise.resolve();
            w.__registry = () => w.wp.blocks.getBlockTypes().map((t) => t.name);
            w.__compile = (blocks) => {
                try {
                    const build = (node) => w.wp.blocks.createBlock(node.name, node.attributes ?? {}, (node.innerBlocks ?? []).map(build));
                    const built = blocks.map(build);
                    const markup = w.wp.blocks.serialize(built);
                    const invalid = [];
                    const walk = (list, base) => {
                        list.forEach((b, i) => {
                            const path = `${base}/${i}`;
                            if (b.isValid === false)
                                invalid.push({ path, name: b.name, validation_issues: b.validationIssues ?? null });
                            if (b.innerBlocks && b.innerBlocks.length)
                                walk(b.innerBlocks, `${path}/innerBlocks`);
                        });
                    };
                    walk(w.wp.blocks.parse(markup), '');
                    return { markup, all_valid: invalid.length === 0, invalid };
                }
                catch (e) {
                    return { error: e.message };
                }
            };
        });
        if (this.harness && !this.harness.isClosed())
            await this.harness.close().catch(() => { });
        this.harness = page;
        this.usedEditorFallback = true;
        this.registryCache = undefined;
        this.clientCapture = undefined;
        this.loadedFingerprint = this.ctx.companion.expectedFingerprint;
        this.loadedUrl = url;
        this.stats.harness_loads += 1;
        return page;
    }
    /* ------------------------------------------------------------- lifecycle */
    async close() {
        if (this.closing)
            return;
        this.closing = true;
        for (const p of [this.harness, this.measure]) {
            if (p && !p.isClosed())
                await p.close().catch(() => { });
        }
        this.harness = undefined;
        this.measure = undefined;
        if (this.context)
            await this.context.close().catch(() => { });
        this.context = undefined;
        if (this.browser)
            await this.browser.close().catch(() => { });
        this.browser = undefined;
        this.loadedFingerprint = undefined;
        this.loadedUrl = undefined;
        this.registryCache = undefined;
        this.clientCapture = undefined;
        this.closing = false;
    }
    /** Diagnostics for tests and the progress fragment. */
    describe() {
        return {
            browser_open: Boolean(this.browser?.isConnected()),
            harness_loaded: this.harnessLoaded,
            harness_url: this.loadedUrl ?? null,
            epoch: this.loadedFingerprint ?? null,
            degraded: this.degradedHeader,
            via_editor_fallback: this.usedEditorFallback,
            stats: this.stats,
        };
    }
}
/* ------------------------------------------------------------------ helpers */
/** Every distinct block name in the tree, depth-first. */
export function collectBlockNames(blocks) {
    const seen = new Set();
    const walk = (list) => {
        for (const b of list) {
            if (b && typeof b.name === 'string')
                seen.add(b.name);
            if (b && Array.isArray(b.innerBlocks))
                walk(b.innerBlocks);
        }
    };
    walk(blocks);
    return [...seen].sort();
}
function safeJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/* ------------------------------------------------- provider registration */
registerSessionProvider({
    create: (ctx) => new HarnessSession(ctx),
    dispose: async (s) => {
        await s.close();
    },
    onEpochChange: async (s, fingerprint) => {
        const session = s;
        // Only a loaded harness needs re-navigating; a browser that has never
        // opened the harness will pick the new epoch up on first use.
        if (session.harnessLoaded)
            await session.reload(fingerprint);
    },
});
/**
 * Resolve the warm session for a tool call. Also re-points it at the current
 * Ctx so a later `wp_connect` with the same identity does not strand it on a
 * stale logger/companion.
 */
export async function sessionFor(ctx) {
    const s = (await ctx.runtime.getSession(ctx));
    if (!s) {
        throw new XError('internal', 'No session provider is registered.', 'src/session.ts must be imported before the first wp_compile/wp_verify/wp_screenshot call; the registry loads it via src/tools/{compile,verify,screenshot}.ts.');
    }
    s.adopt(ctx);
    return s;
}
//# sourceMappingURL=session.js.map