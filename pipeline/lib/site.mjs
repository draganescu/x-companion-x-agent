// Site and config management for the CLI: boot a companion Playground and wire
// the connection, connect an existing x-companion site, write pipeline.config.json.
// All state lives in the two files the pipeline already reads (.x-agent.json,
// pipeline.config.json) plus tools/.runtime — no new state anywhere.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, openSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineError } from './errors.mjs';
import { TASK_TYPES } from './config.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HOLDER = join(REPO_ROOT, 'pipeline', 'lib', 'site-holder.mjs');
const RUNTIME_DIR = join(REPO_ROOT, 'tools', '.runtime');

export const DEFAULT_SLOT = 'x-pipeline';
export const DEFAULT_PORT = 9430;

/* ------------------------------------------------------------ .x-agent.json */

export function readAgentConfig(cwd) {
    try {
        return JSON.parse(readFileSync(join(cwd, '.x-agent.json'), 'utf8'));
    } catch {
        return {};
    }
}

function writeAgentConfig(cwd, cfg) {
    const file = join(cwd, '.x-agent.json');
    writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
    chmodSync(file, 0o600);
}

/** Merge a site connection into .x-agent.json, preserving provider keys. */
export function mergeConnection(cwd, { url, user, app_password }) {
    const cfg = readAgentConfig(cwd);
    Object.assign(cfg, { url, user, app_password });
    writeAgentConfig(cwd, cfg);
    return cfg;
}

/** Remove the connection (keys stay). Optionally only if it points at `url`. */
export function scrubConnection(cwd, { onlyUrl } = {}) {
    const cfg = readAgentConfig(cwd);
    if (onlyUrl && cfg.url !== onlyUrl) return false;
    let had = false;
    for (const k of ['url', 'site_url', 'user', 'app_password']) {
        if (k in cfg) { delete cfg[k]; had = true; }
    }
    if (had) writeAgentConfig(cwd, cfg);
    return had;
}

/** Store a provider API key in .x-agent.json. */
export function storeProviderKey(cwd, field, value) {
    const cfg = readAgentConfig(cwd);
    cfg[field] = value;
    writeAgentConfig(cwd, cfg);
}

/* ------------------------------------------------------ pipeline.config.json */

export const PROVIDER_DEFAULT_MODELS = {
    cerebras: 'gpt-oss-120b',
    gemini: 'gemini-flash-latest',
    anthropic: 'claude-opus-5',
};

export const PROVIDER_KEY_FIELDS = {
    cerebras: 'cerebras_api_key',
    gemini: 'gemini_api_key',
    anthropic: 'anthropic_api_key',
    openai: 'openai_api_key',
};

// The temperature set every accepted milestone ran with.
const PROVEN_TEMPS = { brief: 0.5, tokens: 0.4, tree: 0.3, block: 0.2, schema: 0.2, repair: 0.2 };

export function defaultBuildConfig({ provider, model }) {
    const tasks = Object.fromEntries(TASK_TYPES.map((t) => [t, { provider, model, temperature: PROVEN_TEMPS[t] }]));
    return { tasks, concurrency: 3, budget_hard_cap: 80 };
}

/** Pick the provider to route to, preferring ones whose key is already present. */
export function pickProvider(keys) {
    for (const p of ['cerebras', 'gemini', 'anthropic', 'openai']) {
        if (keys[PROVIDER_KEY_FIELDS[p]]) return p;
    }
    return null;
}

export function writeBuildConfig(cwd, config) {
    const file = join(cwd, 'pipeline.config.json');
    writeFileSync(file, `${JSON.stringify(config, null, 4)}\n`);
    return file;
}

/* ----------------------------------------------------------------- boot/stop */

function descriptorPath(slot) {
    return join(RUNTIME_DIR, `${slot}.json`);
}

export function readDescriptor(slot) {
    try {
        return JSON.parse(readFileSync(descriptorPath(slot), 'utf8'));
    } catch {
        return null;
    }
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Boot a companion Playground on its own slot, detached, and wait for it.
 * The holder process keeps the site alive until `stopSite`.
 */
export async function bootSite({ slot = DEFAULT_SLOT, port = DEFAULT_PORT, plugin = './x-companion', timeoutMs = 240_000, log = () => {} } = {}) {
    const existing = readDescriptor(slot);
    if (existing && existing.pid && pidAlive(existing.pid)) {
        throw new PipelineError('preflight_failed', `slot "${slot}" already runs a site at ${existing.url}`,
            `Reuse it (x-pipeline site status), or stop it first (x-pipeline site stop --slot ${slot}).`);
    }
    rmSync(descriptorPath(slot), { force: true });
    const logPath = join(RUNTIME_DIR, `${slot}.boot.log`);
    const out = openSync(logPath, 'a');
    const child = spawn(process.execPath, [HOLDER, 'hold', slot, String(port), plugin], {
        cwd: REPO_ROOT,
        detached: true,
        stdio: ['ignore', out, out],
    });
    child.unref();
    log(`booting WordPress + x-companion on port ${port} (slot ${slot})…`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const d = readDescriptor(slot);
        if (d?.url) return d;
        if (child.exitCode !== null && child.exitCode !== 0) break;
        await new Promise((r) => setTimeout(r, 2000));
    }
    const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').slice(-12).join('\n') : '';
    throw new PipelineError('preflight_failed', `the site did not come up within ${Math.round(timeoutMs / 1000)}s`,
        `Boot log tail (${logPath}):\n${tail}`);
}

export function stopSite({ slot = DEFAULT_SLOT, port } = {}) {
    const d = readDescriptor(slot);
    const targetPort = port ?? (d?.url ? Number(new URL(d.url).port) : DEFAULT_PORT);
    const res = spawnSync(process.execPath, [join(REPO_ROOT, 'tools', 'playground', 'stop.mjs'), '--port', String(targetPort)], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    rmSync(descriptorPath(slot), { force: true });
    rmSync(join(RUNTIME_DIR, `${slot}.boot.log`), { force: true });
    rmSync(join(RUNTIME_DIR, `${slot}.pid`), { force: true });
    return { port: targetPort, url: d?.url ?? null, output: (res.stdout ?? '').trim() };
}

/** Every runtime descriptor with a live holder — for `site status`. */
export function listSites() {
    let files = [];
    try {
        files = readdirSync(RUNTIME_DIR).filter((f) => f.endsWith('.json'));
    } catch {
        return [];
    }
    const sites = [];
    for (const f of files) {
        try {
            const d = JSON.parse(readFileSync(join(RUNTIME_DIR, f), 'utf8'));
            if (d?.url) sites.push({ slot: f.replace(/\.json$/, ''), url: d.url, pid: d.pid ?? null, alive: d.pid ? pidAlive(d.pid) : null });
        } catch {
            // unreadable descriptor: skip
        }
    }
    return sites;
}
