#!/usr/bin/env node
// x-pipeline — the one front door.
//
//   x-pipeline site new        boot a WordPress+x-companion Playground and wire the connection
//   x-pipeline site connect    connect an existing x-companion site (asks for what it needs)
//   x-pipeline site status     show connected site + Playground slots, probed live
//   x-pipeline site use        build against an already-running slot
//   x-pipeline builds          every site built here, newest first, with live/gone state
//   x-pipeline builds rm       delete build artifacts (by id, --failed/--gone/--keep/--all)
//   x-pipeline site prune      reclaim disk from stopped sites
//   x-pipeline site stop       stop a booted Playground and clear its connection
//   x-pipeline config init     write pipeline.config.json (and store a provider key)
//   x-pipeline build "<prompt>"  run the compiler S1→S9 (auto-writes config if missing)
//
// State lives only where the pipeline already reads it: .x-agent.json
// (connection + provider keys, chmod 600, gitignored), pipeline.config.json
// (task routing, gitignored), tools/.runtime (Playground descriptors).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PipelineError } from './lib/errors.mjs';
import { loadPipelineConfig, readProviderKeys } from './lib/config.mjs';
import { ask, askHidden, confirm } from './lib/prompt.mjs';
import {
    bootSite, stopSite, listSites, listBuilds, readDescriptor, mergeConnection,
    listSiteDirs, removeSiteDir, removeBuilds, formatBytes, dirSize as sizeOf, scrubConnection, readAgentConfig,
    storeProviderKey, defaultBuildConfig, pickProvider, writeBuildConfig,
    PROVIDER_DEFAULT_MODELS, PROVIDER_KEY_FIELDS, DEFAULT_SLOT, DEFAULT_PORT,
} from './lib/site.mjs';

const log = (m) => console.error(`[x-pipeline] ${m}`);

/** Tiny flag parser: `--key value` pairs, boolean flags, positionals. */
export function parseArgs(argv, { booleans = [] } = {}) {
    const flags = {};
    const positionals = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const name = a.slice(2);
            if (booleans.includes(name)) flags[name] = true;
            else flags[name] = argv[++i];
        } else {
            positionals.push(a);
        }
    }
    return { flags, positionals };
}

const HELP = `x-pipeline — deterministic, LLM-powered site compiler (specs/pipeline.spec.json)

usage:
  x-pipeline site new       [--port ${DEFAULT_PORT}] [--slot ${DEFAULT_SLOT}] [--plugin ./x-companion]
  x-pipeline site connect   [--url URL] [--user USER] [--app-password PASS]
  x-pipeline site status
  x-pipeline site use       --slot NAME                 build against an already-running slot
  x-pipeline site stop      [--slot ${DEFAULT_SLOT}] [--all] [--purge] [--yes]
  x-pipeline site prune     [--dry-run] [--yes]                reclaim disk from stopped sites
  x-pipeline builds         [--all] [--limit N]                every site built here, newest first
  x-pipeline builds rm      <run-id>… | --failed | --gone | --keep N | --all
                            [--dry-run] [--yes]                delete build artifacts
  x-pipeline config init    [--provider cerebras|gemini|anthropic|openai] [--model ID] [--key API_KEY] [--force]
  x-pipeline build "<prompt>" [--until STAGE] [--resume RUN_DIR] [--config PATH]
                              [--new-site] [--port N] [--slot NAME] [--brochure] [--no-images]
                              --brochure: composition only — no custom blocks, no data
                              packages; the brief must express every section with the
                              blocks the site already has
                              --no-images: skip image generation; the solid-colour
                              placeholder pixels stay in place (no Gemini key needed)

typical first run:
  x-pipeline config init                # picks a provider from your keys, or asks for one
  x-pipeline build "a site for …" --new-site
  # …the site stays up; iterate with more builds, stop it with: x-pipeline site stop`;

/* --------------------------------------------------------------- verification */

async function verifyConnection(conn) {
    const { createToolchain } = await import('./lib/toolchain.mjs');
    const tc = await createToolchain({ cwd: process.cwd() });
    try {
        const res = await tc.call('wp_connect', conn ?? {});
        if (!res.ok) {
            throw new PipelineError(res.data.code ?? 'companion_unreachable', res.data.message, res.data.hint ?? '');
        }
        return res.data;
    } finally {
        await tc.dispose();
    }
}

/* ------------------------------------------------------------------ commands */

