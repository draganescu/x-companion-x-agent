#!/usr/bin/env node
/**
 * boot.mjs — boot a real WordPress (WordPress Playground, no Docker) for the
 * x-companion / x-agent live test suites, and hand back everything needed to
 * talk to it over the wire contract in contract/CONTRACT.md.
 *
 * CLI:
 *   node tools/playground/boot.mjs --profile core-only --port 9400 \
 *        --plugin ../../x-companion --posture toolchain --json
 *
 * Programmatic:
 *   import { boot } from './tools/playground/boot.mjs';
 *   const inst = await boot({ profile: 'core-only', plugins: ['x-companion'] });
 *   ... inst.url, inst.admin.app_password ...
 *   await inst.stop();
 *
 * See tools/README.md for the full flag list and the sandbox caveats.
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const TOOLS_DIR = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(TOOLS_DIR, '..');
export const RUNTIME_DIR = path.join(TOOLS_DIR, '.runtime');
const BLUEPRINT_DIR = path.join(__dirname, 'blueprints');

export const PROFILES = ['core-only', 'core-plus-suite'];
export const POSTURES = ['toolchain', 'production'];

/** Deterministic default port per (profile, posture) so tests can guess. */
const DEFAULT_PORTS = {
	'core-only:toolchain': 9400,
	'core-only:production': 9401,
	'core-plus-suite:toolchain': 9402,
	'core-plus-suite:production': 9403,
};
const PORT_RANGE = [9400, 9450];

/* ------------------------------------------------------------------ utils */

export function runtimeKey(profile, posture, slot) {
	// `slot` lets an independent consumer (e.g. the proof suite) hold its own
	// instance alongside one booted for the same profile+posture by someone else.
	// Default is unchanged, so every existing caller keeps its old path.
	return slot ? `${slot}` : `${profile}-${posture}`;
}
export function runtimePath(profile, posture, slot) {
	return path.join(RUNTIME_DIR, `${runtimeKey(profile, posture, slot)}.json`);
}
export function pidPath(profile, posture, slot) {
	return path.join(RUNTIME_DIR, `${runtimeKey(profile, posture, slot)}.pid`);
}
export function logPath(profile, posture, slot) {
	return path.join(RUNTIME_DIR, `${runtimeKey(profile, posture)}.log`);
}
function readyPath(profile, posture) {
	return path.join(RUNTIME_DIR, `${runtimeKey(profile, posture)}.ready.json`);
}

class BootError extends Error {
	constructor(message) {
		super(message);
		this.name = 'BootError';
	}
}

function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true });
	return p;
}

async function portFree(port) {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.once('error', () => resolve(false));
		srv.once('listening', () => srv.close(() => resolve(true)));
		// No host: bind the wildcard address. Playground's express server binds
		// `::` (dual-stack), so probing 127.0.0.1 alone reports a taken port free.
		srv.listen(port);
	});
}

async function pickPort(profile, posture, requested) {
	if (requested) {
		if (!(await portFree(requested))) {
			throw new BootError(
				`Port ${requested} is already in use. Stop whatever is on it, or run:\n` +
				`  node tools/playground/stop.mjs --port ${requested}`,
			);
		}
		return requested;
	}
	const preferred = DEFAULT_PORTS[`${profile}:${posture}`];
	const candidates = [preferred].filter(Boolean);
	for (let p = PORT_RANGE[0]; p <= PORT_RANGE[1]; p++) {
		if (!candidates.includes(p)) candidates.push(p);
	}
	for (const p of candidates) {
		if (await portFree(p)) return p;
	}
	throw new BootError(`No free port in ${PORT_RANGE[0]}-${PORT_RANGE[1]}.`);
}

function rmrf(p) {
	fs.rmSync(p, { recursive: true, force: true });
}

/* ------------------------------------------------- plugin dir validation */

