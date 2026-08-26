import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { pLimit, settleAll } from '../lib/limit.mjs';
import { screenFileMap, schemaGate } from '../lib/gates.mjs';

export const id = 'S6_schema_packages';
export const kind = 'gated-generative';

// The gate probes public-nonce routes with ONLY {_wpnonce, hp_website: '',
// title: 'Smoke sample'} — the template must warn the handler (session lesson).
const ROUTE_PROBE_NOTE = 'The gate probes public-nonce routes with ONLY {_wpnonce, hp_website: "", title: "Smoke sample"} — a handler requiring more params must treat an absent param as a 200 ping (an acknowledgement without a write), never a 400. Protected capability routes must answer 401/403 to an unauthenticated caller.';

export function toScaffoldInput(decl, runDir) {
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
        // Binding source names are kebab-case (^[a-z0-9-]+$) while the meta keys
        // they read are snake_case — the same word, spelled two ways by two tool
        // policies. Normalize the same way meta keys are normalized above.
        ...(decl.bindings ? {
            bindings: decl.bindings.map((b) => ({
                name: b.name.replace(/_/g, '-'), // tool policy: ^[a-z0-9-]+$
                meta_key: b.meta_key.replace(/-/g, '_'), // tool policy: ^[a-z0-9_]+$
                ...(b.label ? { label: b.label } : {}),
            })),
        } : {}),
        dir: join(runDir, 'packages'),
        force: true,
    };
}

export async function run(ctx) {
    ctx.state.artifacts = ctx.state.artifacts ?? {};
    ctx.state.artifacts.packages = ctx.state.artifacts.packages ?? {};
    const packages = ctx.state.brief.schema_packages ?? [];
    if (packages.length === 0) {
        ctx.log('the plan needs no data model — skipping');
        return;
    }

    const buildPackage = async (decl, index) => {
        // Scaffold first, deterministically. URL-map warnings fail PREFLIGHT —
        // before any LLM call is spent on the package (spec S6 + M4).
        const scaffold = await ctx.call('wp_schema_scaffold', toScaffoldInput(decl, ctx.runDir));
        // A package that cannot be scaffolded is a dead artifact, exactly like one
        // that fails its contract or its build test — not a reason to end the run.
        // (URL-map warnings below stay fatal on purpose: they are a preflight
        // decision about the whole site's URL space, not one artifact's health.)
        if (!scaffold.ok) {
            const failures = [{
                code: scaffold.data.code ?? 'companion_error',
                path: '/scaffold',
                message: scaffold.data.message,
            }];
            ctx.state.artifacts.packages[decl.slug] = { status: 'fail', failures, files: [] };
            ctx.log(`data model ${decl.slug}: could not even be scaffolded — dead artifact: ${scaffold.data.message}`);
            writeFileSync(join(ctx.runDir, 'packages', `${decl.slug}.json`),
                JSON.stringify({ gate: { status: 'fail', failures } }, null, 2));
            return;
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
            if (e.code !== 'contract_failed' && e.code !== 'output_truncated') throw e;
            art.failures = e.extra.issues.map((i) => ({ code: e.code, path: i.path, message: i.message }));
            writeFileSync(join(ctx.runDir, 'packages', `${decl.slug}.json`), JSON.stringify({ dir, gate: { status: 'fail', failures: art.failures } }, null, 2));
            ctx.log(`data model ${decl.slug}: the model's code never satisfied the contract — the repair stage gets one attempt`);
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
        ctx.log(gate.status === 'pass'
            ? `data model ${decl.slug}: proven in a throwaway WordPress (routes answered, uninstall left nothing behind) — install package ready`
            : `data model ${decl.slug}: failed its build test (${gate.failures.slice(0, 2).map((f) => f.message).join(' | ')}) — the repair stage gets one attempt`);
        writeFileSync(join(ctx.runDir, 'packages', `${decl.slug}.json`),
            JSON.stringify({ dir, zip_path: art.zip_path, gate, smoke: res.ok ? res.data.smoke : undefined }, null, 2));
    };

    const limiter = pLimit(ctx.config.concurrency);
    ctx.log(`building ${packages.length} data model package(s): ${packages.map((p) => p.slug).join(', ')}`);
    // settleAll: a fatal lane (e.g. budget_exceeded) never orphans the others.
    await settleAll(packages.map((p, i) => limiter(() => buildPackage(p, i))));
    const outcomes = Object.values(ctx.state.artifacts.packages);
    ctx.log(`data model: ${outcomes.filter((o) => o.status === 'pass').length} of ${outcomes.length} package(s) proven`);
}
