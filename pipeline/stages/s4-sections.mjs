import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { pLimit } from '../lib/limit.mjs';
import { screenTreeDiagnostics, localTreeCheck } from '../lib/gates.mjs';
import { resolveBandColors } from '../lib/tokens.mjs';
import { sectionImageIntents } from '../budget.mjs';

export const id = 'S4_sections';
export const kind = 'generative';

export async function run(ctx) {
    const brief = ctx.state.brief;
    const epoch = ctx.state.fingerprint;
    const tokens = JSON.parse(readFileSync(join(ctx.runDir, 'tokens.json'), 'utf8'));
    const tokenSlugs = {
        palette: tokens.palette.map((p) => p.slug),
        spacing: tokens.spacing.steps.map((s) => s.slug),
        font_sizes: tokens.typography.sizes.map((s) => s.slug),
        font_families: tokens.typography.families.map((f) => f.slug),
    };
    const allowedUnknown = new Set(brief.custom_blocks.map((b) => `agent/${b.slug}`));
    // The shared design language every section call sees: the whole page's plan.
    const pagePlans = Object.fromEntries(brief.pages.map((p) => [p.slug, p.sections.map((sec) => ({
        id: sec.id,
        role: sec.role,
        band: sec.design?.band ?? 'base',
        layout: sec.design?.layout ?? 'centered',
        images: sectionImageIntents(sec).length,
    }))]));
    ctx.state.artifacts = ctx.state.artifacts ?? {};
    ctx.state.artifacts.trees = ctx.state.artifacts.trees ?? {};

    const runSection = async (s) => {
        const entry = JSON.parse(readFileSync(join(ctx.runDir, s.file), 'utf8'));
        const section = entry.section;
        const intents = sectionImageIntents(section);
        let imageNote;
        if (intents.length === 0) {
            imageNote = 'This section carries no generated image; do not add core/image nodes with empty urls.';
        } else {
            const nodes = intents.map((intent) => `{"url": "", "metadata": {"imageIntent": ${JSON.stringify(intent)}}}`).join('\n  ');
            imageNote = `This section carries ${intents.length} generated image(s) — include EXACTLY one core/image node per intent below, each with these attributes (a placeholder pixel is minted at publish time; the real image is generated from the intent):\n  ${nodes}\n${section.role === 'gallery' ? 'Compose them inside a core/gallery (set columns to fit the count).' : 'Place each image where the layout calls for it.'} Set aspectRatio/scale/sizeSlug per node where the design needs them: geometry is final, pixels are provisional.`;
        }
        const isHeroSlot = section.role === 'hero' || section.role === 'header';
        const headingRule = isHeroSlot
            ? 'This section carries the page\'s SINGLE h1: the statement headline MUST be a core/heading with attributes.level set to 1 EXPLICITLY (core/heading defaults to level 2 when level is omitted). Any further headings inside this section are level 2.'
            : 'This section must NOT contain an h1. Its top heading is a core/heading with attributes.level 2; items/cards inside it use level 3. Never skip a heading level.';
        const design = section.design ?? { band: 'base', layout: 'centered' };
        const payload = {
            section,
            page: entry.page,
            art_direction: brief.art_direction,
            voice: brief.identity.voice ?? brief.identity.tagline,
            page_plan: pagePlans[s.page] ?? [],
            design,
            band_colors: resolveBandColors(design.band, brief.palette, tokens.palette),
            manifest_slice: entry.manifest_slice,
            pattern_tree: entry.pattern?.parsed_tree ?? null,
            token_slugs: tokenSlugs,
            epoch,
            image_note: imageNote,
            heading_rule: headingRule,
        };
        let tree;
        try {
            ({ value: tree } = await ctx.llm.generate({
                task_type: 'tree',
                label: `${s.page}/${s.id}`,
                payload,
                validate: (v) => localTreeCheck(v, { epoch }),
            }));
        } catch (e) {
            if (e.code !== 'contract_failed') throw e;
            const gate = { status: 'fail', deferred: [], failures: e.extra.issues.map((i) => ({ code: 'contract_failed', path: i.path, message: i.message })) };
            writeFileSync(join(ctx.runDir, 'trees', `${s.key}.json`), JSON.stringify({ tree: null, gate }, null, 2));
            ctx.state.artifacts.trees[s.key] = gate;
            return;
        }
        const res = await ctx.call('wp_validate', tree);
        if (!res.ok) {
            throw new PipelineError(res.data.code ?? 'companion_error', `wp_validate errored for ${s.key}: ${res.data.message}`, res.data.hint ?? '');
        }
        const screen = screenTreeDiagnostics(res.data, { allowedUnknown });
        const gate = { ...screen, diagnostics: res.data.diagnostics };
        writeFileSync(join(ctx.runDir, 'trees', `${s.key}.json`), JSON.stringify({ tree, gate }, null, 2));
        ctx.state.artifacts.trees[s.key] = { status: screen.status, deferred: screen.deferred, failures: screen.failures };
    };

    const limiter = pLimit(ctx.config.concurrency);
    await Promise.all(ctx.state.sections.map((s) => limiter(() => runSection(s))));
    const outcomes = Object.values(ctx.state.artifacts.trees);
    ctx.log(`S4: ${outcomes.filter((o) => o.status === 'pass').length}/${outcomes.length} sections passed their gate`);
}
