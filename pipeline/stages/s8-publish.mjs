import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { sha256 } from '../lib/hash.mjs';
import { screenTreeDiagnostics } from '../lib/gates.mjs';
import { createRest, readConnection } from '../lib/rest.mjs';

export const id = 'S8_publish';
export const kind = 'deterministic';

function walkImages(blocks, visit, path = '/blocks') {
    blocks.forEach((node, i) => {
        const p = `${path}/${i}`;
        if (node.name === 'core/image' && node.attributes?.metadata?.imageIntent) visit(node, p);
        if (Array.isArray(node.innerBlocks)) walkImages(node.innerBlocks, visit, `${p}/innerBlocks`);
    });
}

async function toolOrThrow(ctx, name, args, what) {
    const res = await ctx.call(name, args);
    if (!res.ok) {
        throw new PipelineError(res.data.code ?? 'companion_error', `${what}: ${res.data.message}`, res.data.hint ?? '', { envelope: res.data });
    }
    return res.data;
}

export async function run(ctx) {
    const brief = ctx.state.brief;
    const rest = ctx.rest ?? createRest(readConnection(process.cwd()));
    ctx.state.installs = [];
    ctx.state.published = { pages: [] };

    // 1. Sequential installs — the epoch is the only serialization point (R12);
    //    installs run one at a time from this single runner, never the limiter.
    for (const [slug, art] of Object.entries(ctx.state.artifacts?.packages ?? {})) {
        if (art.status === 'dead') continue;
        const data = await toolOrThrow(ctx, 'wp_schema_install', { zip_path: art.zip_path }, `wp_schema_install ${slug}`);
        ctx.state.installs.push({ kind: 'schema', slug, fingerprint: data.fingerprint });
        ctx.state.fingerprint = data.fingerprint;
        ctx.log(`installed data model ${slug} on the site`);
    }
    for (const [slug, art] of Object.entries(ctx.state.artifacts?.blocks ?? {})) {
        if (art.status === 'dead') continue;
        const data = await toolOrThrow(ctx, 'wp_block_install', { zip_path: art.zip_path }, `wp_block_install ${slug}`);
        ctx.state.installs.push({ kind: 'block', slug, fingerprint: data.fingerprint });
        ctx.state.fingerprint = data.fingerprint;
        ctx.log(`installed block ${slug} on the site`);
    }
    if (ctx.state.installs.length > 0) {
        ctx.log(`${ctx.state.installs.length} install(s) done, one at a time — pages compile against the final site state`);
    }
    const epoch = ctx.state.fingerprint; // 2. the final epoch, stamped into every assembled tree

    // 3. Placeholders: mint the pixel that carries each image intent.
    // Tone: in a normal run the pixel is swapped within minutes, and accent
    // makes the swap easy to spot. Under --no-images it SHIPS — a quiet
    // surface tone reads as intentional texture, not six alarm-coloured holes.
    const toneRoles = ctx.state.no_images ? ['surface', 'muted', 'secondary', 'accent'] : ['accent'];
    const accent = toneRoles.map((r) => brief.palette.find((p) => p.role === r)).find(Boolean) ?? brief.palette[0];

    // 4. Assemble, gate, compile, publish each page.
    for (const page of brief.pages) {
        const blocks = [];
        for (const s of ctx.state.sections.filter((x) => x.page === page.slug)) {
            const rec = JSON.parse(readFileSync(join(ctx.runDir, 'trees', `${s.key}.json`), 'utf8'));
            blocks.push(...rec.tree.blocks);
        }
        const tree = { version: 1, epoch, blocks };

        const mints = [];
        walkImages(tree.blocks, (node) => mints.push(node));
        for (const node of mints) {
            const ph = await toolOrThrow(ctx, 'wp_placeholder', { color: accent.color }, 'wp_placeholder');
            node.attributes.url = ph.url;
            node.attributes.id = ph.id;
        }

        // Every deferral must have resolved at the final epoch: empty allow-set.
        const validation = await toolOrThrow(ctx, 'wp_validate', tree, `wp_validate page ${page.slug}`);
        const screen = screenTreeDiagnostics(validation, { allowedUnknown: new Set() });
        if (screen.status !== 'pass') {
            throw new PipelineError('gate_failed', `assembled page "${page.slug}" failed validation at the final epoch`,
                'A deferral that never resolved or a warning the screen rejects — see diagnostics.', { failures: screen.failures, diagnostics: validation.diagnostics });
        }
        const compiled = await toolOrThrow(ctx, 'wp_compile', tree, `wp_compile page ${page.slug}`);
        if (compiled.all_valid !== true) {
            throw new PipelineError('gate_failed', `wp_compile page "${page.slug}" not all_valid`, '', { invalid: compiled.invalid });
        }
        const treeNames = new Set();
        const collect = (ns) => ns.forEach((n) => { treeNames.add(n.name); collect(n.innerBlocks ?? []); });
        collect(tree.blocks);
        const gaps = (compiled.registry_gaps ?? []).filter((n) => treeNames.has(n));
        if (gaps.length > 0) {
            throw new PipelineError('harness_gap', `page "${page.slug}" uses blocks missing from the harness registry: ${gaps.join(', ')}`);
        }
        writeFileSync(join(ctx.runDir, 'pages', `${page.slug}.html`), compiled.markup);
        writeFileSync(join(ctx.runDir, 'trees', `page--${page.slug}.json`), JSON.stringify(tree, null, 2));

        const existing = await rest('GET', '/wp/v2/pages', { query: { slug: page.slug, status: 'publish,draft,pending' } });
        const body = { title: page.title, slug: page.slug, status: 'publish', template: 'page-no-title', content: compiled.markup };
        const saved = Array.isArray(existing) && existing.length > 0
            ? await rest('POST', `/wp/v2/pages/${existing[0].id}`, { body })
            : await rest('POST', '/wp/v2/pages', { body });
        ctx.state.published.pages.push({ slug: page.slug, id: saved.id, link: saved.link, front_page: !!page.front_page, has_images: mints.length > 0 });
        ctx.log(`published ${saved.link}${mints.length > 0 ? ` (${mints.length} image slot(s), real images follow)` : ''}`);
    }

    // 5-6. Site identity + front page + Sample Page cleanup.
    //
    // The brief names the site; without this the header keeps whatever the
    // sandbox was called and every core/site-title block on the page renders it.
    // Core's own settings route, so an admin undoes it in Settings > General.
    const front = ctx.state.published.pages.find((p) => p.front_page);
    await rest('POST', '/wp/v2/settings', {
        body: {
            title: brief.identity.site_title,
            description: brief.identity.tagline,
            show_on_front: 'page',
            page_on_front: front.id,
        },
    });
    ctx.state.published.site_title = brief.identity.site_title;
    ctx.log(`site named "${brief.identity.site_title}", front page set, sample page removed`);
    const samples = await rest('GET', '/wp/v2/pages', { query: { slug: 'sample-page' } });
    for (const s of Array.isArray(samples) ? samples : []) {
        await rest('DELETE', `/wp/v2/pages/${s.id}`, { query: { force: 'true' } });
    }

    // 7. Navigation from the brief, via the compile lane (never hand-written markup).
    if ((brief.navigation.items ?? []).length > 0) {
        const navTree = {
            version: 1,
            epoch,
            blocks: [{
                name: 'core/navigation',
                attributes: {},
                // FLAT links: submenu nesting fails E_NEST_PARENT on instances
                // whose navigation-link parent list is ['core/navigation'] only.
                innerBlocks: brief.navigation.items.map((it) => ({
                    name: 'core/navigation-link',
                    attributes: { label: it.label, url: `/${it.page_slug}/`, kind: 'custom' },
                    innerBlocks: [],
                })),
            }],
        };
        await toolOrThrow(ctx, 'wp_validate', navTree, 'wp_validate navigation');
        const navCompiled = await toolOrThrow(ctx, 'wp_compile', navTree, 'wp_compile navigation');
        // Strip ONLY the outer wrapper delimiters — first and last LINE. A regex
        // would also eat every navigation-link comment line (session lesson).
        const inner = navCompiled.markup.split('\n').slice(1, -1).join('\n');
        const navs = await rest('GET', '/wp/v2/navigation', { query: { status: 'publish,draft' } });
        if (Array.isArray(navs) && navs.length > 0) {
            await rest('POST', `/wp/v2/navigation/${navs[0].id}`, { body: { content: inner, status: 'publish' } });
            ctx.state.published.nav_id = navs[0].id;
        } else {
            const created = await rest('POST', '/wp/v2/navigation', { body: { title: 'Navigation', content: inner, status: 'publish' } });
            ctx.state.published.nav_id = created.id;
        }
    }

    // 8. Footer template part replacement (the theme's demo links go away).
    if ((brief.footer.items ?? []).length > 0 || brief.footer.intent) {
        const footerTree = {
            version: 1,
            epoch,
            blocks: [{
                name: 'core/group',
                attributes: { style: { spacing: { padding: { top: 'var:preset|spacing|50', bottom: 'var:preset|spacing|50' } } } },
                innerBlocks: [
                    { name: 'core/paragraph', attributes: { content: `${brief.identity.site_title} — ${brief.identity.tagline}` }, innerBlocks: [] },
                    ...(brief.footer.items.length > 0 ? [{
                        name: 'core/paragraph',
                        attributes: { content: brief.footer.items.map((it) => `<a href="/${it.page_slug}/">${it.label}</a>`).join(' · ') },
                        innerBlocks: [],
                    }] : []),
                ],
            }],
        };
        const footerCompiled = await toolOrThrow(ctx, 'wp_compile', footerTree, 'wp_compile footer');
        const parts = await rest('GET', '/wp/v2/template-parts');
        // A theme can ship SEVERAL parts with area 'footer' — Twenty Twenty-Five
        // has footer, footer-columns and footer-newsletter, and only `footer` is
        // the one its templates render. Match the canonical slug FIRST; taking
        // "any part whose area is footer" silently rewrites an unused variant and
        // leaves the real footer showing the theme's demo links.
        const all = Array.isArray(parts) ? parts : [];
        const footerPart = all.find((p) => p.slug === 'footer' || String(p.id).endsWith('//footer'))
            ?? all.find((p) => p.area === 'footer');
        if (footerPart) {
            // area rides along: a customized part posted without it loses its
            // 'footer' area and the next run cannot find it.
            await rest('POST', `/wp/v2/template-parts/${encodeURIComponent(footerPart.id)}`, { body: { content: footerCompiled.markup, area: 'footer' } });
            ctx.state.published.footer_part = footerPart.id;
        } else {
            ctx.log('this theme has no footer template part — footer skipped');
        }
    }

    // 9. The image pass: budget-metered per found intent, then generate + apply.
    // Under --no-images the pass is skipped whole: the placeholders minted above
    // stay in place, each carrying its imageIntent for a later fill, and no
    // image call is spent (S1 already removed I from the ceiling).
    if (ctx.state.no_images) {
        ctx.log('image generation skipped (--no-images) — the placeholder pixels stay in place');
        return;
    }
    for (const page of ctx.state.published.pages.filter((p) => p.has_images)) {
        const dry = await toolOrThrow(ctx, 'wp_images_generate', { post_id: page.id, dry_run: true }, 'wp_images_generate dry_run');
        if (dry.found === 0) continue;
        for (const ref of dry.images) {
            ctx.budget.spend('image', `${page.slug}${ref.path ?? ''}`);
        }
        ctx.log(`generating ${dry.found} real image(s) for /${page.slug}/ — one image-model call each, then swapped in where the placeholders sit`);
        const started = Date.now();
        const gen = await toolOrThrow(ctx, 'wp_images_generate', {
            post_id: page.id,
            style: brief.art_direction,
            out_dir: join(ctx.runDir, 'images'),
        }, 'wp_images_generate');
        for (const img of gen.images) {
            ctx.ledger.record({
                task_type: 'image',
                label: `${page.slug}${img.path ?? ''}`,
                provider: 'gemini',
                model: 'wp_images_generate',
                prompt_hash: sha256(img.intent ?? ''),
                payload_hash: sha256(img.intent ?? ''),
                usage: { input_tokens: 0, output_tokens: 0 },
                attempt: 1,
                outcome: img.file ? 'ok' : 'error',
                started_at: started,
                ms: img.ms ?? 0,
            });
        }
        if (gen.generated === 0) {
            throw new PipelineError('companion_error', `image generation produced nothing for /${page.slug}/`, '', { failures: gen.failures });
        }
        const applied = await toolOrThrow(ctx, 'wp_images_apply', { post_id: page.id, manifest_path: gen.manifest_path }, 'wp_images_apply');
        if (applied.all_valid !== true) {
            throw new PipelineError('gate_failed', `wp_images_apply left /${page.slug}/ not all_valid`);
        }
        ctx.log(`/${page.slug}/: ${gen.generated} image(s) generated and applied`);
    }
}
