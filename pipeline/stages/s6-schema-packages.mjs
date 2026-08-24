import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { pLimit } from '../lib/limit.mjs';
import { screenFileMap, schemaGate } from '../lib/gates.mjs';

export const id = 'S6_schema_packages';
export const kind = 'gated-generative';

// The gate probes public-nonce routes with ONLY {_wpnonce, hp_website: '',
// title: 'Smoke sample'} — the template must warn the handler (session lesson).
const ROUTE_PROBE_NOTE = 'The gate probes public-nonce routes with ONLY {_wpnonce, hp_website: "", title: "Smoke sample"} — a handler requiring more params must treat an absent param as a 200 ping (an acknowledgement without a write), never a 400. Protected capability routes must answer 401/403 to an unauthenticated caller.';

function toScaffoldInput(decl, runDir) {
    return {
        slug: decl.slug,
        intent: decl.intent,
        post_types: decl.post_types.map((pt) => ({
            slug: pt.slug,
            label: pt.label,
            ...(pt.supports ? { supports: pt.supports } : {}),
            ...(pt.public !== undefined ? { public: pt.public } : {}),
            ...(pt.taxonomies ? { taxonomies: pt.taxonomies } : {}),
            ...(pt.meta ? {
                meta: pt.meta.map((m) => ({
                    key: m.key.replace(/-/g, '_'), // tool policy: ^[a-z0-9_]+$
                    type: m.type,
                })),
            } : {}),
        })),
        ...(decl.routes ? {
            routes: decl.routes.map((r) => ({
                path: r.path,
                ...(r.methods ? { methods: r.methods } : {}),
                auth: r.auth,
                ...(r.capability ? { capability: r.capability } : {}),
            })),
        } : {}),
        ...(decl.bindings ? { bindings: decl.bindings } : {}),
        dir: join(runDir, 'packages'),
        force: true,
    };
}

export async function run(ctx) {
    ctx.state.artifacts = ctx.state.artifacts ?? {};
    ctx.state.artifacts.packages = ctx.state.artifacts.packages ?? {};
    const packages = ctx.state.brief.schema_packages ?? [];
    if (packages.length === 0) {
        ctx.log('S6: no schema packages declared');
        return;
    }

    const buildPackage = async (decl, index) => {
        // Scaffold first, deterministically. URL-map warnings fail PREFLIGHT —
        // before any LLM call is spent on the package (spec S6 + M4).
        const scaffold = await ctx.call('wp_schema_scaffold', toScaffoldInput(decl, ctx.runDir));
        if (!scaffold.ok) {
            throw new PipelineError(scaffold.data.code ?? 'companion_error',
                `wp_schema_scaffold failed for ${decl.slug}: ${scaffold.data.message}`, scaffold.data.hint ?? '');
        }
        if ((scaffold.data.warnings ?? []).length > 0) {
            throw new PipelineError('preflight_failed',
                `schema package "${decl.slug}" has URL-map collisions: ${scaffold.data.warnings.join(' | ')}`,
                'Fix the URL map in the brief (rewrite_slug / public) — cheap now, a rebuild cycle after publish.',
                { warnings: scaffold.data.warnings });
        }
        const dir = scaffold.data.dir;
        const writable = scaffold.data.files.map((f) => f.split('/').pop()).filter((f) => f.endsWith('.php'));
        const scaffoldFiles = Object.fromEntries(writable.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
        const allowed = new Set(writable);
        const port = 9460 + index * 2; // sandbox port isolation under concurrency
        const art = { status: 'fail', failures: [], dir, files: writable, port };
        ctx.state.artifacts.packages[decl.slug] = art;

        let value;
        try {
            ({ value } = await ctx.llm.generate({
                task_type: 'schema',
                label: `schema/${decl.slug}`,
                payload: {
                    package: { slug: decl.slug, intent: decl.intent, post_types: decl.post_types, routes: decl.routes ?? [], bindings: decl.bindings ?? [] },
                    lifecycle_argument: decl.lifecycle_argument,
                    scaffold_files: scaffoldFiles,
                    route_probe_note: ROUTE_PROBE_NOTE,
                    writable_files: writable,
                },
                validate: (v) => screenFileMap(v, { allowed }),
            }));
        } catch (e) {
            if (e.code !== 'contract_failed') throw e;
            art.failures = e.extra.issues.map((i) => ({ code: 'contract_failed', path: i.path, message: i.message }));
            writeFileSync(join(ctx.runDir, 'packages', `${decl.slug}.json`), JSON.stringify({ dir, gate: { status: 'fail', failures: art.failures } }, null, 2));
            return;
        }
        for (const [name, content] of Object.entries(value.files)) {
            writeFileSync(join(dir, name), content);
        }
        const res = await ctx.call('wp_schema_build_test', { dir, port });
        const gate = schemaGate(res);
        art.status = gate.status === 'pass' ? 'pass' : 'fail';
        art.failures = gate.failures;
        if (gate.status === 'pass') art.zip_path = res.data.zip_path;
        writeFileSync(join(ctx.runDir, 'packages', `${decl.slug}.json`),
            JSON.stringify({ dir, zip_path: art.zip_path, gate, smoke: res.ok ? res.data.smoke : undefined }, null, 2));
    };

    const limiter = pLimit(ctx.config.concurrency);
    await Promise.all(packages.map((p, i) => limiter(() => buildPackage(p, i))));
    const outcomes = Object.values(ctx.state.artifacts.packages);
    ctx.log(`S6: ${outcomes.filter((o) => o.status === 'pass').length}/${outcomes.length} packages passed the factory gate`);
}
