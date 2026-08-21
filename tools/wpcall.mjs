#!/usr/bin/env node
/**
 * wpcall.mjs — tiny authenticated REST client for the x-companion contract.
 *
 *   node tools/wpcall.mjs --runtime tools/.runtime/core-only-toolchain.json \
 *        GET /x-companion/v1/fingerprint
 *
 * Auth is HTTP Basic with a WordPress Application Password read out of the
 * runtime JSON written by tools/playground/boot.mjs. The password is NEVER
 * printed: it is redacted from every stream this script writes.
 *
 * Probes /wp-json/<route> first and falls back to /?rest_route=<route>
 * exactly as contract/CONTRACT.md §5 requires.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, loadRuntime, clientForRuntime, RestClientError } from './lib/rest-client.mjs';

const __filename = fileURLToPath(import.meta.url);
const TOOLS_DIR = path.dirname(__filename);
const RUNTIME_DIR = path.join(TOOLS_DIR, '.runtime');

/** Write and wait for the flush. process.exit() truncates piped stdout otherwise. */
function out(stream, text) {
	return new Promise((resolve) => {
		if (!stream.write(text)) stream.once('drain', resolve);
		else stream.write('', resolve);
	});
}

const USAGE = `
wpcall.mjs — authenticated REST client for a booted Playground instance.

  node tools/wpcall.mjs [options] <METHOD> <ROUTE>

Route is contract-relative, e.g. /x-companion/v1/fingerprint or /wp/v2/users/me.

Source of the instance (pick one)
  --runtime <file>        runtime JSON from boot.mjs
                          (default: the only file in tools/.runtime, if unambiguous)
  --profile <id> --posture <p>
                          shorthand for --runtime tools/.runtime/<profile>-<posture>.json
  --url <base> [--user u --password p]
                          talk to an arbitrary site

Identity
  --as admin|agent        which identity from the runtime file (default admin)
  --anon                  send no Authorization header

Request
  --body '<json>'         inline JSON body
  --body @file.json       body read from a file
  --raw-body <string>     send verbatim, no JSON content-type guessing
  --multipart name=@file  multipart/form-data file part (repeatable)
  --multipart name=value  multipart/form-data scalar part (repeatable)
  --query k=v             query parameter (repeatable)
  --header 'K: V'         extra request header (repeatable)
  --timeout <ms>          default 30000

Output
  --raw-out <file>        write the response body to a file (use for zip/binary)
  --envelope              print {status, headers, body} as JSON on stdout
  --headers               also print response headers to stderr
  --allow-error           exit 0 even on >=400 (proof tests assert 401/403/422)
  --silent                do not print the body
  -h, --help

Exit codes
  0  success (or --allow-error)
  1  HTTP >= 400
  2  bad usage / transport failure
`;