function validatePluginDir(p) {
	const abs = path.resolve(p);
	if (!fs.existsSync(abs)) {
		throw new BootError(
			`Plugin directory not found: ${abs}\n` +
			`--plugin takes a path to a WordPress plugin *directory* (the one that holds the ` +
			`main .php file with the "Plugin Name:" header). It has not been created yet, or the ` +
			`path is wrong.`,
		);
	}
	if (!fs.statSync(abs).isDirectory()) {
		throw new BootError(`--plugin must be a directory, got a file: ${abs}`);
	}
	const phpFiles = fs.readdirSync(abs).filter((f) => f.endsWith('.php'));
	if (phpFiles.length === 0) {
		throw new BootError(
			`${abs} contains no .php files, so it is not a WordPress plugin directory yet.`,
		);
	}
	// Find the entry file: the first top-level PHP file with a "Plugin Name:" header.
	// Prefer <dirname>.php when several qualify.
	const base = path.basename(abs);
	const withHeader = phpFiles.filter((f) => {
		try {
			const head = fs.readFileSync(path.join(abs, f), 'utf8').slice(0, 8192);
			return /^[\s\S]*?\*\s*Plugin Name\s*:/im.test(head) || /Plugin Name\s*:/i.test(head);
		} catch {
			return false;
		}
	});
	let entry = null;
	if (withHeader.includes(`${base}.php`)) entry = `${base}.php`;
	else if (withHeader.length) entry = withHeader[0];

	if (!entry) {
		throw new BootError(
			`No "Plugin Name:" header found in any top-level .php file of ${abs}.\n` +
			`WordPress cannot activate it. Files seen: ${phpFiles.join(', ')}`,
		);
	}
	return { hostPath: abs, folder: base, entry, pluginFile: `${base}/${entry}` };
}

/* ------------------------------------------------ generated mu-plugins */

const MU_APP_PASSWORDS = `<?php
/**
 * Plugin Name: x sandbox — Application Passwords over plain HTTP
 * Description: SANDBOX ONLY. WordPress refuses to hand out or accept Application
 *              Passwords when the request is not SSL. The Playground instance is
 *              plain http on 127.0.0.1, so the whole Basic-auth contract would be
 *              untestable without this. Generated by tools/playground/boot.mjs.
 *              Never ship this to anything reachable from a network.
 */

add_filter( 'wp_is_application_passwords_available', '__return_true' );
add_filter( 'wp_is_application_passwords_available_for_user', '__return_true' );
`;

function muPosture(posture) {
	return `<?php
/**
 * Plugin Name: x sandbox — posture
 * Description: Defines X_COMPANION_POSTURE for this instance. Generated by
 *              tools/playground/boot.mjs. This is the belt-and-braces copy: the
 *              constant is normally already defined by Playground's
 *              php.defineConstant() before wp-config.php runs, so the guard below
 *              is usually a no-op. It matters for code paths that do not go
 *              through the CLI's --define (e.g. a separate wp-playground-cli php
 *              process pointed at the same site directory).
 */

if ( ! defined( 'X_COMPANION_POSTURE' ) ) {
	define( 'X_COMPANION_POSTURE', ${JSON.stringify(posture)} );
}
`;
}

function muExtraLoader(dirs) {
	const lines = dirs
		.map(
			(d) => `foreach ( glob( ${JSON.stringify(`/wordpress/wp-content/x-mu/${d}`)} . '/*.php' ) as $x_mu_file ) {
	require_once $x_mu_file;
}`,
		)
		.join('\n');
	return `<?php
/**
 * Plugin Name: x sandbox — extra mu-plugin loader
 * Description: Requires the top-level PHP files of every directory passed with
 *              --mu-plugin. The directories are mounted live from the host, so
 *              edits on disk take effect on the next request. Generated by
 *              tools/playground/boot.mjs.
 */

${lines}
`;
}

/* ------------------------------------------------------ PHP helper snippets */

