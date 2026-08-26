import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pLimit } from '../lib/limit.mjs';
import { screenFileMap, screenBlockCss, blockGate } from '../lib/gates.mjs';
import { annotatePalette } from '../lib/tokens.mjs';
import { renderStyleNote } from '../lib/styles.mjs';

export const id = 'S5_blocks';
export const kind = 'gated-generative';

function sampleFor(attr) {
    if (attr.default !== undefined) return attr.default;
    if (attr.type === 'string') return attr.name;
    if (attr.type === 'number') return 3;
    if (attr.type === 'boolean') return true;
    return ['sample'];
}

// wp_block_scaffold requires select options as {label, value} — labels are
// user-facing. Briefs written against the pre-fix schema emit bare strings; widen
// them here so an old brief resumes instead of dying at the tool boundary.
export function normalizeAttributes(attributes) {
    return (attributes ?? []).map((a) => (Array.isArray(a.options)
        ? { ...a, options: a.options.map((o) => (typeof o === 'string' ? { label: o, value: o } : o)) }
        : a));
}

export async function run(ctx) {
    ctx.state.artifacts = ctx.state.artifacts ?? {};
    ctx.state.artifacts.blocks = ctx.state.artifacts.blocks ?? {};
    const blocks = ctx.state.brief.custom_blocks ?? [];
    if (blocks.length === 0) {
        ctx.log('the plan needs no custom blocks — skipping');
        return;
    }
    const tokens = JSON.parse(readFileSync(join(ctx.runDir, 'tokens.json'), 'utf8'));
    const tokenSlugs = {
        // Palette entries carry hex + tone, exactly as the tree lane's do: the
        // few colours a block legitimately owns (a meter fill, a status dot)
        // are checked against values, never guessed from a slug's name — a
        // block once painted its text var(--wp--preset--color--ink) on a site
        // whose "ink" shared its hex with the band the block landed on.
        palette: annotatePalette(tokens.palette),
        spacing: tokens.spacing.steps.map((s) => s.slug),
        font_sizes: tokens.typography.sizes.map((s) => s.slug),
    };
    // The combo, for the block's design decisions; empty on a pre-style run dir.
    const comboNote = renderStyleNote(ctx.state.brief.style);
    const styleNote = comboNote && `${comboNote}
The block is a component of this combo: its shapes, density and detail follow the UI style; its few owned colours and any texture follow the artistic style — all inside the token system and the instance's colour supports.`;

    const buildBlock = async (decl, index) => {
        const attributes = normalizeAttributes(decl.attributes);
        // Scaffold first, deterministically (spec S5: the scaffold runs first).
        const scaffold = await ctx.call('wp_block_scaffold', {
            slug: decl.slug,
            title: decl.title,
            ...(decl.description ? { description: decl.description } : {}),
            attributes,
            render_intent: decl.render_intent,
            dir: join(ctx.runDir, 'blocks'),
            force: true,
            interactivity: decl.interactivity ?? 'view-script',
            stylesheet: decl.stylesheet ?? false,
        });
        // A block that cannot even be scaffolded is a dead artifact, exactly like one
        // that fails its contract or its build test — S7 gives it a pattern baseline.
        // It is not a reason to throw away every other artifact in the run.
        if (!scaffold.ok) {
            const failures = [{
                code: scaffold.data.code ?? 'companion_error',
                path: '/scaffold',
                message: scaffold.data.message,
            }];
            ctx.state.artifacts.blocks[decl.slug] = { status: 'fail', failures, files: [] };
            ctx.log(`block ${decl.slug}: could not even be scaffolded — dead artifact: ${scaffold.data.message}`);
            writeFileSync(join(ctx.runDir, 'blocks', `${decl.slug}.json`),
                JSON.stringify({ gate: { status: 'fail', failures } }, null, 2));
            return;
        }
        const dir = scaffold.data.dir;
        const writable = ['render.php'];
        if ((decl.interactivity ?? 'view-script') !== 'none') writable.push('view.js');
        if (decl.stylesheet) writable.push('style.css');
        const scaffoldFiles = {};
        for (const f of scaffold.data.files) {
            const base = f.split('/').pop();
            if (['render.php', 'view.js', 'style.css', 'block.json'].includes(base)) {
                scaffoldFiles[base] = readFileSync(join(dir, base), 'utf8');
            }
        }
        const allowed = new Set(writable);
        const sampleAttributes = Object.fromEntries(attributes.map((a) => [a.name, sampleFor(a)]));
        // Concurrent build tests must not race for the same sandbox port.
        const port = 9440 + index * 2;
        const art = { status: 'fail', failures: [], dir, files: writable, sample_attributes: sampleAttributes, port };
        ctx.state.artifacts.blocks[decl.slug] = art;

        let value;
        try {
            ({ value } = await ctx.llm.generate({
                task_type: 'block',
                label: `block/${decl.slug}`,
                payload: {
                    block: { name: `agent/${decl.slug}`, title: decl.title, attributes, interactivity: decl.interactivity ?? 'view-script', stylesheet: decl.stylesheet ?? false },
                    gap_argument: decl.gap_argument,
                    render_intent: decl.render_intent,
                    style_note: styleNote,
                    scaffold_files: scaffoldFiles,
                    token_slugs: tokenSlugs,
                    writable_files: writable,
                },
                validate: (v) => {
                    const issues = screenFileMap(v, { allowed });
                    if (issues.length > 0) return issues;
                    return screenBlockCss(v);
                },
            }));
        } catch (e) {
            if (e.code !== 'contract_failed' && e.code !== 'output_truncated') throw e;
            art.failures = e.extra.issues.map((i) => ({ code: e.code, path: i.path, message: i.message }));
            writeFileSync(join(ctx.runDir, 'blocks', `${decl.slug}.json`), JSON.stringify({ dir, gate: { status: 'fail', failures: art.failures } }, null, 2));
            ctx.log(`block ${decl.slug}: the model's code never satisfied the contract — the repair stage gets one attempt`);
            return;
        }
        for (const [name, content] of Object.entries(value.files)) {
            writeFileSync(join(dir, name), content);
        }
        const res = await ctx.call('wp_block_build_test', { dir, sample_attributes: sampleAttributes, port });
        const gate = blockGate(res);
        art.status = gate.status === 'pass' ? 'pass' : 'fail';
        art.failures = gate.failures;
        // Advisory literals do not fail the artifact, but they are the record of
        // what the block spent outside the token system — keep them visible.
        art.style_advisories = gate.warnings ?? [];
        if (art.style_advisories.length > 0) {
            ctx.log(`block ${decl.slug}: ${art.style_advisories.length} advisory style literal(s) — CSS values no theme preset can express; kept, recorded in the report`);
        }
        if (gate.status === 'pass') art.zip_path = res.data.zip_path;
        ctx.log(gate.status === 'pass'
            ? `block ${decl.slug}: built and proven in a throwaway WordPress — install package ready`
            : `block ${decl.slug}: failed its build test (${gate.failures.slice(0, 2).map((f) => f.message).join(' | ')}) — the repair stage gets one attempt`);
        writeFileSync(join(ctx.runDir, 'blocks', `${decl.slug}.json`),
            JSON.stringify({ dir, zip_path: art.zip_path, gate, smoke: res.ok ? res.data.smoke : undefined, style_warnings: res.ok ? res.data.style_warnings : undefined }, null, 2));
    };

    const limiter = pLimit(ctx.config.concurrency);
    ctx.log(`building ${blocks.length} custom block(s): ${blocks.map((b) => b.slug).join(', ')}`);
    await Promise.all(blocks.map((b, i) => limiter(() => buildBlock(b, i))));
    const outcomes = Object.values(ctx.state.artifacts.blocks);
    ctx.log(`custom blocks: ${outcomes.filter((o) => o.status === 'pass').length} of ${outcomes.length} built and proven`);
}
