import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { screenTreeDiagnostics, screenTreeLiterals, localTreeCheck, screenFileMap, screenBlockCss, blockGate, schemaGate, screenImageGeometry, screenBandRoot, screenTreeInk, substituteInk, screenContentParity } from '../lib/gates.mjs';
import { normalizeTreeBorders } from '../lib/normalize.mjs';
import { pLimit, settleAll } from '../lib/limit.mjs';

export const id = 'S7_repair';
export const kind = 'generative';

// S7 owns the ONLY repair lane: at most one repair call per failed artifact,
// through the SAME gate the original stage used. A second failure is a dead
// artifact — recorded with diagnostics, its slot substituted (trees -> the
// pattern baseline) or dropped (blocks/packages, with referencing trees
// re-gated). The pipeline never improvises.

function baselineFor(ctx, key) {
    const entry = JSON.parse(readFileSync(join(ctx.runDir, 'sections', `${key}.json`), 'utf8'));
    if (entry.pattern?.parsed_tree) return entry.pattern.parsed_tree;
    // No pattern matched this role at S2 time: the minimal honest slot. Even
    // the floor is a proper band — align full, constrained inner — so a
    // degraded slot never ships clamped to the content column.
    const title = entry.section.id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return [{
        name: 'core/group',
        attributes: { align: 'full', layout: { type: 'constrained' } },
        innerBlocks: [
            { name: 'core/heading', attributes: { content: title }, innerBlocks: [] },
            { name: 'core/paragraph', attributes: { content: entry.section.copy_notes }, innerBlocks: [] },
        ],
    }];
}

function minimalSlot(ctx, key) {
    const entry = JSON.parse(readFileSync(join(ctx.runDir, 'sections', `${key}.json`), 'utf8'));
    const title = entry.section.id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return [{
        name: 'core/group',
        attributes: { align: 'full', layout: { type: 'constrained' } },
        innerBlocks: [
            { name: 'core/heading', attributes: { content: title }, innerBlocks: [] },
            { name: 'core/paragraph', attributes: { content: entry.section.copy_notes }, innerBlocks: [] },
        ],
    }];
}

// Baselines are gated too: a token-shifted world can invalidate a theme
// pattern. A pattern baseline that fails wp_validate degrades to the minimal
// honest slot (core blocks only) — never bypassed, never improvised.
async function substituteBaseline(ctx, key, palette) {
    let blocks = baselineFor(ctx, key);
    let tree = { version: 1, epoch: ctx.state.fingerprint, blocks };
    const gate = await gateTree(ctx, tree, new Set(), palette);
    if (gate.status !== 'pass') {
        blocks = minimalSlot(ctx, key);
        tree = { version: 1, epoch: ctx.state.fingerprint, blocks };
    }
    writeFileSync(join(ctx.runDir, 'trees', `${key}.json`), JSON.stringify({ tree, gate: { status: 'baseline' } }, null, 2));
}

// The rescue before the baseline: when the model's repair also failed, swap
// each failing DECLARED ink for the palette's closest compliant slug and
// re-gate. Deterministic, recorded, never a model call — and strictly less
// destructive than replacing the whole designed section with a stock pattern.
async function rescueInk(ctx, key, art, allowedUnknown, palette) {
    if (palette.length === 0) return false;
    let rec;
    try {
        rec = JSON.parse(readFileSync(join(ctx.runDir, 'trees', `${key}.json`), 'utf8'));
    } catch {
        return false;
    }
    if (!rec.tree) return false; // no artifact ever satisfied the contract — nothing to rescue
    const tree = structuredClone(rec.tree);
    const changes = substituteInk(tree, palette);
    if (changes.length === 0) return false; // the failures were never ink-shaped
    const gate = await gateTree(ctx, tree, allowedUnknown, palette);
    if (gate.status !== 'pass') return false;
    writeFileSync(join(ctx.runDir, 'trees', `${key}.json`),
        JSON.stringify({ tree, gate: { ...gate, ink_substituted: changes } }, null, 2));
    art.deferred = gate.deferred;
    art.failures = [];
    art.ink_substituted = changes;
    return true;
}

