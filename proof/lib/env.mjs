/**
 * proof/lib/env.mjs — reusable environment helpers for the proof suite.
 *
 * Scenarios live elsewhere; this file only provides the plumbing:
 *
 *   import { withInstance, assertStatus, assertEquals } from '../lib/env.mjs';
 *
 *   await withInstance({ profile: 'core-only', posture: 'toolchain', plugins: ['x-companion'] }, async (env) => {
 *     const res = await env.call('GET', '/x-companion/v1/fingerprint');
 *     assertStatus(res, 200, 'fingerprint is reachable');
 *     const page = await env.harnessPage();
 *     const registry = await page.evaluate(() => window.__registry());
 *   });
 *
 * Everything is torn down in a finally block, including the browser, so a
 * throwing scenario never leaves a Playground server behind.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { boot, RUNTIME_DIR, runtimePath } from '../../tools/playground/boot.mjs';
import { createClient, loadRuntime, clientForRuntime } from '../../tools/lib/rest-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const TOOLS_DIR = path.join(REPO_ROOT, 'tools');

/* --------------------------------------------------------------- assertions */

export class AssertionError extends Error {
	constructor(message, detail) {
		super(detail ? `${message}\n${detail}` : message);
		this.name = 'AssertionError';
	}
}

function fmt(v) {
	if (typeof v === 'string') return JSON.stringify(v);
	try {
		return JSON.stringify(v, null, 2);
	} catch {
		return String(v);
	}
}

/** Short, readable rendering of a REST response for failure output. */
export function describeResponse(res) {
	if (!res) return '(no response)';
	const bodyBit = res.json !== null && res.json !== undefined
		? fmt(res.json).slice(0, 1200)
		: (res.text ?? `<${res.buffer?.length ?? 0} binary bytes>`).slice(0, 1200);
	return [
		`  request : ${res.method} ${res.url}`,
		`  status  : ${res.status}`,
		`  body    : ${bodyBit}`,
	].join('\n');
}

export function assert(condition, message, detail) {
	if (!condition) throw new AssertionError(message, detail);
	return true;
}

export function assertEquals(actual, expected, message = 'values differ') {
	const a = fmt(actual);
	const e = fmt(expected);
	if (a !== e) throw new AssertionError(message, `  expected: ${e}\n  actual  : ${a}`);
	return true;
}

export function assertDeepEquals(actual, expected, message = 'objects differ') {
	return assertEquals(actual, expected, message);
}

export function assertStatus(res, expected, message = 'unexpected HTTP status') {
	const wanted = Array.isArray(expected) ? expected : [expected];
	if (!wanted.includes(res.status)) {
		throw new AssertionError(
			`${message}: expected ${wanted.join(' or ')}, got ${res.status}`,
			describeResponse(res),
		);
	}
	return res;
}

/** Assert a WP_Error envelope per CONTRACT.md §2. */
export function assertWpError(res, { status, code }, message = 'unexpected error envelope') {
	if (status !== undefined) assertStatus(res, status, message);
	const body = res.json;
	if (!body || typeof body.code !== 'string') {
		throw new AssertionError(`${message}: body is not a WP_Error envelope`, describeResponse(res));
	}
	if (code !== undefined && body.code !== code) {
		throw new AssertionError(
			`${message}: expected code "${code}", got "${body.code}"`,
			describeResponse(res),
		);
	}
	if (status !== undefined && body?.data?.status !== status) {
		throw new AssertionError(
			`${message}: envelope data.status is ${fmt(body?.data?.status)}, expected ${status}`,
			describeResponse(res),
		);
	}
	return body;
}

export function assertIncludes(haystack, needle, message = 'value not found') {
	const ok = Array.isArray(haystack) ? haystack.includes(needle) : String(haystack).includes(needle);
	if (!ok) {
		throw new AssertionError(
			message,
			`  looking for: ${fmt(needle)}\n  in         : ${fmt(haystack).slice(0, 1200)}`,
		);
	}
	return true;
}

export function assertMatches(value, regex, message = 'value does not match') {
	if (!regex.test(String(value))) {
		throw new AssertionError(message, `  pattern : ${regex}\n  value   : ${fmt(value).slice(0, 600)}`);
	}
	return true;
}

