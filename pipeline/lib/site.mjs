// Site and config management for the CLI: boot a companion Playground and wire
// the connection, connect an existing x-companion site, write pipeline.config.json.
// All state lives in the two files the pipeline already reads (.x-agent.json,
// pipeline.config.json) plus tools/.runtime — no new state anywhere.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, chmodSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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
// The temperature set every accepted milestone ran with.
const PROVEN_TEMPS = { brief: 0.5, tokens: 0.4, tree: 0.3, block: 0.2, schema: 0.2, repair: 0.2 };

// Anthropic's current models removed the sampling parameters outright — sending a
// temperature is a 400, not a nudge. Steer those with the prompt and `effort`.
const NO_TEMPERATURE = new Set(['anthropic']);

export function defaultBuildConfig({ provider, model }) {
    const tasks = Object.fromEntries(TASK_TYPES.map((t) => [t, {
        provider,
        model,
        ...(NO_TEMPERATURE.has(provider) ? {} : { temperature: PROVEN_TEMPS[t] }),
    }]));
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
    // tools/.runtime is gitignored runtime state: a fresh clone or a linked
    // worktree does not have it yet, and openSync will not create directories.
    mkdirSync(RUNTIME_DIR, { recursive: true });
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

/* --------------------------------------------------------------------- builds */

/**
 * Every build this checkout has made, newest first: one record per runs/<ts>
 * directory. Sites themselves are ephemeral (a stopped Playground slot takes
 * its WordPress with it) — the run directory is the durable artifact.
 */
export function listBuilds(cwd) {
    let dirs = [];
    try {
        dirs = readdirSync(join(cwd, 'runs')).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort().reverse();
    } catch {
        return [];
    }
    const builds = [];
    for (const dir of dirs) {
        const runDir = join(cwd, 'runs', dir);
        const readJson = (f) => {
            try {
                return JSON.parse(readFileSync(join(runDir, f), 'utf8'));
            } catch {
                return null;
            }
        };
        const state = readJson('state.json') ?? {};
        const brief = readJson('brief.json');
        const front = state.published?.pages?.find((p) => p.front_page);
        const completed = state.completed ?? [];
        builds.push({
            run: dir,
            runDir,
            title: brief?.identity?.site_title ?? '(no brief)',
            prompt: state.prompt ?? '',
            url: front ? new URL('/', front.link).href : null,
            status: state.failure
                ? `failed at ${completed.length ? completed[completed.length - 1] : 'start'}: ${state.failure.code}`
                : completed.includes('S9_verify') ? 'verified'
                    : completed.length ? `stopped after ${completed[completed.length - 1]}` : 'empty',
            budget: state.budget ?? null,
        });
    }
    return builds;
}

/* -------------------------------------------------------------------- removal */

/** Refuse to delete anything outside a known parent — an rm -rf needs a fence. */
function assertInside(parent, target) {
    const p = resolve(parent);
    const t = resolve(target);
    if (t === p || !t.startsWith(`${p}${sep}`)) {
        throw new PipelineError('preflight_failed', `refusing to delete ${t}: outside ${p}`);
    }
}

/**
 * Playground site directories on disk, one per slot. A stopped site leaves its
 * whole WordPress behind (~120MB) — `live` marks the ones a holder still owns.
 */
export function listSiteDirs() {
    const sitesDir = join(RUNTIME_DIR, 'sites');
    let names = [];
    try {
        names = readdirSync(sitesDir);
    } catch {
        return [];
    }
    const liveSlots = new Set(listSites().filter((s) => s.alive !== false).map((s) => s.slot));
    return names.map((slot) => ({
        slot,
        dir: join(sitesDir, slot),
        live: liveSlots.has(slot),
        bytes: dirSize(join(sitesDir, slot)),
    }));
}

export function dirSize(dir) {
    let total = 0;
    let stack = [dir];
    while (stack.length > 0) {
        const cur = stack.pop();
        let entries = [];
        try {
            entries = readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const p = join(cur, e.name);
            if (e.isDirectory()) stack.push(p);
            else {
                try {
                    total += statSync(p).size;
                } catch {
                    // vanished mid-walk: ignore
                }
            }
        }
    }
    return total;
}

/** Delete one slot's site directory and its runtime files. Never a live slot. */
export function removeSiteDir(slot, { force = false } = {}) {
    const entry = listSiteDirs().find((s) => s.slot === slot);
    if (!entry) throw new PipelineError('preflight_failed', `no site directory for slot "${slot}"`);
    if (entry.live && !force) {
        throw new PipelineError('preflight_failed', `slot "${slot}" is still running`,
            `Stop it first: x-pipeline site stop --slot ${slot}`);
    }
    assertInside(join(RUNTIME_DIR, 'sites'), entry.dir);
    rmSync(entry.dir, { recursive: true, force: true });
    for (const f of [`${slot}.json`, `${slot}.pid`, `${slot}.boot.log`, `${slot}.log`, `${slot}.ready.json`]) {
        rmSync(join(RUNTIME_DIR, f), { force: true });
    }
    return { slot, bytes: entry.bytes };
}

/** Delete build artifact directories. Returns what was removed. */
export function removeBuilds(cwd, runs) {
    const runsRoot = join(cwd, 'runs');
    const removed = [];
    for (const run of runs) {
        const dir = join(runsRoot, run);
        assertInside(runsRoot, dir);
        if (!existsSync(dir)) continue;
        const bytes = dirSize(dir);
        rmSync(dir, { recursive: true, force: true });
        removed.push({ run, bytes });
    }
    return removed;
}

export function formatBytes(n) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}GB`;
    if (n >= 1e6) return `${Math.round(n / 1e6)}MB`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}KB`;
    return `${n}B`;
}