async function gateTree(ctx, tree, allowedUnknown, palette = []) {
    const res = await ctx.call('wp_validate', tree);
    if (!res.ok) {
        return { status: 'fail', deferred: [], failures: [{ code: res.data.code ?? 'companion_error', message: res.data.message }] };
    }
    const screen = screenTreeDiagnostics(res.data, { allowedUnknown });
    // The same ink floor the authoring lane enforced: a repair or a rescued
    // tree must not sneak an unreadable pair past the gate it was born under.
    const ink = screenTreeInk(tree, { palette }).failures;
    screen.failures = [...screen.failures, ...ink];
    // And the same compile-parity gate: a repaired tree that still carries its
    // content in a sourced attribute the save() ignores must die HERE, with
    // the loss named, not publish an empty block at S8. A deferred tree
    // cannot compile before its block installs; S8 compiles it instead.
    if (screen.failures.length === 0 && screen.deferred.length === 0) {
        const compiled = await ctx.call('wp_compile', tree);
        if (!compiled.ok) {
            screen.failures.push({ code: compiled.data.code ?? 'companion_error', message: compiled.data.message });
        } else {
            screen.failures = [...screen.failures, ...screenContentParity(compiled.data)];
        }
    }
    screen.status = screen.failures.length === 0 ? 'pass' : 'fail';
    return screen;
}

function writeFiles(dir, files) {
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content);
    }
}

