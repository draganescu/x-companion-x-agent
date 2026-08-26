import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { pLimit } from '../lib/limit.mjs';
import { screenTreeDiagnostics, screenTreeLiterals, localTreeCheck, screenImageGeometry, screenBandRoot, screenTreeInk, screenContentParity } from '../lib/gates.mjs';
import { resolveBandColors, annotatePalette, resolveInkMenus } from '../lib/tokens.mjs';
import { renderStyleNote } from '../lib/styles.mjs';
import { normalizeTreeBorders } from '../lib/normalize.mjs';
import { sectionImageIntents } from '../budget.mjs';

export const id = 'S4_sections';
export const kind = 'generative';

export async function run(ctx) {
    const brief = ctx.state.brief;
    const epoch = ctx.state.fingerprint;
    const tokens = JSON.parse(readFileSync(join(ctx.runDir, 'tokens.json'), 'utf8'));
    const tokenSlugs = {
        // Palette entries carry hex + tone: colour choices are checkable, never
        // guessed from a slug's name (the cream-on-cream lesson).
        palette: annotatePalette(tokens.palette),
        spacing: tokens.spacing.steps.map((s) => s.slug),
        font_sizes: tokens.typography.sizes.map((s) => s.slug),
        font_families: tokens.typography.families.map((f) => f.slug),
    };
    const allowedUnknown = new Set(brief.custom_blocks.map((b) => `agent/${b.slug}`));
    // The site's ONE alignment axis (§2, One axis): the header dictates it and
    // every section anchors on it; design.axis_break flips a single argued
    // section onto the opposite anchor. A run dir from before the axis field
    // falls back to the editorial default instead of crashing a --resume.
    const axis = brief.axis ?? { anchor: 'left', argument: '' };
    // One language for all content (§2): the brief detects the request's
    // dominant language; every writing call obeys it. The fallback sentence
    // keeps pre-language run dirs resumable and still instructs correctly.
    const language = brief.language ?? 'the language the brief\'s own copy is written in';
    // The style combo (§ style, decided in the brief): every tree call sees it
    // next to the art direction. Empty for a pre-style run dir, like the axis
    // and language fallbacks above.
    const comboNote = renderStyleNote(brief.style);
    const styleNote = comboNote && `${comboNote}
In this section the UI style decides how the composition is EXPRESSED (density, corner language, component shapes — through supports and spacing slugs); the artistic style decides its VOICE (which palette slugs, image treatment, editorial detail). Both live inside the page plan and the site axis.`;
    const OPPOSITE = { left: 'center', center: 'left' };
    const sectionAnchor = (sec) => (sec.design?.axis_break === true ? OPPOSITE[axis.anchor] : axis.anchor);
    // Pre-axis briefs named the axis inside the layout enum; both legacy values
    // meant the single-column composition.
    const composition = (l) => ({ centered: 'stack', 'left-aligned': 'stack' }[l] ?? l ?? 'stack');
    // The shared design language every section call sees: the whole page's plan.
    const pagePlans = Object.fromEntries(brief.pages.map((p) => [p.slug, p.sections.map((sec) => ({
        id: sec.id,
        role: sec.role,
        band: sec.design?.band ?? 'base',
        layout: composition(sec.design?.layout),
        axis: sectionAnchor(sec),
        images: sectionImageIntents(sec).length,
    }))]));
    ctx.state.artifacts = ctx.state.artifacts ?? {};
    ctx.state.artifacts.trees = ctx.state.artifacts.trees ?? {};
    // The band pair plus its measured ink menus: the choice is constrained
    // before it is judged, so the ink screen below almost never fires.
    const bandColors = (band) => {
        const pair = resolveBandColors(band, brief.palette, tokens.palette);
        return { ...pair, ...resolveInkMenus(pair.background, tokens.palette) };
    };

    const runSection = async (s) => {
        const entry = JSON.parse(readFileSync(join(ctx.runDir, s.file), 'utf8'));
        const section = entry.section;
        const intents = sectionImageIntents(section);
        let imageNote;
        if (intents.length === 0) {
            imageNote = 'This section carries no generated image; do not add core/image nodes with empty urls.';
        } else {
            const nodes = intents.map((intent) => `{"url": "", "metadata": {"imageIntent": ${JSON.stringify(intent)}}}`).join('\n  ');
            imageNote = `This section carries ${intents.length} generated image(s) — include EXACTLY one core/image node per intent below, each with these attributes (a placeholder pixel is minted at publish time; the real image is generated from the intent):\n  ${nodes}\n${section.role === 'gallery' ? 'Compose them inside a core/gallery (set columns to fit the count).' : 'Place each image where the layout calls for it.'} EVERY intent node MUST carry its own geometry — width (usually "100%" of its column) AND aspectRatio, with scale "cover" — because the minted placeholder is a 1×1 pixel and a node without geometry renders at one pixel (sizeSlug alone does nothing for it). Geometry is final, pixels are provisional.`;
        }
        const isHeroSlot = section.role === 'hero' || section.role === 'header';
        const headingRule = isHeroSlot
            ? 'This section carries the page\'s SINGLE h1: the statement headline MUST be a core/heading with attributes.level set to 1 EXPLICITLY (core/heading defaults to level 2 when level is omitted). Any further headings inside this section are level 2.'
            : 'This section must NOT contain an h1. Its top heading is a core/heading with attributes.level 2; items/cards inside it use level 3. Never skip a heading level.';
        const design = { band: 'base', layout: 'stack', ...(section.design ?? {}) };
        design.layout = composition(design.layout);
        const payload = {
            section,
            page: entry.page,
            art_direction: brief.art_direction,
            style_note: styleNote,
            voice: brief.identity.voice ?? brief.identity.tagline,
            language,
            page_plan: pagePlans[s.page] ?? [],
            design,
            axis: {
                site: axis.anchor,
                section: sectionAnchor(section),
                is_break: section.design?.axis_break === true,
                argument: axis.argument,
            },
            band_colors: bandColors(design.band),
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
                validate: (v) => {
                    const issues = localTreeCheck(v, { epoch });
                    if (issues.length > 0) return issues;
                    const band = screenBandRoot(v);
                    if (band.length > 0) return band.map((f) => ({ path: f.path, message: f.message }));
                    const literals = screenTreeLiterals(v).map((f) => ({ path: f.path, message: f.message }));
                    if (literals.length > 0) return literals;
                    const ink = screenTreeInk(v, { palette: tokens.palette }).failures;
                    if (ink.length > 0) return ink.map((f) => ({ path: f.path, message: f.message }));
                    return screenImageGeometry(v).map((f) => ({ path: f.path, message: f.message }));
                },
            }));
        } catch (e) {
            if (e.code !== 'contract_failed' && e.code !== 'output_truncated') throw e;
            const gate = { status: 'fail', deferred: [], failures: e.extra.issues.map((i) => ({ code: e.code, path: i.path, message: i.message })) };
            writeFileSync(join(ctx.runDir, 'trees', `${s.key}.json`), JSON.stringify({ tree: null, gate }, null, 2));
            ctx.state.artifacts.trees[s.key] = gate;
            ctx.log(`section ${s.key}: the model's output never satisfied the contract — the repair stage gets one attempt`);
            return;
        }
        normalizeTreeBorders(tree);
        const res = await ctx.call('wp_validate', tree);
        if (!res.ok) {
            throw new PipelineError(res.data.code ?? 'companion_error', `wp_validate errored for ${s.key}: ${res.data.message}`, res.data.hint ?? '');
        }
        const screen = screenTreeDiagnostics(res.data, { allowedUnknown });
        // A section carries copy and slugs, never a hardcoded design value.
        const literals = screenTreeLiterals(tree);
        screen.failures = [...screen.failures, ...literals];
        // Compile parity — only the site's own save() knows which attributes
        // it actually renders, so content loss (the quote-value class) is
        // observable ONLY at compile. A deferred tree cannot compile before
        // its block installs; S8 compiles it at the final epoch instead.
        if (screen.failures.length === 0 && screen.deferred.length === 0) {
            const compiled = await ctx.call('wp_compile', tree);
            if (!compiled.ok) {
                throw new PipelineError(compiled.data.code ?? 'companion_error', `wp_compile errored for ${s.key}: ${compiled.data.message}`, compiled.data.hint ?? '');
            }
            screen.failures = [...screen.failures, ...screenContentParity(compiled.data)];
        }
        screen.status = screen.failures.length === 0 ? 'pass' : 'fail';
        // Muddy-but-legal pairs (3–4.5:1) ride into the record like S5's style
        // advisories: visible in the report, never fatal (S9 mirrors this).
        const inkAdvisories = screenTreeInk(tree, { palette: tokens.palette }).advisories;
        if (inkAdvisories.length > 0) {
            ctx.log(`section ${s.key}: ${inkAdvisories.length} ink pair(s) between 3:1 and 4.5:1 — legible but muddy, kept as advisory`);
        }
        const gate = { ...screen, ...(inkAdvisories.length > 0 ? { ink_advisories: inkAdvisories } : {}), diagnostics: res.data.diagnostics };
        writeFileSync(join(ctx.runDir, 'trees', `${s.key}.json`), JSON.stringify({ tree, gate }, null, 2));
        ctx.state.artifacts.trees[s.key] = { status: screen.status, deferred: screen.deferred, failures: screen.failures };
        ctx.log(screen.status === 'pass'
            ? `section ${s.key}: validated against the site${screen.deferred.length > 0 ? ` (waiting on ${screen.deferred.join(', ')} to be installed)` : ''}`
            : `section ${s.key}: failed validation (${screen.failures.length} issue(s): ${screen.failures.slice(0, 2).map((f) => f.code).join(', ')}) — the repair stage gets one attempt`);
    };

    // The site furniture — header and footer template parts — rides the SAME
    // lane as the sections: a metered tree call against the brief's own
    // furniture intent, literal-screened and wp_validated. S8 stitches the nav
    // links in the way it stitches placeholder urls, and the deterministic
    // builders remain the floor when a part dies its gate.
    let furnitureSlice = {};
    try {
        furnitureSlice = JSON.parse(readFileSync(join(ctx.runDir, 'furniture-slice.json'), 'utf8'));
    } catch { /* a run dir from before the furniture lane — S8 falls back */ }
    ctx.state.artifacts.furniture = ctx.state.artifacts.furniture ?? {};
    const PART_NOTES = {
        header: 'You are designing the site HEADER template part: one core/group band containing the brand (core/site-title; optionally core/site-tagline or an uppercase letterspaced kicker paragraph) and EXACTLY ONE core/navigation node carrying attributes only — NO innerBlocks and NO ref: the links are injected at publish; your job is the navigation\'s placement and styling. NO heading blocks in the header (the site title is not a heading). One viewport-wide band that belongs to the same design as the hero under it.',
        footer: 'You are designing the site FOOTER template part. The brief wrote its design intent below — follow it as a section call follows its section brief. Link to pages ONLY through the footer items listed. Headings inside the footer are level 2, or styled paragraphs; never an h1. This part ends EVERY page: give it the same design attention as a section.',
    };
    const headerShape = (tree) => {
        const issues = [];
        const navs = [];
        const walkN = (ns) => (ns ?? []).forEach((n) => { if (n.name === 'core/navigation') navs.push(n); walkN(n.innerBlocks); });
        walkN(tree.blocks);
        if (navs.length !== 1) issues.push({ path: '/blocks', message: `the header carries EXACTLY ONE core/navigation node (found ${navs.length})` });
        else if ((navs[0].innerBlocks ?? []).length > 0 || navs[0].attributes?.ref !== undefined) {
            issues.push({ path: '/blocks', message: 'the core/navigation node carries attributes only — no innerBlocks and no ref; the links are injected at publish' });
        }
        return issues;
    };
    const runFurniture = async (part) => {
        const payload = {
            part,
            part_note: PART_NOTES[part],
            identity: brief.identity,
            art_direction: brief.art_direction,
            style_note: styleNote,
            voice: brief.identity.voice ?? brief.identity.tagline,
            language,
            palette: brief.palette,
            axis: { anchor: axis.anchor, argument: axis.argument },
            nav_items: brief.navigation.items,
            footer_intent: brief.footer.intent,
            footer_items: brief.footer.items,
            band_colors: bandColors(part === 'footer' ? 'contrast' : 'base'),
            manifest_slice: furnitureSlice,
            token_slugs: tokenSlugs,
            epoch,
        };
        let tree;
        try {
            ({ value: tree } = await ctx.llm.generate({
                task_type: 'tree',
                template: 'furniture',
                label: `furniture/${part}`,
                payload,
                validate: (v) => {
                    const issues = localTreeCheck(v, { epoch });
                    if (issues.length > 0) return issues;
                    const band = screenBandRoot(v);
                    if (band.length > 0) return band.map((f) => ({ path: f.path, message: f.message }));
                    const literals = screenTreeLiterals(v).map((f) => ({ path: f.path, message: f.message }));
                    if (literals.length > 0) return literals;
                    const ink = screenTreeInk(v, { palette: tokens.palette }).failures;
                    if (ink.length > 0) return ink.map((f) => ({ path: f.path, message: f.message }));
                    return part === 'header' ? headerShape(v) : [];
                },
            }));
        } catch (e) {
            if (e.code !== 'contract_failed' && e.code !== 'output_truncated') throw e;
            ctx.state.artifacts.furniture[part] = { status: 'fail', failures: e.extra.issues.map((i) => ({ code: e.code, path: i.path, message: i.message })) };
            ctx.log(`${part} template part: the model's output never satisfied the contract — the deterministic ${part} is the floor`);
            return;
        }
        normalizeTreeBorders(tree);
        const res = await ctx.call('wp_validate', tree);
        if (!res.ok) {
            throw new PipelineError(res.data.code ?? 'companion_error', `wp_validate errored for the ${part} part: ${res.data.message}`, res.data.hint ?? '');
        }
        const screen = screenTreeDiagnostics(res.data, { allowedUnknown: new Set() });
        // The same compile-parity gate the sections pass: a footer quote with
        // its text in a dead sourced attribute must degrade to the
        // deterministic floor, never ship an empty blockquote on every page.
        if (screen.failures.length === 0) {
            const compiled = await ctx.call('wp_compile', tree);
            if (!compiled.ok) {
                throw new PipelineError(compiled.data.code ?? 'companion_error', `wp_compile errored for the ${part} part: ${compiled.data.message}`, compiled.data.hint ?? '');
            }
            screen.failures = [...screen.failures, ...screenContentParity(compiled.data)];
            screen.status = screen.failures.length === 0 ? 'pass' : 'fail';
        }
        writeFileSync(join(ctx.runDir, 'trees', `furniture--${part}.json`), JSON.stringify({ tree, gate: { ...screen, diagnostics: res.data.diagnostics } }, null, 2));
        ctx.state.artifacts.furniture[part] = { status: screen.status, failures: screen.failures };
        ctx.log(screen.status === 'pass'
            ? `${part} template part: validated against the site`
            : `${part} template part: failed validation (${screen.failures.slice(0, 2).map((f) => f.code).join(', ')}) — the deterministic ${part} is the floor`);
    };

    const limiter = pLimit(ctx.config.concurrency);
    ctx.log(`writing ${ctx.state.sections.length} sections + the header and footer parts, up to ${ctx.config.concurrency} at a time`);
    await Promise.all([
        ...ctx.state.sections.map((s) => limiter(() => runSection(s))),
        limiter(() => runFurniture('header')),
        limiter(() => runFurniture('footer')),
    ]);
    const outcomes = Object.values(ctx.state.artifacts.trees);
    ctx.log(`sections written: ${outcomes.filter((o) => o.status === 'pass').length} of ${outcomes.length} passed validation`);
}