async function siteNew(flags) {
    const slot = flags.slot ?? DEFAULT_SLOT;
    const port = Number(flags.port ?? DEFAULT_PORT);
    const d = await bootSite({ slot, port, plugin: flags.plugin ?? './x-companion', log });
    mergeConnection(process.cwd(), { url: d.url, user: d.admin.user, app_password: d.admin.app_password });
    const info = await verifyConnection();
    log(`site up: ${d.url} (posture ${info.posture}, WordPress ${info.wp_version}, ${info.blocks_count} blocks, fingerprint ${info.fingerprint.slice(0, 8)}…)`);
    log(`connection written to .x-agent.json; wp-admin credentials are in tools/.runtime/${slot}.json (mode 0600)`);
    log(`the site keeps running until: x-pipeline site stop${slot === DEFAULT_SLOT ? '' : ` --slot ${slot}`}`);
}

async function siteConnect(flags) {
    const url = flags.url ?? await ask('Site URL (e.g. https://staging.example.com)');
    const user = flags.user ?? await ask('WordPress user');
    const appPassword = flags['app-password'] ?? await askHidden('Application password');
    if (!url || !user || !appPassword) {
        throw new PipelineError('preflight_failed', 'url, user and application password are all required');
    }
    log(`checking ${url}…`);
    const info = await verifyConnection({ url, user, app_password: appPassword });
    if (info.posture !== 'toolchain') {
        log(`WARNING: posture is "${info.posture}" — the pipeline only builds on toolchain instances.`);
        log('Connection saved anyway (read-only tools work); builds will refuse at S2.');
    }
    mergeConnection(process.cwd(), { url, user, app_password: appPassword });
    log(`connected: ${info.site_url} (posture ${info.posture}, ${info.blocks_count} blocks, fingerprint ${info.fingerprint.slice(0, 8)}…)`);
    log('connection written to .x-agent.json (mode 0600)');
}

async function siteUse(flags) {
    const sites = listSites();
    const slot = flags.slot ?? (sites.length === 1 ? sites[0].slot : null);
    if (!slot) {
        log(sites.length === 0 ? 'no known slots — run: x-pipeline site new' : `--slot is required; known: ${sites.map((s) => s.slot).join(', ')}`);
        throw new PipelineError('preflight_failed', 'no slot chosen');
    }
    const d = readDescriptor(slot);
    if (!d?.url) {
        throw new PipelineError('preflight_failed', `no runtime descriptor for slot "${slot}"`,
            `Known slots: ${sites.map((s) => s.slot).join(', ') || '(none)'}`);
    }
    if (!await reachable(d.url)) {
        throw new PipelineError('preflight_failed', `slot "${slot}" is not responding at ${d.url}`,
            `Its holder is gone. Clear it with: x-pipeline site stop --slot ${slot}`);
    }
    mergeConnection(process.cwd(), { url: d.url, user: d.admin.user, app_password: d.admin.app_password });
    const info = await verifyConnection();
    log(`now building against slot ${slot}: ${info.site_url} (posture ${info.posture}, fingerprint ${info.fingerprint.slice(0, 8)}…)`);
}

function dirBytes(dir) {
    try {
        return statSync(dir).isDirectory() ? sizeOf(dir) : 0;
    } catch {
        return 0;
    }
}

async function reachable(url) {
    try {
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
        return res.status < 500;
    } catch {
        return false;
    }
}

async function builds(flags) {
    const all = listBuilds(process.cwd());
    if (all.length === 0) {
        log('no builds yet — run: x-pipeline build "<prompt>" --new-site');
        return;
    }
    const limit = flags.limit ? Number(flags.limit) : (flags.all ? all.length : 10);
    const shown = all.slice(0, limit);

    // A build's site is live only if something still answers at its URL.
    const live = new Map();
    for (const url of new Set(shown.map((b) => b.url).filter(Boolean))) {
        live.set(url, await reachable(url));
    }
    const slotByUrl = new Map(listSites().map((s) => [new URL('/', s.url).href, s.slot]));
    let liveCount = 0;

    for (const b of shown) {
        const isLive = Boolean(b.url && live.get(b.url));
        if (isLive) liveCount += 1;
        const slot = b.url ? slotByUrl.get(b.url) : null;
        const state = b.url
            ? (isLive ? `LIVE  ${b.url}${slot ? `  (slot ${slot})` : ''}` : `gone  (was ${b.url})`)
            : 'not published';
        log(`${b.run}  ${state}`);
        log(`    ${b.title} — ${b.status}${b.budget ? ` (S=${b.budget.S} B=${b.budget.B} P=${b.budget.P} I=${b.budget.I})` : ''}`);
        log(`    artifacts: ${b.runDir}`);
    }
    if (all.length > shown.length) log(`… ${all.length - shown.length} older build(s); --all to list them`);
    log(`${liveCount} live of ${shown.length} shown`);
    if (shown.some((b) => b.url && !live.get(b.url))) {
        log('a "gone" site was a Playground that has since stopped — its artifacts remain; rebuild with: x-pipeline build "<prompt>" --new-site');
    }
}