async function repairOnce(ctx, kind, key, art, { allowedUnknown, palette = [] }) {
    let artifact;
    let validate;
    if (kind === 'trees') {
        const rec = JSON.parse(readFileSync(join(ctx.runDir, 'trees', `${key}.json`), 'utf8'));
        artifact = rec.tree;
        // The SAME gate the authoring lane used (spec: through the same gate) —
        // shape first, then the literal and ink screens a repair must not sneak past.
        validate = (v) => {
            const issues = localTreeCheck(v, { epoch: ctx.state.fingerprint });
            if (issues.length > 0) return issues;
            const band = screenBandRoot(v);
            if (band.length > 0) return band.map((f) => ({ path: f.path, message: f.message }));
            const literals = screenTreeLiterals(v).map((f) => ({ path: f.path, message: f.message }));
            if (literals.length > 0) return literals;
            const ink = screenTreeInk(v, { palette }).failures;
            if (ink.length > 0) return ink.map((f) => ({ path: f.path, message: f.message }));
            return screenImageGeometry(v).map((f) => ({ path: f.path, message: f.message }));
        };
    } else {
        artifact = { files: Object.fromEntries((art.files ?? []).map((f) => [f, readFileSync(join(art.dir, f), 'utf8')])) };
        validate = (v) => {
            const issues = screenFileMap(v, { allowed: new Set(art.files ?? []) });
            if (issues.length > 0) return issues;
            // Blocks only: a repair must not sneak a root repaint past the
            // inheritance screen the authoring lane used.
            return kind === 'blocks' ? screenBlockCss(v) : [];
        };
    }
    let value;
    try {
        ({ value } = await ctx.llm.generate({
            task_type: 'repair',
            label: `${kind}/${key}`,
            payload: {
                artifact,
                diagnostics: art.failures,
                original_payload_note: kind === 'trees'
                    ? `The artifact is one page section (TreeIR, epoch "${ctx.state.fingerprint}"). Keep the section's content and design; fix only what the diagnostics name.`
                    : `The artifact is the writable file set of a scaffolded ${kind === 'blocks' ? 'dynamic block' : 'schema package'}. Return the full corrected file map.`,
            },
            validate,
            maxAttempts: 1, // a malformed repair is a dead artifact, not another retry
        }));
    } catch (e) {
        if (e.code === 'contract_failed' || e.code === 'budget_exceeded') {
            if (e.code === 'budget_exceeded') throw e;
            return false;
        }
        throw e;
    }

    if (kind === 'trees') {
        normalizeTreeBorders(value);
        const gate = await gateTree(ctx, value, allowedUnknown, palette);
        if (gate.status !== 'pass') {
            art.failures = [...art.failures, ...gate.failures];
            return false;
        }
        writeFileSync(join(ctx.runDir, 'trees', `${key}.json`), JSON.stringify({ tree: value, gate: { ...gate, repaired: true } }, null, 2));
        art.deferred = gate.deferred;
        art.failures = []; // the gate passed: the old diagnostics no longer describe this artifact
        return true;
    }
    writeFiles(art.dir, value.files);
    if (kind === 'blocks') {
        const res = await ctx.call('wp_block_build_test', { dir: art.dir, ...(art.sample_attributes ? { sample_attributes: art.sample_attributes } : {}), ...(art.port ? { port: art.port } : {}) });
        const gate = blockGate(res);
        if (gate.status !== 'pass') {
            art.failures = [...art.failures, ...gate.failures];
            return false;
        }
        art.zip_path = res.data.zip_path;
        art.failures = []; // the gate passed: the old diagnostics no longer describe this artifact
        art.style_advisories = gate.warnings ?? [];
        writeFileSync(join(ctx.runDir, 'blocks', `${key}.json`), JSON.stringify({ dir: art.dir, zip_path: art.zip_path, gate: { ...gate, repaired: true } }, null, 2));
        return true;
    }
    const res = await ctx.call('wp_schema_build_test', { dir: art.dir, ...(art.port ? { port: art.port } : {}) });
    const gate = schemaGate(res);
    if (gate.status !== 'pass') {
        art.failures = [...art.failures, ...gate.failures];
        return false;
    }
    art.zip_path = res.data.zip_path;
    art.failures = []; // the gate passed: the old diagnostics no longer describe this artifact
    writeFileSync(join(ctx.runDir, 'packages', `${key}.json`), JSON.stringify({ dir: art.dir, zip_path: art.zip_path, gate: { ...gate, repaired: true } }, null, 2));
    return true;
}