/* ------------------------------------------------------------------ browser */

/** Resolve playwright out of tools/node_modules regardless of the caller's cwd. */
function requirePlaywright() {
	const require = createRequire(path.join(TOOLS_DIR, 'package.json'));
	try {
		return require('playwright');
	} catch (e) {
		throw new Error(
			`Playwright is not installed under tools/node_modules.\n` +
			`Run:  (cd tools && npm install)\n` +
			`Underlying error: ${e.message}`,
		);
	}
}

/* --------------------------------------------------------------- the env */

export class ProofEnv {
	constructor(instance) {
		this.instance = instance;
		this.url = instance.url;
		this.profile = instance.profile;
		this.posture = instance.posture;
		this.wp_version = instance.wp_version;
		this.siteDir = instance.siteDir;
		this.admin = instance.admin;
		this.agent = instance.agent;
		this.runtime = {
			url: instance.url,
			admin: instance.admin,
			agent: instance.agent,
			posture: instance.posture,
			profile: instance.profile,
			wp_version: instance.wp_version,
			pid: instance.pid,
			siteDir: instance.siteDir,
		};
		this._clients = new Map();
		this._browser = null;
		this._contexts = [];
	}

	/** Cached client per identity. `as` is 'admin' | 'agent' | 'anon'. */
	client(as = 'admin') {
		if (!this._clients.has(as)) {
			this._clients.set(
				as,
				as === 'anon'
					? createClient({ url: this.url })
					: clientForRuntime(this.runtime, { as }),
			);
		}
		return this._clients.get(as);
	}

	/**
	 * Call a REST route. Same probing/fallback logic as tools/wpcall.mjs.
	 *
	 * @param {string} method
	 * @param {string} route     e.g. '/x-companion/v1/fingerprint'
	 * @param {object} [opts]
	 * @param {'admin'|'agent'|'anon'} [opts.as='admin']
	 * @param {any}    [opts.body]
	 * @param {Array}  [opts.multipart]  [{name, filePath}] | [{name, value}]
	 * @param {object} [opts.query]
	 * @param {object} [opts.headers]
	 */
	async call(method, route, opts = {}) {
		const as = opts.as ?? 'admin';
		return this.client(as === 'anon' ? 'anon' : as).call(method, route, {
			...opts,
			anon: as === 'anon',
		});
	}

	/** Run PHP inside the sandbox. Returns the raw PHPResponse. */
	async php(code) {
		return this.instance.playground.run({ code });
	}

	/**
	 * Playwright page with GET /x-companion/v1/harness loaded over HTTP Basic
	 * auth (CONTRACT.md §6 — auth is sent on every request, including the
	 * harness), waited on `window.__ready`.
	 *
	 * @param {object} [opts]
	 * @param {'admin'|'agent'} [opts.as='admin']
	 * @param {number} [opts.timeout=45000]
	 * @param {boolean} [opts.headless=true]
	 * @returns {Promise<import('playwright').Page>}
	 */
	async harnessPage(opts = {}) {
		const as = opts.as ?? 'admin';
		const timeout = opts.timeout ?? 45000;
		const who = this.runtime[as];
		if (!who) throw new Error(`No "${as}" identity in this environment`);

		const { chromium } = requirePlaywright();
		if (!this._browser) {
			this._browser = await chromium.launch({ headless: opts.headless !== false });
		}
		// Two belts, deliberately.
		//
		// `httpCredentials` is the documented Playwright way to do Basic auth, but on
		// its own it does NOT authenticate a page navigation against WordPress: Chromium
		// only replays credentials after a 401 that carries a `WWW-Authenticate` header,
		// and the WP REST API answers `rest_forbidden` 401s without one. Verified against
		// a booted instance: page.goto() -> 401 with httpCredentials alone (including
		// `send: 'always'`), 200 once the header is set explicitly. context.request.*
		// does honour httpCredentials, which is why the difference is easy to miss.
		//
		// `extraHTTPHeaders` is therefore what actually authenticates, and it also covers
		// sub-resource requests the harness page makes back to the REST API. This matches
		// CONTRACT.md §6: Basic auth on every request, including GET /harness.
		const basic = 'Basic ' + Buffer.from(`${who.user}:${who.app_password}`).toString('base64');
		const context = await this._browser.newContext({
			httpCredentials: {
				username: who.user,
				password: who.app_password,
				origin: this.url,
				send: 'always',
			},
			extraHTTPHeaders: { Authorization: basic },
			ignoreHTTPSErrors: true,
		});
		this._contexts.push(context);
		const page = await context.newPage();

		const errors = [];
		page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
		page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

		const target = await this.harnessUrl();
		const res = await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
		if (!res || res.status() >= 400) {
			const body = res ? (await res.text()).slice(0, 800) : '(no response)';
			await context.close();
			throw new AssertionError(
				`GET ${target} returned ${res ? res.status() : 'nothing'} — the harness page did not load.`,
				`  body: ${body}`,
			);
		}
		page.__harnessUrl = target;
		page.__degradedHeader = res.headers()['x-harness-degraded'] ?? null;
		page.__pageErrors = errors;

		try {
			await page.waitForFunction(() => typeof window.__ready !== 'undefined', null, { timeout });
			await page.evaluate(() => window.__ready);
		} catch (e) {
			throw new AssertionError(
				`window.__ready never resolved on ${target} within ${timeout}ms.`,
				`  page errors: ${errors.join('\n               ') || '(none)'}`,
			);
		}
		return page;
	}