async function buildsRm(flags, positionals) {
    const all = listBuilds(process.cwd());
    if (all.length === 0) {
        log('no builds to remove');
        return;
    }

    let selected;
    if (positionals.length > 0) {
        const known = new Map(all.map((b) => [b.run, b]));
        const missing = positionals.filter((r) => !known.has(r));
        if (missing.length > 0) {
            throw new PipelineError('preflight_failed', `no such build(s): ${missing.join(', ')}`,
                'List them with: x-pipeline builds --all');
        }
        selected = positionals.map((r) => known.get(r));
    } else if (flags.failed) {
        selected = all.filter((b) => b.status.startsWith('failed') || b.status === 'empty');
    } else if (flags.gone) {
        const live = new Map();
        for (const url of new Set(all.map((b) => b.url).filter(Boolean))) live.set(url, await reachable(url));
        selected = all.filter((b) => !b.url || !live.get(b.url));
    } else if (flags.keep !== undefined) {
        selected = all.slice(Number(flags.keep));
    } else if (flags.all) {
        selected = all;
    } else {
        throw new PipelineError('preflight_failed', 'nothing selected',
            'Pass run ids, or one of --failed | --gone | --keep N | --all (see --help).');
    }

    if (selected.length === 0) {
        log('nothing matched — nothing removed');
        return;
    }

    // Never quietly discard the record of a site that is still serving.
    const liveChecks = new Map();
    for (const url of new Set(selected.map((b) => b.url).filter(Boolean))) {
        liveChecks.set(url, await reachable(url));
    }
    const stillLive = selected.filter((b) => b.url && liveChecks.get(b.url));
    if (stillLive.length > 0 && !flags['include-live']) {
        for (const b of stillLive) log(`keeping ${b.run} — its site is still LIVE at ${b.url}`);
        selected = selected.filter((b) => !(b.url && liveChecks.get(b.url)));
        log('(pass --include-live to remove those too; the site keeps running either way)');
        if (selected.length === 0) {
            log('nothing left to remove');
            return;
        }
    }

    const total = selected.reduce((n, b) => n + dirBytes(b.runDir), 0);
    log(`${selected.length} build(s) to remove, ${formatBytes(total)}:`);
    for (const b of selected) log(`  ${b.run}  ${b.title} — ${b.status}`);
    if (flags['dry-run']) {
        log('dry run — nothing deleted');
        return;
    }
    if (!await confirm(`Delete ${selected.length} build director(ies)?`, { assumeYes: Boolean(flags.yes) })) {
        log('cancelled');
        return;
    }
    const removed = removeBuilds(process.cwd(), selected.map((b) => b.run));
    log(`removed ${removed.length} build(s), reclaimed ${formatBytes(removed.reduce((n, r) => n + r.bytes, 0))}`);
}

async function siteStatus() {
    const sites = listSites();
    if (sites.length === 0) log('no Playground slots known to this checkout');
    let stale = 0;
    for (const s of sites) {
        // A descriptor is a claim, not proof: probe the URL. Holders can die
        // (a reaped process group, a machine sleep) and leave the file behind.
        const up = await reachable(s.url);
        if (!up) stale += 1;
        log(`slot ${s.slot}: ${s.url} — ${up ? 'LIVE' : 'NOT RESPONDING (stale descriptor; the site is gone)'}`);
    }
    if (stale > 0) log(`clear a stale slot with: x-pipeline site stop --slot <name>`);
    const cfg = readAgentConfig(process.cwd());
    if (!cfg.url) {
        log('no connection in .x-agent.json — run: x-pipeline site new (or site connect)');
        return;
    }
    try {
        const info = await verifyConnection();
        log(`connected: ${info.site_url} (posture ${info.posture}, ${info.blocks_count} blocks, fingerprint ${info.fingerprint.slice(0, 8)}…)`);
    } catch (e) {
        log(`connection in .x-agent.json points at ${cfg.url} but it is not answering (${e.code}: ${e.message})`);
    }
}