/** PHP that provisions the two users + application passwords and echoes JSON. */
function provisionPhp({ adminUser, agentUser, adminEmail, agentEmail, adminPass, agentPass }) {
	return `<?php
require_once '/wordpress/wp-load.php';

function x_boot_user( $login, $email, $password, $role ) {
	$user = get_user_by( 'login', $login );
	if ( $user ) {
		$uid = $user->ID;
		wp_set_password( $password, $uid );
	} else {
		$uid = wp_create_user( $login, $password, $email );
		if ( is_wp_error( $uid ) ) {
			return array( 'error' => $uid->get_error_message() );
		}
	}
	$u = new WP_User( $uid );
	$u->set_role( $role );

	// Drop any previously issued app passwords for this sandbox so repeated
	// boots against a persisted site do not pile them up.
	WP_Application_Passwords::delete_all_application_passwords( $uid );
	$created = WP_Application_Passwords::create_new_application_password(
		$uid,
		array( 'name' => 'x-tools ' . gmdate( 'c' ) )
	);
	if ( is_wp_error( $created ) ) {
		return array( 'error' => $created->get_error_message() );
	}
	return array( 'user' => $login, 'app_password' => $created[0], 'role' => $role, 'id' => $uid );
}

$agent_role = get_role( 'x_agent' ) ? 'x_agent' : 'subscriber';

$out = array(
	'wp_version'     => get_bloginfo( 'version' ),
	'admin'          => x_boot_user( ${JSON.stringify(adminUser)}, ${JSON.stringify(adminEmail)}, ${JSON.stringify(adminPass)}, 'administrator' ),
	'agent'          => x_boot_user( ${JSON.stringify(agentUser)}, ${JSON.stringify(agentEmail)}, ${JSON.stringify(agentPass)}, $agent_role ),
	'agent_role_fallback' => ( 'x_agent' !== $agent_role ),
	'posture'        => defined( 'X_COMPANION_POSTURE' ) ? X_COMPANION_POSTURE : null,
	'app_passwords_available' => wp_is_application_passwords_available(),
	'active_plugins' => array_values( (array) get_option( 'active_plugins', array() ) ),
	'theme'          => get_stylesheet(),
	'permalink_structure' => get_option( 'permalink_structure' ),
);
echo "\\n<<<XBOOT>>>" . wp_json_encode( $out ) . "<<<XBOOT>>>";
`;
}

function permalinkPhp(mode) {
	const structure = mode === 'plain' ? '' : '/%postname%/';
	return `<?php
require_once '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/misc.php';
global $wp_rewrite;
update_option( 'permalink_structure', ${JSON.stringify(structure)} );
$wp_rewrite->set_permalink_structure( ${JSON.stringify(structure)} );
$wp_rewrite->flush_rules( true );
echo "\\n<<<XBOOT>>>" . wp_json_encode( array( 'permalink_structure' => get_option( 'permalink_structure' ) ) ) . "<<<XBOOT>>>";
`;
}

function parseTagged(text) {
	const m = String(text ?? '').split('<<<XBOOT>>>');
	if (m.length < 3) {
		throw new BootError(
			`Could not read the result of an in-sandbox PHP call.\nRaw PHP output:\n${String(text).slice(0, 4000)}`,
		);
	}
	return JSON.parse(m[1]);
}

/* --------------------------------------------------------------- the boot */

/**
 * Boot a Playground WordPress instance **in this process**.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.profile='core-only']      'core-only' | 'core-plus-suite'
 * @param {string}   [opts.posture='toolchain']      'toolchain' | 'production'
 * @param {number}   [opts.port]                     default: deterministic per profile/posture
 * @param {string[]} [opts.plugins=[]]               host plugin directories to mount live
 * @param {string[]} [opts.muPlugins=[]]             host mu-plugin dirs (mounted) or files (copied)
 * @param {boolean}  [opts.persist=false]            keep the site dir (and its DB) between runs
 * @param {number}   [opts.timeout=180000]           hard boot timeout, ms
 * @param {string}   [opts.php='8.3']
 * @param {string}   [opts.wp='latest']
 * @param {string}   [opts.permalinks]               'pretty' | 'plain' (default: leave as booted)
 * @param {boolean}  [opts.quiet=false]
 * @returns {Promise<object>} runtime descriptor + { stop(), server, playground }
 */