	/** The harness URL, honouring the pretty/plain permalink probe. */
	async harnessUrl() {
		if (this._harnessUrl) return this._harnessUrl;
		const probe = await this.call('GET', '/x-companion/v1/harness');
		this._harnessUrl = probe.url;
		return this._harnessUrl;
	}

	/** Write the runtime descriptor somewhere (e.g. to hand to wpcall.mjs). */
	writeRuntime(file) {
		const abs = path.resolve(file);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, JSON.stringify(this.runtime, null, 2) + '\n', { mode: 0o600 });
		return abs;
	}

	async _teardown() {
		for (const c of this._contexts) {
			try { await c.close(); } catch { /* ignore */ }
		}
		this._contexts = [];
		if (this._browser) {
			try { await this._browser.close(); } catch { /* ignore */ }
			this._browser = null;
		}
		await this.instance.stop();
		for (const f of [runtimePath(this.profile, this.posture), path.join(RUNTIME_DIR, `${this.profile}-${this.posture}.pid`)]) {
			fs.rmSync(f, { force: true });
		}
	}
}

/**
 * Boot an instance, run `fn(env)`, and always stop the instance afterwards.
 *
 * @param {object} spec
 * @param {'core-only'|'core-plus-suite'} [spec.profile='core-only']
 * @param {'toolchain'|'production'}      [spec.posture='toolchain']
 * @param {string[]} [spec.plugins]    plugin directories to mount live and activate
 * @param {string[]} [spec.muPlugins]  mu-plugin dirs (mounted) or .php files (copied)
 * @param {number}   [spec.port]
 * @param {boolean}  [spec.persist]
 * @param {'pretty'|'plain'} [spec.permalinks]
 * @param {number}   [spec.timeout]
 * @param {Function} fn
 */
export async function withInstance(spec, fn) {
	const instance = await boot({ quiet: true, ...spec });
	const env = new ProofEnv(instance);
	try {
		return await fn(env);
	} finally {
		await env._teardown();
	}
}

/**
 * Attach to an instance already booted by tools/playground/boot.mjs instead of
 * booting a new one. Useful for iterating on a scenario without paying the boot
 * cost each time. `stop()` is a no-op beyond closing the browser.
 */
export async function withRunningInstance({ profile = 'core-only', posture = 'toolchain', runtime } = {}, fn) {
	const rt = loadRuntime(runtime ?? runtimePath(profile, posture));
	const env = new ProofEnv({ ...rt, stop: async () => {}, playground: { run: async () => { throw new Error('env.php() needs an in-process instance; use withInstance()'); } } });
	try {
		return await fn(env);
	} finally {
		for (const c of env._contexts) { try { await c.close(); } catch { /* ignore */ } }
		if (env._browser) { try { await env._browser.close(); } catch { /* ignore */ } }
	}
}

export { boot, loadRuntime, createClient, clientForRuntime, runtimePath, RUNTIME_DIR };
