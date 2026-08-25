// S3b — the juniors. One narrow call per molecule turns a recipe the kit
// already decided into a real TreeIR fragment, which is compiled by the site's
// own save() functions and saved back as a registered block pattern.
//
// After this stage the design system is not a document. It is vocabulary the
// instance holds: wp_patterns lists it, the section calls assemble from it, and
// a site editor can reach for it in the inserter.
//
// Generation is concurrent. SAVING IS NOT: every wp_pattern_save moves the
// epoch, and the epoch is the only serialization point (wp-blocks R12).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { pLimit } from '../lib/limit.mjs';
import { screenTreeDiagnostics, screenTreeLiterals, localTreeCheck } from '../lib/gates.mjs';
import { resolveBandColors } from '../lib/tokens.mjs';
import { kitId, patternSlug } from '../lib/kit.mjs';
import { sliceManifest } from '../lib/instance.mjs';

export const id = 'S3b_molecules';
export const kind = 'gated-generative';

export async function run(ctx) {
    const brief = ctx.state.brief;
    const { molecules } = JSON.parse(readFileSync(join(ctx.runDir, 'molecules.json'), 'utf8'));
    const tokens = JSON.parse(readFileSync(join(ctx.runDir, 'tokens.json'), 'utf8'));
    const epoch = ctx.state.fingerprint;
    const kit_id = kitId(brief);

    const tokenSlugs = {
        palette: tokens.palette.map((p) => p.slug),
        spacing: tokens.spacing.steps.map((s) => s.slug),
        font_sizes: tokens.typography.sizes.map((s) => s.slug),
        font_families: tokens.typography.families.map((f) => f.slug),
    };
    // The manifest slice a molecule sees is its role's, exactly as a section's
    // is: the recipe already names the blocks, and a wider slice is a wider
    // invitation to redesign.
    const manifestBlocks = JSON.parse(readFileSync(join(ctx.runDir, 'manifest-blocks.json'), 'utf8'));

    ctx.state.artifacts = ctx.state.artifacts ?? {};
    ctx.state.artifacts.molecules = ctx.state.artifacts.molecules ?? {};

    const built = [];
    const runMolecule = async (m) => {
        const band = m.style_refs?.background_palette_slug ?? 'base';
        const payload = {
            molecule: m,
            art_direction: brief.art_direction,
            band_colors: resolveBandColors(band, brief.palette, tokens.palette),
            manifest_slice: sliceManifest(manifestBlocks, { role: m.role }, brief),
            token_slugs: tokenSlugs,
            epoch,
        };
        let tree;
        try {
            ({ value: tree } = await ctx.llm.generate({
                task_type: 'molecule',
                label: m.id,
                payload,
                validate: (v) => {
                    const issues = localTreeCheck(v, { epoch });
                    if (issues.length > 0) return issues;
                    return screenTreeLiterals(v).map((f) => ({ path: f.path, message: f.message }));
                },
            }));
        } catch (e) {
            if (e.code !== 'contract_failed' && e.code !== 'output_truncated') throw e;
            const gate = { status: 'fail', failures: e.extra.issues.map((i) => ({ code: e.code, path: i.path, message: i.message })) };
            writeFileSync(join(ctx.runDir, 'molecules', `${m.id}.json`), JSON.stringify({ molecule: m, tree: null, gate }, null, 2));
            ctx.state.artifacts.molecules[m.id] = gate;
            ctx.log(`molecule ${m.id}: the model's output never satisfied the contract — the repair stage gets one attempt`);
            return;
        }

        // A molecule is core vocabulary: an atom is a recomposition or a
        // registered block style (ladder rungs 1-2), never a new block, so
        // nothing here may defer an unknown agent/ block the way a section can.
        const res = await ctx.call('wp_validate', tree);
        if (!res.ok) {
            throw new PipelineError(res.data.code ?? 'companion_error', `wp_validate errored for molecule ${m.id}: ${res.data.message}`, res.data.hint ?? '');
        }
        const screen = screenTreeDiagnostics(res.data, { allowedUnknown: new Set() });
        const literals = screenTreeLiterals(tree);
        const failures = [...screen.failures, ...literals];
        const gate = { status: failures.length === 0 ? 'pass' : 'fail', failures, diagnostics: res.data.diagnostics };
        writeFileSync(join(ctx.runDir, 'molecules', `${m.id}.json`), JSON.stringify({ molecule: m, tree, gate }, null, 2));
        ctx.state.artifacts.molecules[m.id] = { status: gate.status, failures };
        if (gate.status !== 'pass') {
            ctx.log(`molecule ${m.id}: failed its gate (${failures.slice(0, 2).map((f) => f.code ?? 'literal_value').join(', ')}) — the repair stage gets one attempt`);
            return;
        }
        built.push({ molecule: m, tree });
        ctx.log(`molecule ${m.id}: validated against the site, slugs only`);
    };

    const limiter = pLimit(ctx.config.concurrency);
    ctx.log(`building ${molecules.length} reusable arrangement(s), up to ${Math.min(ctx.config.concurrency, molecules.length)} at a time`);
    await Promise.all(molecules.map((m) => limiter(() => runMolecule(m))));

    // ---- the serialization point -------------------------------------------
    // Compile and save one at a time, adopting the returned fingerprint before
    // the next. Concurrency here would race the epoch against itself.
    built.sort((a, b) => a.molecule.id.localeCompare(b.molecule.id)); // deterministic save order
    const saved = [];
    for (const { molecule, tree } of built) {
        const stamped = { ...tree, epoch: ctx.state.fingerprint };
        const compiled = await ctx.call('wp_compile', stamped);
        if (!compiled.ok) {
            throw new PipelineError(compiled.data.code ?? 'companion_error',
                `wp_compile failed for molecule ${molecule.id}: ${compiled.data.message}`, compiled.data.hint ?? '');
        }
        if (compiled.data.all_valid !== true) {
            ctx.state.artifacts.molecules[molecule.id] = { status: 'fail', failures: [{ code: 'compile', message: 'wp_compile not all_valid' }] };
            ctx.log(`molecule ${molecule.id}: the site's own save() would not accept it — dropped from the vocabulary`);
            continue;
        }
        const slug = patternSlug(kit_id, molecule.id);
        const save = await ctx.call('wp_pattern_save', {
            slug,
            title: molecule.when_to_use.replace(/\.$/, '').slice(0, 60),
            content: compiled.data.markup,
            description: molecule.when_to_use,
        });
        if (!save.ok) {
            throw new PipelineError(save.data.code ?? 'companion_error',
                `wp_pattern_save failed for ${slug}: ${save.data.message}`, save.data.hint ?? '', { envelope: save.data });
        }
        // R3: the save moved the world; adopt the new epoch before the next one.
        ctx.state.fingerprint = save.data.fingerprint;
        ctx.state.instance.fingerprint = save.data.fingerprint;
        saved.push({ id: molecule.id, role: molecule.role, pattern: save.data.saved ?? slug, replaced: save.data.replaced === true });
        writeFileSync(join(ctx.runDir, 'molecules', `${molecule.id}.markup.html`), compiled.data.markup);
    }

    ctx.state.kit = { ...(ctx.state.kit ?? {}), kit_id, saved };
    writeFileSync(join(ctx.runDir, 'instance.json'), JSON.stringify(ctx.state.instance, null, 2));
    writeFileSync(join(ctx.runDir, 'molecules.json'), JSON.stringify({ molecules, saved }, null, 2));
    if (saved.length === 0) {
        throw new PipelineError('gate_failed',
            'no molecule survived its gate — the site has no design vocabulary to assemble from',
            'Every section would fall back to inventing its own layout, which is the failure this stage exists to prevent.',
            { molecules: ctx.state.artifacts.molecules });
    }
    ctx.log(`vocabulary saved: ${saved.length} of ${molecules.length} arrangement(s) registered as patterns (${saved.map((s) => s.pattern).join(', ')}); fingerprint now ${String(ctx.state.fingerprint).slice(0, 8)}…`);
}
