import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { pLimit } from '../lib/limit.mjs';
import { screenFileMap, blockGate } from '../lib/gates.mjs';

export const id = 'S5_blocks';
export const kind = 'gated-generative';

function sampleFor(attr) {
    if (attr.default !== undefined) return attr.default;
    if (attr.type === 'string') return attr.name;
    if (attr.type === 'number') return 3;
    if (attr.type === 'boolean') return true;
    return ['sample'];
}

export async function run(ctx) {
    ctx.state.artifacts = ctx.state.artifacts ?? {};
    ctx.state.artifacts.blocks = ctx.state.artifacts.blocks ?? {};
    const blocks = ctx.state.brief.custom_blocks ?? [];
    if (blocks.length === 0) {
        ctx.log('S5: no custom blocks declared');
        return;
    }
    const tokens = JSON.parse(readFileSync(join(ctx.runDir, 'tokens.json'), 'utf8'));
    const tokenSlugs = {
        palette: tokens.palette.map((p) => p.slug),
        spacing: tokens.spacing.steps.map((s) => s.slug),
        font_sizes: tokens.typography.sizes.map((s) => s.slug),
    };

    const buildBlock = async (decl) => {
        // Scaffold first, deterministically (spec S5: the scaffold runs first).
        const scaffold = await ctx.call('wp_block_scaffold', {
            slug: decl.slug,
            title: decl.title,
            ...(decl.description ? { description: decl.description } : {}),
            attributes: decl.attributes,
            render_intent: decl.render_intent,
            dir: join(ctx.runDir, 'blocks'),
            force: true,
            interactivity: decl.interactivity ?? 'view-script',
            stylesheet: decl.stylesheet ?? false,
        });
        if (!scaffold.ok) {
            throw new PipelineError(scaffold.data.code ?? 'companion_error',
                `wp_block_scaffold failed for ${decl.slug}: ${scaffold.data.message}`, scaffold.data.hint ?? '');
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
        const sampleAttributes = Object.fromEntries(decl.attributes.map((a) => [a.name, sampleFor(a)]));
        const art = { status: 'fail', failures: [], dir, files: writable, sample_attributes: sampleAttributes };
        ctx.state.artifacts.blocks[decl.slug] = art;

        let value;
        try {
            ({ value } = await ctx.llm.generate({
                task_type: 'block',
                label: `block/${decl.slug}`,
                payload: {
                    block: { name: `agent/${decl.slug}`, title: decl.title, attributes: decl.attributes, interactivity: decl.interactivity ?? 'view-script', stylesheet: decl.stylesheet ?? false },
                    gap_argument: decl.gap_argument,
                    render_intent: decl.render_intent,
                    scaffold_files: scaffoldFiles,
                    token_slugs: tokenSlugs,
                    writable_files: writable,
                },
                validate: (v) => screenFileMap(v, { allowed }),
            }));
        } catch (e) {
            if (e.code !== 'contract_failed') throw e;
            art.failures = e.extra.issues.map((i) => ({ code: 'contract_failed', path: i.path, message: i.message }));
            writeFileSync(join(ctx.runDir, 'blocks', `${decl.slug}.json`), JSON.stringify({ dir, gate: { status: 'fail', failures: art.failures } }, null, 2));
            return;
        }
        for (const [name, content] of Object.entries(value.files)) {
            writeFileSync(join(dir, name), content);
        }
        const res = await ctx.call('wp_block_build_test', { dir, sample_attributes: sampleAttributes });
        const gate = blockGate(res);
        art.status = gate.status === 'pass' ? 'pass' : 'fail';
        art.failures = gate.failures;
        if (gate.status === 'pass') art.zip_path = res.data.zip_path;
        writeFileSync(join(ctx.runDir, 'blocks', `${decl.slug}.json`),
            JSON.stringify({ dir, zip_path: art.zip_path, gate, smoke: res.ok ? res.data.smoke : undefined, style_warnings: res.ok ? res.data.style_warnings : undefined }, null, 2));
    };

    const limiter = pLimit(ctx.config.concurrency);
    await Promise.all(blocks.map((b) => limiter(() => buildBlock(b))));
    const outcomes = Object.values(ctx.state.artifacts.blocks);
    ctx.log(`S5: ${outcomes.filter((o) => o.status === 'pass').length}/${outcomes.length} blocks passed the factory gate`);
}