function parseArgv(argv) {
	const o = { multipart: [], query: {}, headers: {}, positional: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a} needs a value`);
			return v;
		};
		switch (a) {
			case '--runtime': o.runtime = next(); break;
			case '--profile': o.profile = next(); break;
			case '--posture': o.posture = next(); break;
			case '--url': o.url = next(); break;
			case '--user': o.user = next(); break;
			case '--password': o.password = next(); break;
			case '--as': o.as = next(); break;
			case '--anon': o.anon = true; break;
			case '--body': o.body = next(); break;
			case '--raw-body': o.rawBody = next(); break;
			case '--multipart': {
				const v = next();
				const eq = v.indexOf('=');
				if (eq < 0) throw new Error(`--multipart expects name=value or name=@file, got "${v}"`);
				const name = v.slice(0, eq);
				const val = v.slice(eq + 1);
				o.multipart.push(val.startsWith('@') ? { name, filePath: val.slice(1) } : { name, value: val });
				break;
			}
			case '--query': {
				const v = next();
				const eq = v.indexOf('=');
				if (eq < 0) throw new Error(`--query expects k=v, got "${v}"`);
				o.query[v.slice(0, eq)] = v.slice(eq + 1);
				break;
			}
			case '--header': {
				const v = next();
				const c = v.indexOf(':');
				if (c < 0) throw new Error(`--header expects "Key: Value", got "${v}"`);
				o.headers[v.slice(0, c).trim()] = v.slice(c + 1).trim();
				break;
			}
			case '--timeout': o.timeout = Number(next()); break;
			case '--raw-out': o.rawOut = next(); break;
			case '--envelope': o.envelope = true; break;
			case '--headers': o.showHeaders = true; break;
			case '--allow-error': o.allowError = true; break;
			case '--silent': o.silent = true; break;
			case '-h': case '--help': o.help = true; break;
			default:
				if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
				o.positional.push(a);
		}
	}
	return o;
}

function defaultRuntimeFile() {
	if (!fs.existsSync(RUNTIME_DIR)) return null;
	const files = fs.readdirSync(RUNTIME_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.ready.json'));
	if (files.length === 1) return path.join(RUNTIME_DIR, files[0]);
	return null;
}

/** Redact secrets from anything we print. */
function makeRedactor(secrets) {
	const real = secrets.filter((s) => typeof s === 'string' && s.length >= 6);
	return (s) => {
		let out = String(s);
		for (const sec of real) {
			out = out.split(sec).join('***app-password-redacted***');
			// Application passwords are stored/sent with spaces stripped in some flows.
			const nospace = sec.replace(/\s+/g, '');
			if (nospace !== sec && nospace.length >= 6) out = out.split(nospace).join('***app-password-redacted***');
		}
		return out;
	};
}

async function main() {
	let o;
	try {
		o = parseArgv(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`${e.message}\n${USAGE}`);
		process.exit(2);
	}
	if (o.help) { process.stdout.write(USAGE); process.exit(0); }

	let [method, route] = o.positional;
	if (o.positional.length === 1) { route = o.positional[0]; method = 'GET'; }
	if (!route) {
		process.stderr.write(`Missing ROUTE.\n${USAGE}`);
		process.exit(2);
	}
	method = String(method || 'GET').toUpperCase();

	// Resolve the target + identity.
	let client;
	let secrets = [];
	try {
		if (o.url) {
			client = createClient({ url: o.url, user: o.anon ? undefined : o.user, password: o.password, timeout: o.timeout });
			if (o.password) secrets.push(o.password);
		} else {
			let rtFile = o.runtime;
			if (!rtFile && (o.profile || o.posture)) {
				const profile = o.profile ?? 'core-only';
				const posture = o.posture ?? 'toolchain';
				rtFile = path.join(RUNTIME_DIR, `${profile}-${posture}.json`);
			}
			if (!rtFile) rtFile = defaultRuntimeFile();
			if (!rtFile) {
				throw new RestClientError(
					`No --runtime given and tools/.runtime does not hold exactly one runtime file.\n` +
					`Pass --runtime <file>, or --profile/--posture, or --url.\n` +
					`Boot one with: node tools/playground/boot.mjs --profile core-only --json`,
				);
			}
			const runtime = loadRuntime(rtFile);
			secrets = [runtime.admin?.app_password, runtime.agent?.app_password].filter(Boolean);
			client = clientForRuntime(runtime, { as: o.as ?? 'admin', anon: o.anon, timeout: o.timeout });
		}
	} catch (e) {
		process.stderr.write(`${e.message}\n`);
		process.exit(2);
	}
	const redact = makeRedactor(secrets);

	// Body.
	let body;
	if (o.rawBody !== undefined) {
		body = o.rawBody;
	} else if (o.body !== undefined) {
		if (o.body.startsWith('@')) {
			const f = path.resolve(o.body.slice(1));
			if (!fs.existsSync(f)) {
				process.stderr.write(`--body file not found: ${f}\n`);
				process.exit(2);
			}
			body = fs.readFileSync(f, 'utf8');
		} else {
			body = o.body;
		}
		try { JSON.parse(body); } catch (e) {
			process.stderr.write(`--body is not valid JSON (${e.message}). Use --raw-body to send it anyway.\n`);
			process.exit(2);
		}
	}

	let res;
	try {
		res = await client.call(method, route, {
			body,
			multipart: o.multipart,
			query: o.query,
			headers: o.headers,
			anon: o.anon,
		});
	} catch (e) {
		process.stderr.write(`${redact(e.message)}\n`);
		process.exit(2);
	}

	await out(process.stderr, redact(`HTTP ${res.status} ${res.method} ${res.url}\n`));
	if (o.showHeaders) {
		for (const [k, v] of Object.entries(res.headers)) await out(process.stderr, redact(`  ${k}: ${v}\n`));
	}

	if (o.rawOut) {
		const out = path.resolve(o.rawOut);
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, res.buffer);
		process.stderr.write(`wrote ${res.buffer.length} bytes to ${out}\n`);
	}

	if (!o.silent) {
		if (o.envelope) {
			await out(process.stdout, redact(JSON.stringify({
				status: res.status,
				url: res.url,
				headers: res.headers,
				body: res.json ?? res.text ?? `<${res.buffer.length} binary bytes>`,
			}, null, 2)) + '\n');
		} else if (res.json !== null && res.json !== undefined) {
			await out(process.stdout, redact(JSON.stringify(res.json, null, 2)) + '\n');
		} else if (res.text !== null) {
			await out(process.stdout, redact(res.text) + (res.text.endsWith('\n') ? '' : '\n'));
		} else if (!o.rawOut) {
			process.stderr.write(`<${res.buffer.length} bytes of ${res.headers['content-type'] ?? 'binary'}; use --raw-out to save>\n`);
		}
	}

	process.exit(res.status >= 400 && !o.allowError ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
	main();
}
