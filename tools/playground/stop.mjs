#!/usr/bin/env node
/**
 * stop.mjs — stop instances started by tools/playground/boot.mjs.
 *
 *   node tools/playground/stop.mjs --profile core-only --posture toolchain
 *   node tools/playground/stop.mjs --port 9402
 *   node tools/playground/stop.mjs --all
 *
 * Idempotent: stopping something that is not running is a success.
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
	RUNTIME_DIR, PROFILES, POSTURES,
	runtimeKey, runtimePath, pidPath, readPid, processAlive,
} from './boot.mjs';

const __filename = fileURLToPath(import.meta.url);

const USAGE = `
stop.mjs — stop Playground instances started by boot.mjs.

  node tools/playground/stop.mjs [options]

Options
  --profile <id>     core-only | core-plus-suite
  --posture <p>      toolchain | production
  --port <n>         stop whatever is listening on this port
  --all              stop every instance recorded in tools/.runtime (default when
                     neither --profile/--posture nor --port is given)
  --timeout <ms>     how long to wait for a clean exit before SIGKILL (default 15000)
  --json             machine-readable result
  -h, --help
`;

function parseArgv(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a} needs a value`);
			return v;
		};
		switch (a) {
			case '--profile': o.profile = next(); break;
			case '--posture': o.posture = next(); break;
			case '--port': o.port = Number(next()); break;
			case '--all': o.all = true; break;
			case '--timeout': o.timeout = Number(next()); break;
			case '--json': o.json = true; break;
			case '-h': case '--help': o.help = true; break;
			default: throw new Error(`Unknown option: ${a}\n${USAGE}`);
		}
	}
	return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function pidsOnPort(port) {
	try {
		const out = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
			encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
		});
		return [...new Set(out.split('\n').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite))];
	} catch {
		return [];
	}
}

async function killPid(pid, timeout) {
	if (!processAlive(pid)) return 'not-running';
	try { process.kill(pid, 'SIGTERM'); } catch { return 'not-running'; }
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (!processAlive(pid)) return 'stopped';
		await sleep(100);
	}
	try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
	await sleep(300);
	return processAlive(pid) ? 'still-running' : 'killed';
}

/** Stop one recorded instance. Returns a result record. */
export async function stopInstance(profile, posture, { timeout = 15000 } = {}) {
	const key = runtimeKey(profile, posture);
	const rtPath = runtimePath(profile, posture);
	let port = null;
	try {
		port = Number(new URL(JSON.parse(fs.readFileSync(rtPath, 'utf8')).url).port);
	} catch { /* runtime file may be gone */ }

	const pid = readPid(profile, posture);
	let result = 'not-running';
	if (pid) result = await killPid(pid, timeout);

	// Belt and braces: if the port is still held (e.g. the pid file was stale),
	// take out whatever is on it.
	if (port && !(await portFree(port))) {
		for (const p of pidsOnPort(port)) {
			if (p !== process.pid) await killPid(p, timeout);
		}
		result = (await portFree(port)) ? (result === 'not-running' ? 'stopped' : result) : 'port-still-held';
	}

	fs.rmSync(pidPath(profile, posture), { force: true });
	fs.rmSync(rtPath, { force: true });
	fs.rmSync(path.join(RUNTIME_DIR, `${key}.ready.json`), { force: true });
	return { key, profile, posture, pid, port, result };
}

/** Stop whatever holds a port, regardless of bookkeeping. */
export async function stopPort(port, { timeout = 15000 } = {}) {
	const results = [];
	for (const p of pidsOnPort(port)) {
		if (p === process.pid) continue;
		results.push({ pid: p, result: await killPid(p, timeout) });
	}
	// Clean up any runtime file that pointed at this port.
	for (const profile of PROFILES) {
		for (const posture of POSTURES) {
			try {
				const rt = JSON.parse(fs.readFileSync(runtimePath(profile, posture), 'utf8'));
				if (Number(new URL(rt.url).port) === port) {
					fs.rmSync(runtimePath(profile, posture), { force: true });
					fs.rmSync(pidPath(profile, posture), { force: true });
				}
			} catch { /* no such runtime */ }
		}
	}
	return { port, free: await portFree(port), killed: results };
}

export function listRecorded() {
	const out = [];
	for (const profile of PROFILES) {
		for (const posture of POSTURES) {
			const pid = readPid(profile, posture);
			const hasRt = fs.existsSync(runtimePath(profile, posture));
			if (pid || hasRt) out.push({ profile, posture, pid, alive: pid ? processAlive(pid) : false });
		}
	}
	return out;
}

async function main() {
	let o;
	try {
		o = parseArgv(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`${e.message}\n`);
		process.exit(2);
	}
	if (o.help) { process.stdout.write(USAGE); process.exit(0); }

	const timeout = o.timeout ?? 15000;
	const results = [];

	if (o.port) {
		results.push(await stopPort(o.port, { timeout }));
	} else if (o.profile || o.posture) {
		const profiles = o.profile ? [o.profile] : PROFILES;
		const postures = o.posture ? [o.posture] : POSTURES;
		for (const p of profiles) {
			for (const q of postures) {
				if (!PROFILES.includes(p)) { process.stderr.write(`Unknown profile "${p}"\n`); process.exit(2); }
				if (!POSTURES.includes(q)) { process.stderr.write(`Unknown posture "${q}"\n`); process.exit(2); }
				results.push(await stopInstance(p, q, { timeout }));
			}
		}
	} else {
		for (const { profile, posture } of listRecorded()) {
			results.push(await stopInstance(profile, posture, { timeout }));
		}
		if (results.length === 0) results.push({ result: 'nothing-recorded' });
	}

	const bad = results.some((r) => r.result === 'still-running' || r.result === 'port-still-held' || r.free === false);
	if (o.json) {
		process.stdout.write(JSON.stringify({ ok: !bad, results }, null, 2) + '\n');
	} else {
		for (const r of results) {
			process.stdout.write(
				r.port !== undefined && r.key === undefined
					? `port ${r.port}: ${r.free ? 'free' : 'STILL HELD'}${r.killed?.length ? ` (killed ${r.killed.map((k) => k.pid).join(',')})` : ''}\n`
					: `${r.key ?? '-'}: ${r.result}${r.pid ? ` (pid ${r.pid})` : ''}${r.port ? ` port ${r.port}` : ''}\n`,
			);
		}
	}
	process.exit(bad ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
	main();
}