export async function boot(opts = {}) {
	const profile = opts.profile ?? 'core-only';
	const posture = opts.posture ?? 'toolchain';
	if (!PROFILES.includes(profile)) {
		throw new BootError(`Unknown profile "${profile}". Expected one of: ${PROFILES.join(', ')}`);
	}
	if (!POSTURES.includes(posture)) {
		throw new BootError(`Unknown posture "${posture}". Expected one of: ${POSTURES.join(', ')}`);
	}
	const timeout = Number(opts.timeout ?? 180000);
	const persist = !!opts.persist;
	const quiet = !!opts.quiet;
	// Optional: an explicit runtime slot name. Without it the slot is
	// `<profile>-<posture>`, which is what every CLI caller uses.
	const slot = opts.slot ?? null;
	const key = runtimeKey(profile, posture, slot);

	const pluginPaths = (opts.plugins ?? []).map(validatePluginDir);
	const seen = new Set();
	for (const p of pluginPaths) {
		if (seen.has(p.folder)) {
			throw new BootError(`Two --plugin values resolve to the same folder name "${p.folder}".`);
		}
		seen.add(p.folder);
	}

	ensureDir(RUNTIME_DIR);

	// One instance per (profile, posture): the runtime descriptor lives at a fixed
	// path, so a second boot for the same key would clobber the first one's
	// bookkeeping and then delete it on teardown.
	const recorded = readPid(profile, posture, slot);
	if (recorded && recorded !== process.pid && processAlive(recorded)) {
		throw new BootError(
			`An instance for ${key} is already running (pid ${recorded}).\n` +
			(slot
				? `Stop it first:  node tools/playground/stop.mjs --port ${opts.port ?? '<its port>'}`
				: `Stop it first:  node tools/playground/stop.mjs --profile ${profile} --posture ${posture}`),
		);
	}

	const workDir = ensureDir(path.join(RUNTIME_DIR, 'work', key));
	const muDir = path.join(workDir, 'mu-plugins');
	const siteDir = path.join(RUNTIME_DIR, 'sites', key);

	// Regenerate mu-plugins on every boot: they encode the posture.
	rmrf(muDir);
	ensureDir(muDir);
	fs.writeFileSync(path.join(muDir, '000-x-posture.php'), muPosture(posture));
	fs.writeFileSync(path.join(muDir, '001-x-app-passwords.php'), MU_APP_PASSWORDS);

	// --mu-plugin: directories are mounted (live); single files are copied.
	const muMounts = [];
	const muDirNames = [];
	let copiedIdx = 100;
	for (const raw of opts.muPlugins ?? []) {
		const abs = path.resolve(raw);
		if (!fs.existsSync(abs)) {
			throw new BootError(`--mu-plugin path not found: ${abs}`);
		}
		if (fs.statSync(abs).isDirectory()) {
			const name = path.basename(abs);
			muDirNames.push(name);
			muMounts.push({ hostPath: abs, vfsPath: `/wordpress/wp-content/x-mu/${name}` });
		} else {
			const dest = path.join(muDir, `${copiedIdx++}-${path.basename(abs)}`);
			fs.copyFileSync(abs, dest);
		}
	}
	if (muDirNames.length) {
		fs.writeFileSync(path.join(muDir, '002-x-extra-mu-loader.php'), muExtraLoader(muDirNames));
	}

	// Site directory. Always a real host directory so `siteDir` in the runtime
	// JSON points at something you can actually open.
	const hadSite = fs.existsSync(path.join(siteDir, 'wp-load.php'));
	if (!persist && hadSite) rmrf(siteDir);
	ensureDir(siteDir);
	const reuse = persist && hadSite;

	const port = await pickPort(profile, posture, opts.port ? Number(opts.port) : undefined);
	const url = `http://127.0.0.1:${port}`;

	// Blueprint: the profile file, plus one activatePlugin step per mounted plugin.
	const blueprintFile = path.join(BLUEPRINT_DIR, `${profile}.json`);
	if (!fs.existsSync(blueprintFile)) {
		throw new BootError(`Blueprint missing: ${blueprintFile}`);
	}
	const blueprint = JSON.parse(fs.readFileSync(blueprintFile, 'utf8'));
	blueprint.steps = blueprint.steps ?? [];
	for (const p of pluginPaths) {
		blueprint.steps.push({
			step: 'activatePlugin',
			pluginPath: p.pluginFile,
			pluginName: p.folder,
			progress: { caption: `Activating ${p.folder}` },
		});
	}
	if (opts.php) blueprint.preferredVersions = { ...blueprint.preferredVersions, php: opts.php };
	if (opts.wp) blueprint.preferredVersions = { ...blueprint.preferredVersions, wp: opts.wp };

	const mounts = [
		{ hostPath: muDir, vfsPath: '/wordpress/wp-content/mu-plugins' },
		...muMounts,
		...pluginPaths.map((p) => ({
			hostPath: p.hostPath,
			vfsPath: `/wordpress/wp-content/plugins/${p.folder}`,
		})),
	];

	const { runCLI } = await import('@wp-playground/cli');

	let server;
	const bootStart = Date.now();
	try {
		server = await withTimeout(
			runCLI({
				command: 'server',
				php: opts.php ?? blueprint.preferredVersions?.php ?? '8.3',
				wp: opts.wp ?? blueprint.preferredVersions?.wp ?? 'latest',
				port,
				login: false,
				verbosity: quiet ? 'quiet' : 'normal',
				'mount-before-install': [{ hostPath: siteDir, vfsPath: '/wordpress' }],
				mount: mounts,
				wordpressInstallMode: reuse ? 'install-from-existing-files-if-needed' : 'download-and-install',
				// php.defineConstant() — applied before wp-config.php runs, i.e. earlier
				// than mu-plugins and earlier than any plugin. See tools/README.md.
				define: { X_COMPANION_POSTURE: posture },
				blueprint,
			}),
			timeout,
			`Playground did not finish booting within ${timeout}ms.`,
		);
	} catch (err) {
		if (profile === 'core-plus-suite') {
			throw new BootError(
				`Profile "core-plus-suite" failed to boot. This profile REQUIRES Kadence Blocks to be ` +
				`downloaded from wordpress.org — there is no offline fallback and it must not silently ` +
				`degrade to core-only.\nUnderlying error: ${err?.message ?? err}\n` +
				`Check network access to https://downloads.wordpress.org/plugin/kadence-blocks.*.zip and retry.`,
			);
		}
		throw err;
	}

	const stop = async () => {
		try {
			await server[Symbol.asyncDispose]();
		} catch { /* already gone */ }
	};

	try {
		// 1. Wait until WordPress actually answers a REST request.
		await waitForRest(url, timeout - (Date.now() - bootStart));

		// 2. Optional permalink mode (exercises both branches of CONTRACT.md §5).
		if (opts.permalinks) {
			if (!['pretty', 'plain'].includes(opts.permalinks)) {
				throw new BootError(`--permalinks must be "pretty" or "plain", got "${opts.permalinks}"`);
			}
			const r = await server.playground.run({ code: permalinkPhp(opts.permalinks) });
			parseTagged(r.text);
		}

		// 3. Provision users + application passwords inside the sandbox.
		const adminLoginPass = randomBytes(18).toString('base64url');
		const agentLoginPass = randomBytes(18).toString('base64url');
		const provision = await server.playground.run({
			code: provisionPhp({
				adminUser: 'x_admin',
				agentUser: 'x_agent_user',
				adminEmail: 'x-admin@example.test',
				agentEmail: 'x-agent@example.test',
				adminPass: adminLoginPass,
				agentPass: agentLoginPass,
			}),
		});
		const info = parseTagged(provision.text);
		if (info.admin?.error) throw new BootError(`Could not create the admin user: ${info.admin.error}`);
		if (info.agent?.error) throw new BootError(`Could not create the agent user: ${info.agent.error}`);
		if (!info.app_passwords_available) {
			throw new BootError(
				`WordPress reports Application Passwords are unavailable even with the generated ` +
				`mu-plugin filter. Check ${path.join(muDir, '001-x-app-passwords.php')} was mounted.`,
			);
		}

		// 4. Profile assertions — fail loudly rather than degrade.
		if (profile === 'core-plus-suite') {
			const kadence = (info.active_plugins || []).filter((p) => p.startsWith('kadence-blocks/'));
			if (kadence.length === 0) {
				throw new BootError(
					`Profile "core-plus-suite" booted but Kadence Blocks is NOT active ` +
					`(active plugins: ${JSON.stringify(info.active_plugins)}). ` +
					`The blueprint installs it from wordpress.org with onError=throw; this means the ` +
					`download or the activation silently no-opped. Refusing to hand back a degraded ` +
					`core-only instance. Check ${logPath(profile, posture)}.`,
				);
			}
		}
		if (info.posture !== posture) {
			throw new BootError(
				`Posture injection failed: X_COMPANION_POSTURE is ${JSON.stringify(info.posture)} ` +
				`inside the sandbox but ${JSON.stringify(posture)} was requested.`,
			);
		}

		// 5. Assemble the runtime descriptor. Key order is part of the contract
		//    with the other tools; do not reorder.
		const runtime = {
			url,
			admin: { user: info.admin.user, app_password: info.admin.app_password, login_pass: adminLoginPass },
			agent: { user: info.agent.user, app_password: info.agent.app_password, login_pass: agentLoginPass, role: info.agent.role },
			posture,
			profile,
			wp_version: info.wp_version,
			pid: process.pid,
			siteDir,
		};

		fs.writeFileSync(runtimePath(profile, posture, slot), JSON.stringify(runtime, null, 2) + '\n', { mode: 0o600 });
		fs.writeFileSync(pidPath(profile, posture, slot), String(process.pid) + '\n');

		if (info.agent_role_fallback && !quiet) {
			process.stderr.write(
				`[boot] NOTE: role "x_agent" does not exist in this instance, so the agent user was ` +
				`given "subscriber" instead. Capability-gating proofs that need x_agent will not be ` +
				`meaningful until x-companion registers the role.\n`,
			);
		}

		return {
			...runtime,
			stop,
			server,
			playground: server.playground,
			plugins: pluginPaths.map((p) => ({ folder: p.folder, pluginFile: p.pluginFile, hostPath: p.hostPath })),
			mounts,
			muDir,
			activePlugins: info.active_plugins,
			theme: info.theme,
			permalink_structure: info.permalink_structure,
			agent_role_fallback: !!info.agent_role_fallback,
		};
	} catch (err) {
		await stop();
		throw err;
	}
}