export async function run(ctx) {
    const arts = ctx.state.artifacts ?? {};
    ctx.state.dead = ctx.state.dead ?? [];
    const declared = new Set((ctx.state.brief.custom_blocks ?? []).map((b) => `agent/${b.slug}`));
    let palette = [];
    try {
        palette = JSON.parse(readFileSync(join(ctx.runDir, 'tokens.json'), 'utf8')).palette ?? [];
    } catch { /* a pre-tokens run dir — the ink screens no-op on an empty palette */ }

    // Repairs fan out like the stages that made the artifacts: each build test
    // already owns a distinct sandbox port from S5/S6, wp_validate is read-only
    // at a fixed fingerprint, and nothing here moves the epoch. What stays
    // ordered is the BARRIER between phases — block/package deaths decide what
    // trees may defer to, so every factory repair settles before any tree runs.
    const limiter = pLimit(ctx.config.concurrency);

    // Blocks and packages first: their deaths change what trees may defer to.
    const factoryRepairs = [];
    for (const kind of ['blocks', 'packages']) {
        for (const [key, art] of Object.entries(arts[kind] ?? {})) {
            if (art.status !== 'fail') continue;
            // An artifact that never scaffolded has no writable file set, so a
            // file-map repair has nothing to repair and nothing to validate
            // against — it can only burn a metered call to produce a dead one.
            const what = kind === 'blocks' ? 'block' : 'data model';
            if (!art.dir || (art.files ?? []).length === 0) {
                art.status = 'dead';
                ctx.state.dead.push({ kind, key, diagnostics: art.failures });
                ctx.log(`${what} ${key}: never scaffolded, so there is nothing to repair — staying dead (no call spent)`);
                continue;
            }
            factoryRepairs.push(limiter(async () => {
                ctx.log(`${what} ${key}: repairing — one model call, judged by the same build test`);
                const repaired = await repairOnce(ctx, kind, key, art, { allowedUnknown: declared });
                if (repaired) {
                    art.status = 'repaired';
                    ctx.log(`${what} ${key}: repaired — the build test passed this time`);
                } else {
                    art.status = 'dead';
                    ctx.state.dead.push({ kind, key, diagnostics: art.failures });
                    ctx.log(`${what} ${key}: the repair failed too — dead artifact, dropped from the plan`);
                }
            }));
        }
    }
    await settleAll(factoryRepairs); // every lane settles before a failure is fatal — no orphans
    const deadBlocks = new Set(Object.entries(arts.blocks ?? {})
        .filter(([, a]) => a.status === 'dead')
        .map(([k]) => `agent/${k}`));
    const survivingUnknown = new Set([...declared].filter((n) => !deadBlocks.has(n)));

    const treeRepairs = [];
    for (const [key, art] of Object.entries(arts.trees ?? {})) {
        if (art.status === 'fail') {
            treeRepairs.push(limiter(async () => {
                ctx.log(`section ${key}: repairing — one model call, judged by the same validation`);
                const repaired = await repairOnce(ctx, 'trees', key, art, { allowedUnknown: survivingUnknown, palette });
                if (repaired) {
                    art.status = 'repaired';
                    ctx.log(`section ${key}: repaired — validation passed this time`);
                } else if (await rescueInk(ctx, key, art, survivingUnknown, palette)) {
                    art.status = 'repaired';
                    ctx.log(`section ${key}: the repair failed but the defect was ink — swapped ${art.ink_substituted.map((c) => `${c.from}→${c.to}`).join(', ')} deterministically; the gate passed and the designed section survives`);
                } else {
                    art.status = 'baseline';
                    await substituteBaseline(ctx, key, palette);
                    ctx.state.dead.push({ kind: 'trees', key, diagnostics: art.failures });
                    ctx.log(`section ${key}: the repair failed too — publishing the theme's stock pattern in that slot instead`);
                }
            }));
        } else if ((art.deferred ?? []).some((n) => deadBlocks.has(n))) {
            // The block this tree waited for is dead: re-gate without it (spec: re-gated).
            treeRepairs.push(limiter(async () => {
                const rec = JSON.parse(readFileSync(join(ctx.runDir, 'trees', `${key}.json`), 'utf8'));
                const gate = await gateTree(ctx, rec.tree, survivingUnknown, palette);
                if (gate.status === 'pass') {
                    art.deferred = gate.deferred;
                } else {
                    art.status = 'baseline';
                    await substituteBaseline(ctx, key, palette);
                    ctx.state.dead.push({ kind: 'trees', key, diagnostics: [{ code: 'E_UNKNOWN_BLOCK', message: `section referenced dead block(s): ${[...deadBlocks].join(', ')}` }] });
                    ctx.log(`section ${key}: depended on a block that died — publishing the theme's stock pattern in that slot instead`);
                }
            }));
        }
    }
    await settleAll(treeRepairs);

    const deadCount = ctx.state.dead.length;
    const repairedCount = ['trees', 'blocks', 'packages']
        .flatMap((k) => Object.values(arts[k] ?? {}))
        .filter((a) => a.status === 'repaired').length;
    if (deadCount === 0 && repairedCount === 0) ctx.log('nothing needed repairing — every artifact passed its gate first time');
    else if (deadCount === 0) ctx.log(`${repairedCount} artifact(s) repaired; nothing was lost`);
    else ctx.log(`${repairedCount} artifact(s) repaired, ${deadCount} could not be saved — their slots were substituted or dropped (details in the report)`);
}