async function stopOne(slot, { port, purge }) {
    const { port: stoppedPort, url } = stopSite({ slot, ...(port ? { port: Number(port) } : {}) });
    log(`stopped slot ${slot} on port ${stoppedPort}${url ? ` (${url})` : ''}`);
    if (url && scrubConnection(process.cwd(), { onlyUrl: url })) {
        log('  cleared the matching connection from .x-agent.json (provider keys kept)');
    }
    if (purge) {
        try {
            const { bytes } = removeSiteDir(slot, { force: true });
            log(`  purged its site directory (${formatBytes(bytes)} reclaimed)`);
        } catch (e) {
            log(`  could not purge the site directory: ${e.message}`);
        }
    }
}

async function siteStop(flags) {
    if (flags.all) {
        const slots = listSites();
        if (slots.length === 0) {
            log('no slots to stop');
            return;
        }
        log(`this will stop ${slots.length} site(s) — a stopped Playground is GONE:`);
        for (const s of slots) log(`  ${s.slot}: ${s.url}`);
        if (!await confirm(`Stop all ${slots.length}?`, { assumeYes: Boolean(flags.yes) })) {
            log('cancelled');
            return;
        }
        for (const s of slots) await stopOne(s.slot, { purge: flags.purge });
        return;
    }
    await stopOne(flags.slot ?? DEFAULT_SLOT, { port: flags.port, purge: flags.purge });
}

async function sitePrune(flags) {
    const orphans = listSiteDirs().filter((s) => !s.live);
    if (orphans.length === 0) {
        log('no stopped site directories — nothing to reclaim');
        return;
    }
    const total = orphans.reduce((n, s) => n + s.bytes, 0);
    log(`${orphans.length} stopped site director(ies), ${formatBytes(total)}:`);
    for (const s of orphans) log(`  ${s.slot}  ${formatBytes(s.bytes)}`);
    if (flags['dry-run']) {
        log('dry run — nothing deleted');
        return;
    }
    if (!await confirm(`Delete these ${orphans.length} director(ies)?`, { assumeYes: Boolean(flags.yes) })) {
        log('cancelled');
        return;
    }
    let freed = 0;
    for (const s of orphans) {
        const { bytes } = removeSiteDir(s.slot);
        freed += bytes;
        log(`  removed ${s.slot}`);
    }
    log(`reclaimed ${formatBytes(freed)}`);
}

async function configInit(flags) {
    const cwd = process.cwd();
    const file = join(cwd, 'pipeline.config.json');
    if (existsSync(file) && !flags.force) {
        throw new PipelineError('preflight_failed', 'pipeline.config.json already exists', 'Pass --force to overwrite it.');
    }
    let keys = readProviderKeys(cwd);
    let provider = flags.provider ?? pickProvider(keys);
    if (!provider) {
        provider = await ask('No provider API key found. Which provider?', { fallback: 'cerebras' });
    }
    const keyField = PROVIDER_KEY_FIELDS[provider];
    if (!keyField) {
        throw new PipelineError('preflight_failed', `unknown provider "${provider}"`,
            `One of: ${Object.keys(PROVIDER_KEY_FIELDS).join(', ')}`);
    }
    if (!keys[keyField]) {
        const key = flags.key ?? await askHidden(`${keyField} for ${provider}`);
        if (!key) throw new PipelineError('preflight_failed', `${provider} needs ${keyField}`);
        storeProviderKey(cwd, keyField, key);
        log(`${keyField} stored in .x-agent.json (mode 0600)`);
        keys = readProviderKeys(cwd);
    }
    const model = flags.model ?? PROVIDER_DEFAULT_MODELS[provider];
    if (!model) {
        throw new PipelineError('preflight_failed', `no default model for ${provider}`, 'Pass --model.');
    }
    const config = defaultBuildConfig({ provider, model });
    writeBuildConfig(cwd, config);
    loadPipelineConfig(file); // self-check: what we wrote must pass preflight
    log(`wrote pipeline.config.json — every task routed to ${provider}/${model} (edit per-task any time)`);
}