async function withTimeout(promise, ms, message) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new BootError(message)), Math.max(1000, ms));
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Poll `/?rest_route=/` until the REST API answers, or blow up with a diagnostic. */
export async function waitForRest(url, timeoutMs = 120000) {
	const deadline = Date.now() + Math.max(2000, timeoutMs);
	let last = 'no attempt made';
	while (Date.now() < deadline) {
		try {
			// Note for humans copying this to zsh: the `?` must be quoted.
			const res = await fetch(`${url}/?rest_route=/`, { redirect: 'manual' });
			const body = await res.text();
			if (res.status === 200 && body.includes('"namespaces"')) return true;
			last = `HTTP ${res.status}, body starts: ${body.slice(0, 160)}`;
		} catch (e) {
			last = e?.message ?? String(e);
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new BootError(
		`WordPress never answered the REST API at ${url}/?rest_route=/ within ${timeoutMs}ms.\n` +
		`Last attempt: ${last}`,
	);
}

/* ------------------------------------------------------------ daemon mode */

/**
 * Boot in a **detached child process** and return once it is serving.
 * The child outlives this process; stop it with tools/playground/stop.mjs.
 */
export async function bootDetached(opts = {}) {
	const profile = opts.profile ?? 'core-only';
	const posture = opts.posture ?? 'toolchain';
	if (!PROFILES.includes(profile)) {
		throw new BootError(`Unknown profile "${profile}". Expected one of: ${PROFILES.join(', ')}`);
	}
	if (!POSTURES.includes(posture)) {
		throw new BootError(`Unknown posture "${posture}". Expected one of: ${POSTURES.join(', ')}`);
	}
	for (const p of opts.plugins ?? []) validatePluginDir(p);
	ensureDir(RUNTIME_DIR);

	// Refuse to trample a live instance for this key.
	const existing = readPid(profile, posture);
	if (existing && processAlive(existing)) {
		throw new BootError(
			`An instance for ${runtimeKey(profile, posture)} is already running (pid ${existing}).\n` +
			`Stop it first:  node tools/playground/stop.mjs --profile ${profile} --posture ${posture}`,
		);
	}

	const bootId = randomUUID();
	const ready = readyPath(profile, posture);
	rmrf(ready);

	const argv = [__filename, '--__daemon', '--boot-id', bootId, ...serializeOpts(opts)];
	// 'w', not 'a': on failure we print the tail of this file, and a previous
	// successful boot's output would drown the actual error.
	const log = fs.openSync(logPath(profile, posture), 'w');
	const child = spawn(process.execPath, argv, {
		detached: true,
		stdio: ['ignore', log, log],
		cwd: TOOLS_DIR,
		env: { ...process.env },
	});
	child.unref();

	const timeout = Number(opts.timeout ?? 180000);
	const deadline = Date.now() + timeout + 15000;
	while (Date.now() < deadline) {
		if (fs.existsSync(ready)) {
			let payload;
			try {
				payload = JSON.parse(fs.readFileSync(ready, 'utf8'));
			} catch {
				payload = null;
			}
			if (payload && payload.bootId === bootId) {
				rmrf(ready);
				if (!payload.ok) {
					throw new BootError(
						`${payload.error}\n\n--- last 40 lines of ${logPath(profile, posture)} ---\n${tailLog(profile, posture)}`,
					);
				}
				for (const note of payload.notes ?? []) {
					if (!opts.quiet) process.stderr.write(`[boot] NOTE: ${note}\n`);
				}
				return payload.runtime;
			}
		}
		if (child.exitCode !== null && child.exitCode !== undefined) {
			throw new BootError(
				`The boot process exited (code ${child.exitCode}) before reporting readiness.\n` +
				`--- last 40 lines of ${logPath(profile, posture)} ---\n${tailLog(profile, posture)}`,
			);
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ }
	throw new BootError(
		`Timed out after ${timeout}ms waiting for ${runtimeKey(profile, posture)} to report readiness.\n` +
		`--- last 40 lines of ${logPath(profile, posture)} ---\n${tailLog(profile, posture)}`,
	);
}

function tailLog(profile, posture) {
	try {
		return fs.readFileSync(logPath(profile, posture), 'utf8').split('\n').slice(-40).join('\n');
	} catch {
		return '(no log)';
	}
}

function serializeOpts(o) {
	const out = [];
	const push = (k, v) => { out.push(`--${k}`, String(v)); };
	if (o.profile) push('profile', o.profile);
	if (o.posture) push('posture', o.posture);
	if (o.port) push('port', o.port);
	if (o.php) push('php', o.php);
	if (o.wp) push('wp', o.wp);
	if (o.timeout) push('timeout', o.timeout);
	if (o.permalinks) push('permalinks', o.permalinks);
	if (o.persist) out.push('--persist');
	if (o.quiet) out.push('--quiet');
	for (const p of o.plugins ?? []) push('plugin', path.resolve(p));
	for (const p of o.muPlugins ?? []) push('mu-plugin', path.resolve(p));
	return out;
}

export function readPid(profile, posture, slot) {
	try {
		const v = parseInt(fs.readFileSync(pidPath(profile, posture, slot), 'utf8').trim(), 10);
		return Number.isFinite(v) ? v : null;
	} catch {
		return null;
	}
}

export function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e?.code === 'EPERM';
	}
}

/* ----------------------------------------------------------------- CLI */

const USAGE = `
boot.mjs — boot a real WordPress (Playground, no Docker) for the x test suites.

  node tools/playground/boot.mjs [options]

Options
  --profile <id>        core-only | core-plus-suite            (default core-only)
  --posture <p>         toolchain | production                 (default toolchain)
  --port <n>            default: 9400/9401/9402/9403 per profile+posture
  --plugin <dir>        mount a plugin directory live and activate it (repeatable)
  --mu-plugin <path>    a directory (mounted live) or a single .php file (copied)
  --persist             keep the site directory + DB between runs
  --permalinks <mode>   pretty | plain  (default: whatever Playground booted with)
  --php <v>             default 8.3        --wp <v>   default latest
  --timeout <ms>        default 180000
  --foreground          run the server in this process instead of detaching
  --json                print the runtime descriptor as JSON (includes app passwords)
  --quiet
  -h, --help

Examples
  node tools/playground/boot.mjs --profile core-only --port 9400 --plugin ../../x-companion --json
  node tools/playground/boot.mjs --profile core-plus-suite --posture production --plugin x-companion --json
  node tools/playground/stop.mjs --profile core-only --posture toolchain
`;

function parseArgv(argv) {
	const o = { plugins: [], muPlugins: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new BootError(`${a} needs a value`);
			return v;
		};
		switch (a) {
			case '--profile': o.profile = next(); break;
			case '--posture': o.posture = next(); break;
			case '--port': o.port = Number(next()); break;
			case '--plugin': o.plugins.push(next()); break;
			case '--mu-plugin':
			case '--muPlugin': o.muPlugins.push(next()); break;
			case '--persist': o.persist = true; break;
			case '--permalinks': o.permalinks = next(); break;
			case '--php': o.php = next(); break;
			case '--wp': o.wp = next(); break;
			case '--timeout': o.timeout = Number(next()); break;
			case '--foreground': o.foreground = true; break;
			case '--json': o.json = true; break;
			case '--quiet': o.quiet = true; break;
			case '--__daemon': o.__daemon = true; break;
			case '--boot-id': o.__bootId = next(); break;
			case '-h':
			case '--help': o.help = true; break;
			default:
				throw new BootError(`Unknown option: ${a}\n${USAGE}`);
		}
	}
	return o;
}

