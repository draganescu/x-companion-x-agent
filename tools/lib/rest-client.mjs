/**
 * Shared authenticated REST client for the x-companion contract.
 *
 * Implements the CONTRACT.md §5 rule: probe `/wp-json/<route>` first, fall back
 * to `/?rest_route=<route>` when the site is on plain permalinks.
 *
 * Used by `tools/wpcall.mjs` (CLI) and `proof/lib/env.mjs` (programmatic).
 */

import fs from 'node:fs';
import path from 'node:path';

/** Per-base-URL memo of whether pretty permalinks work. */
const prettyCache = new Map();

export class RestClientError extends Error {
	constructor(message, extra = {}) {
		super(message);
		this.name = 'RestClientError';
		Object.assign(this, extra);
	}
}

function normalizeRoute(route) {
	if (typeof route !== 'string' || route.length === 0) {
		throw new RestClientError('route must be a non-empty string');
	}
	return route.startsWith('/') ? route : `/${route}`;
}

function buildUrls(baseUrl, route, query) {
	const base = baseUrl.replace(/\/+$/, '');
	const r = normalizeRoute(route);
	const qs = query && Object.keys(query).length
		? Object.entries(query)
			.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
			.join('&')
		: '';

	// Pretty permalinks: /wp-json/<route>?<qs>
	const pretty = `${base}/wp-json${r}${qs ? `?${qs}` : ''}`;
	// Plain permalinks: /?rest_route=<route>&<qs>  (the route must NOT be url-encoded,
	// WordPress reads the raw path out of the query var).
	const plain = `${base}/?rest_route=${r}${qs ? `&${qs}` : ''}`;
	return { pretty, plain };
}

function isRestJsonError(status, text) {
	if (status !== 404) return false;
	try {
		const j = JSON.parse(text);
		return typeof j?.code === 'string' && j.code.startsWith('rest_');
	} catch {
		return false;
	}
}

async function readResponse(res) {
	const buf = Buffer.from(await res.arrayBuffer());
	const headers = Object.fromEntries(res.headers.entries());
	const ctype = headers['content-type'] || '';
	const isText = /json|text|xml|html|javascript/i.test(ctype) || buf.length === 0;
	let text = null;
	let json = null;
	if (isText) {
		text = buf.toString('utf8');
		if (/json/i.test(ctype)) {
			try { json = JSON.parse(text); } catch { /* leave null */ }
		}
	}
	return { status: res.status, headers, buffer: buf, text, json };
}

/**
 * @param {object} opts
 * @param {string} opts.url            Site base URL, e.g. http://127.0.0.1:9400
 * @param {string} [opts.user]         Basic-auth user (omit for anonymous)
 * @param {string} [opts.password]     Application password
 * @param {number} [opts.timeout=30000]
 */
