#!/usr/bin/env node
/**
 * run.mjs — zero-setup entry point for the x-agent MCP server.
 *
 * `.mcp.json` points here so a marketplace install (a plain git clone) and a
 * release zip both start the same way:
 *
 *   - node_modules missing  -> `npm ci --omit=dev --ignore-scripts` (one-time)
 *   - dist missing          -> full `npm ci` (its prepare step runs the build)
 *   - chromium missing      -> fetched in the background; the server only
 *                              needs it at the first compile, not at startup
 *
 * MCP speaks JSON-RPC over stdout, so every bootstrap message goes to stderr
 * and npm's stdout is redirected there too. When everything is present (the
 * release zip case) this file adds one existsSync per check and nothing else.
 */
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(MCP_DIR, 'dist', 'mcp', 'src', 'server.js');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const log = (msg) => process.stderr.write(`[x-agent] ${msg}\n`);

function npm(args, why) {
    log(`${why} (one-time, this can take a minute)…`);
    const r = spawnSync(NPM, args.concat(['--no-audit', '--no-fund']), {
        cwd: MCP_DIR,
        stdio: ['ignore', 2, 2], // npm's stdout must never reach the MCP stdout
    });
    if (r.error || r.status !== 0) {
        log(`"npm ${args.join(' ')}" failed${r.error ? `: ${r.error.message}` : ''}.`);
        log(`Fix: run it yourself in ${MCP_DIR} and start the server again.`);
        process.exit(1);
    }
}

if (!existsSync(path.join(MCP_DIR, 'node_modules'))) {
    npm(['ci', '--omit=dev', '--ignore-scripts'], 'installing runtime dependencies');
}

if (!existsSync(SERVER)) {
    // Building needs the dev toolchain; npm ci's prepare step runs tsc.
    npm(['ci'], 'building the MCP server');
    if (!existsSync(SERVER)) {
        log(`build finished but ${SERVER} is still missing — run "npm run build" in ${MCP_DIR}.`);
        process.exit(1);
    }
}

// Chromium for the compile harness: idempotent, and deliberately detached —
// first startup must not block on a browser download the first tool call may
// not even need. If a compile lands before it finishes, the error says retry.
const pwCli = path.join(MCP_DIR, 'node_modules', 'playwright', 'cli.js');
if (existsSync(pwCli)) {
    spawn(process.execPath, [pwCli, 'install', 'chromium'], {
        cwd: MCP_DIR,
        stdio: 'ignore',
        detached: true,
    }).unref();
}

const child = spawn(process.execPath, [SERVER], { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