/** Write and wait for the flush. process.exit() truncates piped stdout otherwise. */
function out(stream, text) {
	return new Promise((resolve) => {
		if (!stream.write(text)) stream.once('drain', resolve);
		else stream.write('', resolve);
	});
}

function humanSummary(rt, extra = {}) {
	return [
		`  url        ${rt.url}`,
		`  profile    ${rt.profile}   posture ${rt.posture}   WordPress ${rt.wp_version}`,
		`  admin      ${rt.admin.user}  (administrator)`,
		`  agent      ${rt.agent.user}  (${rt.agent.role})`,
		`  pid        ${rt.pid}`,
		`  siteDir    ${rt.siteDir}`,
		`  runtime    ${runtimePath(rt.profile, rt.posture)}`,
		extra.plugins?.length ? `  plugins    ${extra.plugins.map((p) => p.pluginFile).join(', ')} (mounted live)` : null,
		'',
		`  App + wp-admin login passwords are in the runtime file (mode 0600); not printed here.`,
		`  Re-run with --json to get them on stdout.`,
		`  Stop with: node tools/playground/stop.mjs --profile ${rt.profile} --posture ${rt.posture}`,
	].filter(Boolean).join('\n');
}

async function main() {
	let o;
	try {
		o = parseArgv(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`${e.message}\n`);
		process.exit(2);
	}
	if (o.help) {
		process.stdout.write(USAGE);
		process.exit(0);
	}

	if (o.__daemon) {
		// Child: boot for real, report readiness through the ready file, stay alive.
		const profile = o.profile ?? 'core-only';
		const posture = o.posture ?? 'toolchain';
		const ready = readyPath(profile, posture);
		let inst;
		try {
			inst = await boot(o);
		} catch (err) {
			ensureDir(RUNTIME_DIR);
			fs.writeFileSync(ready, JSON.stringify({ bootId: o.__bootId, ok: false, error: err?.message ?? String(err) }));
			process.stderr.write(`[boot] FAILED: ${err?.stack ?? err}\n`);
			process.exit(1);
		}
		const runtime = JSON.parse(fs.readFileSync(runtimePath(profile, posture), 'utf8'));
		const notes = [];
		if (inst.agent_role_fallback) {
			notes.push(
				`role "x_agent" does not exist in this instance, so ${runtime.agent.user} was given ` +
				`"subscriber" instead. Capability-gating proofs that need x_agent are not meaningful ` +
				`until x-companion registers the role.`,
			);
		}
		fs.writeFileSync(ready, JSON.stringify({ bootId: o.__bootId, ok: true, runtime, notes }));
		const shutdown = async (sig) => {
			process.stderr.write(`[boot] ${sig} — shutting down ${runtimeKey(profile, posture)}\n`);
			try { await inst.stop(); } catch { /* ignore */ }
			rmrf(pidPath(profile, posture));
			rmrf(runtimePath(profile, posture));
			process.exit(0);
		};
		process.on('SIGTERM', () => shutdown('SIGTERM'));
		process.on('SIGINT', () => shutdown('SIGINT'));
		process.stderr.write(`[boot] serving ${runtime.url} (pid ${process.pid})\n`);
		return; // http server keeps the loop alive
	}

	try {
		if (o.foreground) {
			const inst = await boot(o);
			if (o.json) process.stdout.write(JSON.stringify(pick(inst)) + '\n');
			else process.stdout.write(`\nPlayground ready (foreground, Ctrl-C to stop)\n${humanSummary(inst, inst)}\n`);
			const shutdown = async () => {
				await inst.stop();
				rmrf(pidPath(inst.profile, inst.posture));
				rmrf(runtimePath(inst.profile, inst.posture));
				process.exit(0);
			};
			process.on('SIGINT', shutdown);
			process.on('SIGTERM', shutdown);
			return;
		}
		const rt = await bootDetached(o);
		if (o.json) await out(process.stdout, JSON.stringify(rt) + '\n');
		else await out(process.stdout, `\nPlayground ready (detached)\n${humanSummary(rt)}\n`);
		process.exit(0);
	} catch (err) {
		process.stderr.write(`\n[boot] ${err?.message ?? err}\n`);
		process.exit(1);
	}
}

function pick(inst) {
	return {
		url: inst.url,
		admin: inst.admin,
		agent: inst.agent,
		posture: inst.posture,
		profile: inst.profile,
		wp_version: inst.wp_version,
		pid: inst.pid,
		siteDir: inst.siteDir,
	};
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
	main();
}