export function createClient({ url, user, password, timeout = 30000 }) {
	if (!url) throw new RestClientError('createClient requires a url');
	const base = url.replace(/\/+$/, '');
	const authHeader = user
		? 'Basic ' + Buffer.from(`${user}:${password ?? ''}`).toString('base64')
		: null;

	async function fetchOnce(target, method, init) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeout);
		try {
			const res = await fetch(target, { ...init, method, signal: ctrl.signal, redirect: 'manual' });
			const out = await readResponse(res);
			out.url = target;
			out.method = method;
			return out;
		} catch (err) {
			if (err?.name === 'AbortError') {
				throw new RestClientError(`Timed out after ${timeout}ms calling ${method} ${target}`);
			}
			throw new RestClientError(
				`Could not reach ${method} ${target}: ${err?.message ?? err}. ` +
				`Is the Playground instance still running? (tools/playground/boot.mjs)`,
			);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * @param {string} method  GET|POST|PUT|PATCH|DELETE|HEAD
	 * @param {string} route   e.g. /x-companion/v1/fingerprint
	 * @param {object} [opts]
	 * @param {any}    [opts.body]       object -> JSON, string/Buffer -> sent verbatim
	 * @param {object} [opts.query]
	 * @param {object} [opts.headers]
	 * @param {Array}  [opts.multipart]  [{ name, filePath }] or [{ name, value }]
	 * @param {boolean}[opts.anon]       force no Authorization header for this call
	 */
	async function call(method, route, opts = {}) {
		const m = String(method || 'GET').toUpperCase();
		const headers = { Accept: '*/*', ...(opts.headers || {}) };
		if (authHeader && !opts.anon) headers.Authorization = authHeader;

		let body;
		if (opts.multipart && opts.multipart.length) {
			const form = new FormData();
			for (const part of opts.multipart) {
				if (part.filePath) {
					const abs = path.resolve(part.filePath);
					if (!fs.existsSync(abs)) {
						throw new RestClientError(`multipart file not found: ${abs}`);
					}
					const data = fs.readFileSync(abs);
					form.append(part.name, new Blob([data]), path.basename(abs));
				} else {
					form.append(part.name, String(part.value ?? ''));
				}
			}
			body = form; // fetch sets the multipart boundary content-type itself
			delete headers['Content-Type'];
			delete headers['content-type'];
		} else if (opts.body !== undefined && opts.body !== null) {
			if (typeof opts.body === 'string' || Buffer.isBuffer(opts.body)) {
				body = opts.body;
				if (!headers['Content-Type'] && !headers['content-type']) {
					headers['Content-Type'] = 'application/json';
				}
			} else {
				body = JSON.stringify(opts.body);
				headers['Content-Type'] = 'application/json';
			}
		}

		const { pretty, plain } = buildUrls(base, route, opts.query);
		const cached = prettyCache.get(base);

		if (cached === false) {
			return fetchOnce(plain, m, { headers, body });
		}

		const first = await fetchOnce(pretty, m, { headers, body });

		// A redirect on /wp-json means the REST rewrite rule is not installed,
		// i.e. the site is on plain permalinks (WordPress canonical-redirects
		// /wp-json/... to the front page). Verified against a Playground instance
		// booted with --permalinks plain: pretty -> 301, ?rest_route= -> 200.
		const looksPlain = [301, 302, 307, 308].includes(first.status)
			|| (first.status === 404 && !isRestJsonError(first.status, first.text ?? ''));

		if (!looksPlain) {
			prettyCache.set(base, true);
			return first;
		}
		const second = await fetchOnce(plain, m, { headers, body });
		if (second.status !== 404) prettyCache.set(base, false);
		return second;
	}

	return { base, call, hasAuth: !!authHeader };
}

/** Load a runtime JSON descriptor written by tools/playground/boot.mjs. */
export function loadRuntime(runtimePath) {
	const abs = path.resolve(runtimePath);
	if (!fs.existsSync(abs)) {
		throw new RestClientError(
			`Runtime file not found: ${abs}\n` +
			`Boot an instance first, e.g.:\n` +
			`  node tools/playground/boot.mjs --profile core-only --posture toolchain --json`,
		);
	}
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
	} catch (e) {
		throw new RestClientError(`Runtime file ${abs} is not valid JSON: ${e.message}`);
	}
	if (!parsed.url) throw new RestClientError(`Runtime file ${abs} has no "url"`);
	return parsed;
}

/** Build a client for a runtime descriptor, choosing the admin or agent identity. */
export function clientForRuntime(runtime, { as = 'admin', anon = false, timeout } = {}) {
	if (anon) return createClient({ url: runtime.url, timeout });
	const who = runtime[as];
	if (!who) {
		throw new RestClientError(
			`Runtime has no "${as}" identity. Available: ${Object.keys(runtime).filter((k) => runtime[k]?.app_password).join(', ') || '(none)'}`,
		);
	}
	return createClient({ url: runtime.url, user: who.user, password: who.app_password, timeout });
}
