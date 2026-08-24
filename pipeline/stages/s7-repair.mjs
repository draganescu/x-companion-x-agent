import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { screenTreeDiagnostics, localTreeCheck, screenFileMap, blockGate, schemaGate } from '../lib/gates.mjs';

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
    // No pattern matched this role at S2 time: the minimal honest slot.
    const title = entry.section.id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return [{
        name: 'core/group',
        attributes: {},
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
        attributes: {},
        innerBlocks: [
            { name: 'core/heading', attributes: { content: title }, innerBlocks: [] },
            { name: 'core/paragraph', attributes: { content: entry.section.copy_notes }, innerBlocks: [] },
        ],
    }];
}

// Baselines are gated too: a token-shifted world can invalidate a theme
// pattern. A pattern baseline that fails wp_validate degrades to the minimal
// honest slot (core blocks only) — never bypassed, never improvised.
async function substituteBaseline(ctx, key) {
    let blocks = baselineFor(ctx, key);
    let tree = { version: 1, epoch: ctx.state.fingerprint, blocks };
    const gate = await gateTree(ctx, tree, new Set());
    if (gate.status !== 'pass') {
        blocks = minimalSlot(ctx, key);
        tree = { version: 1, epoch: ctx.state.fingerprint, blocks };
    }
    writeFileSync(join(ctx.runDir, 'trees', `${key}.json`), JSON.stringify({ tree, gate: { status: 'baseline' } }, null, 2));
}

async function gateTree(ctx, tree, allowedUnknown) {
    const res = await ctx.call('wp_validate', tree);
    if (!res.ok) {
        return { status: 'fail', deferred: [], failures: [{ code: res.data.code ?? 'companion_error', message: res.data.message }] };
    }
    return screenTreeDiagnostics(res.data, { allowedUnknown });
}

function writeFiles(dir, files) {
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content);
    }
}

async function repairOnce(ctx, kind, key, art, { allowedUnknown }) {
    let artifact;
    let validate;
    if (kind === 'trees') {
        const rec = JSON.parse(readFileSync(join(ctx.runDir, 'trees', `${key}.json`), 'utf8'));
        artifact = rec.tree;
        validate = (v) => localTreeCheck(v, { epoch: ctx.state.fingerprint });
    } else {
        artifact = { files: Object.fromEntries((art.files ?? []).map((f) => [f, readFileSync(join(art.dir, f), 'utf8')])) };
        validate = (v) => screenFileMap(v, { allowed: new Set(art.files ?? []) });
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
        const gate = await gateTree(ctx, value, allowedUnknown);
        if (gate.status !== 'pass') {
            art.failures = [...art.failures, ...gate.failures];
            return false;
        }
        writeFileSync(join(ctx.runDir, 'trees', `${key}.json`), JSON.stringify({ tree: value, gate: { ...gate, repaired: true } }, null, 2));
        art.deferred = gate.deferred;
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
    writeFileSync(join(ctx.runDir, 'packages', `${key}.json`), JSON.stringify({ dir: art.dir, zip_path: art.zip_path, gate: { ...gate, repaired: true } }, null, 2));
    return true;
}

export async function run(ctx) {
    const arts = ctx.state.artifacts ?? {};
    ctx.state.dead = ctx.state.dead ?? [];
    const declared = new Set((ctx.state.brief.custom_blocks ?? []).map((b) => `agent/${b.slug}`));

    // Blocks and packages first: their deaths change what trees may defer to.
    for (const kind of ['blocks', 'packages']) {
        for (const [key, art] of Object.entries(arts[kind] ?? {})) {
            if (art.status !== 'fail') continue;
            const repaired = await repairOnce(ctx, kind, key, art, { allowedUnknown: declared });
            if (repaired) {
                art.status = 'repaired';
            } else {
                art.status = 'dead';
                ctx.state.dead.push({ kind, key, diagnostics: art.failures });
            }
        }
    }
    const deadBlocks = new Set(Object.entries(arts.blocks ?? {})
        .filter(([, a]) => a.status === 'dead')
        .map(([k]) => `agent/${k}`));
    const survivingUnknown = new Set([...declared].filter((n) => !deadBlocks.has(n)));

    for (const [key, art] of Object.entries(arts.trees ?? {})) {
        if (art.status === 'fail') {
            const repaired = await repairOnce(ctx, 'trees', key, art, { allowedUnknown: survivingUnknown });
            if (repaired) {
                art.status = 'repaired';
            } else {
                art.status = 'baseline';
                await substituteBaseline(ctx, key);
                ctx.state.dead.push({ kind: 'trees', key, diagnostics: art.failures });
            }
        } else if ((art.deferred ?? []).some((n) => deadBlocks.has(n))) {
            // The block this tree waited for is dead: re-gate without it (spec: re-gated).
            const rec = JSON.parse(readFileSync(join(ctx.runDir, 'trees', `${key}.json`), 'utf8'));
            const gate = await gateTree(ctx, rec.tree, survivingUnknown);
            if (gate.status === 'pass') {
                art.deferred = gate.deferred;
            } else {
                art.status = 'baseline';
                await substituteBaseline(ctx, key);
                ctx.state.dead.push({ kind: 'trees', key, diagnostics: [{ code: 'E_UNKNOWN_BLOCK', message: `section referenced dead block(s): ${[...deadBlocks].join(', ')}` }] });
            }
        }
    }

    const deadCount = ctx.state.dead.length;
    ctx.log(`S7: ${deadCount === 0 ? 'no dead artifacts' : `${deadCount} dead artifact(s), slots substituted or dropped`}`);
}