async function build(flags, positionals) {
    const cwd = process.cwd();
    const prompt = positionals[0];
    if (!prompt && !flags.resume) {
        throw new PipelineError('preflight_failed', 'build needs a prompt (or --resume <run_dir>)', HELP);
    }

    // Config: write the proven default when none exists and a key is available.
    const configPath = flags.config ?? join(cwd, 'pipeline.config.json');
    if (!existsSync(configPath)) {
        const keys = readProviderKeys(cwd);
        const provider = pickProvider(keys);
        if (!provider) {
            throw new PipelineError('preflight_failed', 'no pipeline.config.json and no provider key to write one from',
                'Run: x-pipeline config init');
        }
        writeBuildConfig(cwd, defaultBuildConfig({ provider, model: PROVIDER_DEFAULT_MODELS[provider] }));
        log(`no pipeline.config.json — wrote one routing every task to ${provider}/${PROVIDER_DEFAULT_MODELS[provider]}`);
    }

    // Connection: --new-site boots one; otherwise one must already be wired.
    const agentCfg = readAgentConfig(cwd);
    const hasConnection = Boolean((agentCfg.url ?? process.env.X_WP_URL) && (agentCfg.app_password ?? process.env.X_WP_APP_PASSWORD));
    if (!hasConnection) {
        if (!flags['new-site']) {
            throw new PipelineError('preflight_failed', 'no connected site',
                'Boot one now by adding --new-site, or run: x-pipeline site new / x-pipeline site connect');
        }
        await siteNew(flags);
    } else if (flags['new-site']) {
        throw new PipelineError('preflight_failed', 'a site is already connected in .x-agent.json',
            'Drop --new-site to build there, or x-pipeline site stop first.');
    }

    const { runPipeline } = await import('./run.mjs');
    const { fmtDur } = await import('./lib/clock.mjs');
    const { runDir, state, ms } = await runPipeline({
        prompt,
        configPath: flags.config,
        resumeDir: flags.resume,
        until: flags.until,
        brochure: !!flags.brochure,
        noImages: !!flags['no-images'],
        cwd,
    });
    const front = state.published?.pages?.find((p) => p.front_page);
    log('—');
    log(`build finished in ${fmtDur(ms)}`);
    if (front) log(`site: ${front.link}`);
    log(`artifacts: ${runDir}`);
    if (existsSync(join(runDir, 'report.md'))) log(`report: ${join(runDir, 'report.md')}`);
    if (existsSync(join(runDir, 'screenshot.png'))) log(`screenshot: ${join(runDir, 'screenshot.png')}`);
}

/* --------------------------------------------------------------------- main */

export async function main(argv) {
    const [cmd, sub, ...rest] = argv;
    try {
        if (cmd === 'site' && sub === 'new') {
            const { flags } = parseArgs(rest);
            await siteNew(flags);
        } else if (cmd === 'site' && sub === 'connect') {
            const { flags } = parseArgs(rest);
            await siteConnect(flags);
        } else if (cmd === 'site' && sub === 'status') {
            await siteStatus();
        } else if (cmd === 'site' && sub === 'use') {
            const { flags } = parseArgs(rest);
            await siteUse(flags);
        } else if (cmd === 'site' && sub === 'stop') {
            const { flags } = parseArgs(rest, { booleans: ['all', 'purge', 'yes'] });
            await siteStop(flags);
        } else if (cmd === 'site' && sub === 'prune') {
            const { flags } = parseArgs(rest, { booleans: ['yes', 'dry-run'] });
            await sitePrune(flags);
        } else if (cmd === 'builds' && sub === 'rm') {
            const { flags, positionals } = parseArgs(rest, { booleans: ['all', 'failed', 'gone', 'yes', 'dry-run', 'include-live'] });
            await buildsRm(flags, positionals);
        } else if (cmd === 'builds') {
            const { flags } = parseArgs(sub === undefined ? [] : [sub, ...rest], { booleans: ['all'] });
            await builds(flags);
        } else if (cmd === 'config' && sub === 'init') {
            const { flags } = parseArgs(rest, { booleans: ['force'] });
            await configInit(flags);
        } else if (cmd === 'build') {
            const { flags, positionals } = parseArgs(sub === undefined ? [] : [sub, ...rest], { booleans: ['new-site', 'brochure', 'no-images'] });
            await build(flags, positionals);
        } else {
            console.error(HELP);
            process.exitCode = cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2;
        }
    } catch (e) {
        if (e instanceof PipelineError) {
            console.error(`[x-pipeline] ${e.code}: ${e.message}`);
            if (e.hint) console.error(`[x-pipeline] ${e.hint}`);
            process.exitCode = 1;
        } else {
            throw e;
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main(process.argv.slice(2));
}
