import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { sha256 } from '../lib/hash.mjs';
import { screenTreeDiagnostics } from '../lib/gates.mjs';
import { mixHex, toneOf } from '../lib/tokens.mjs';
import { mintSurfaceMarkers, pageSurfaceDict, pageSurfacePlan, surfaceStyleLine } from '../lib/surfaces.mjs';
import { createRest, readConnection } from '../lib/rest.mjs';

export const id = 'S8_publish';
export const kind = 'deterministic';

// Each visit gets the nearest ancestor backgroundColor slug — the image's band,
// which decides its placeholder tone.
function walkImages(blocks, visit, path = '/blocks', bandSlug = null) {
    blocks.forEach((node, i) => {
        const p = `${path}/${i}`;
        const bg = node.attributes?.backgroundColor ?? bandSlug;
        if (node.name === 'core/image' && node.attributes?.metadata?.imageIntent) visit(node, p, bg);
        if (Array.isArray(node.innerBlocks)) walkImages(node.innerBlocks, visit, `${p}/innerBlocks`, bg);
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
    // makes the swap easy to spot. Under --no-images it SHIPS — then the tone
    // follows each image's own BAND: the band background nudged 12% toward its
    // ink, so the slot reads as intentional texture on light and dark bands
    // alike (one site-wide tone once shipped a near-black hole on a cream
    // hero). The role chain stays as the fallback for slots with no band.
    const toneRoles = ctx.state.no_images ? ['surface', 'muted', 'secondary', 'accent'] : ['accent'];
    const accent = toneRoles.map((r) => brief.palette.find((p) => p.role === r)).find(Boolean) ?? brief.palette[0];
    let paletteBySlug = new Map();
    let appliedPalette = [];
    try {
        const tokens = JSON.parse(readFileSync(join(ctx.runDir, 'tokens.json'), 'utf8'));
        appliedPalette = tokens.palette;
        paletteBySlug = new Map(tokens.palette.map((p) => [p.slug, p.color]));
    } catch { /* a run dir without applied tokens — the role fallback covers it */ }
    // The surface lane's run report: every degrade and refusal screams here,
    // because the page itself will not — the flat band underneath is coherent.
    ctx.state.surface_report = ctx.state.surface_report ?? { assets: [], degraded: [], refusals: [] };
    const placeholderTone = (bandSlug) => {
        const bandHex = ctx.state.no_images ? paletteBySlug.get(bandSlug) : undefined;
        if (!bandHex) return accent.color;
        return mixHex(bandHex, toneOf(bandHex) === 'light' ? '#000000' : '#FFFFFF', 0.12);
    };

    // 4. Assemble, gate, compile, publish each page.
    for (const page of brief.pages) {
        // Surface markers are minted per SECTION FRAGMENT, the way placeholder
        // pixels are minted: from the brief's own dictionary, before the tree
        // faces the same gates as everything else. Under --no-images nothing
        // is minted — both lanes are skipped whole and the published page
        // stays exactly today's flat output. A dead section keeps its
        // baseline, unskinned.
        let surfacesMinted = 0;
        const surfacePlans = ctx.state.no_images ? null : pageSurfacePlan(brief, page.slug, {
            groupSupport: ctx.state.surface_support?.group_background !== false,
        });
        const noteDegrade = (d) => {
            ctx.state.surface_report.degraded.push({ page: page.slug, ...d });
            ctx.log(`surface degraded on /${page.slug}/: ${d.reason}${d.asset_id ? ` (${d.asset_id})` : ''}`);
        };
        if (surfacePlans) surfacePlans.degraded.forEach(noteDegrade);

        const blocks = [];
        for (const s of ctx.state.sections.filter((x) => x.page === page.slug)) {
            const rec = JSON.parse(readFileSync(join(ctx.runDir, 'trees', `${s.key}.json`), 'utf8'));
            if (surfacePlans?.plans.has(s.id)) {
                const dead = (ctx.state.artifacts?.trees?.[s.key]?.status ?? 'pass') !== 'pass';
                const minted = mintSurfaceMarkers({ blocks: rec.tree.blocks }, [{ id: s.id, dead }], surfacePlans.plans);
                surfacesMinted += minted.minted;
                minted.degraded.forEach(noteDegrade);
            }
            blocks.push(...rec.tree.blocks);
        }
        const tree = { version: 1, epoch, blocks };

        const mints = [];
        walkImages(tree.blocks, (node, _p, bandSlug) => mints.push({ node, bandSlug }));
        for (const { node, bandSlug } of mints) {
            const ph = await toolOrThrow(ctx, 'wp_placeholder', { color: placeholderTone(bandSlug) }, 'wp_placeholder');
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
        // Content parity at the final epoch — the backstop for sections that
        // could not compile at S4/S7 because they waited on an install. A
        // page that silently drops authored text never ships.
        if ((compiled.content_lost ?? []).length > 0) {
            throw new PipelineError('gate_failed', `page "${page.slug}" lost authored content in compile — the site's save() ignored it`,
                'Each entry names the node and attribute; content for these blocks lives where their save() reads it (innerBlocks).', { content_lost: compiled.content_lost });
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
        // Designed pages carry their own h1, so each takes the theme's
        // no-title template — per page, which is the ONLY correct lever. The
        // two tempting alternatives are both wrong: deleting core/post-title
        // from page.html leaves every ordinary page untitled (a missing h1 is
        // worse than a doubled one), and adding a front-page.html overrides
        // the whole front-page hierarchy (front-page -> home -> index) whether
        // the front page is static or blog-first. The per-page template has no
        // hierarchy side effects.
        const body = { title: page.title, slug: page.slug, status: 'publish', template: 'page-no-title', content: compiled.markup };
        const saved = Array.isArray(existing) && existing.length > 0
            ? await rest('POST', `/wp/v2/pages/${existing[0].id}`, { body })
            : await rest('POST', '/wp/v2/pages', { body });
        ctx.state.published.pages.push({ slug: page.slug, id: saved.id, link: saved.link, front_page: !!page.front_page, has_images: mints.length > 0, has_surfaces: surfacesMinted > 0 });
        const followers = [mints.length > 0 ? `${mints.length} image slot(s)` : '', surfacesMinted > 0 ? `${surfacesMinted} surface marker(s)` : ''].filter(Boolean).join(', ');
        ctx.log(`published ${saved.link}${followers ? ` (${followers}, real assets follow)` : ''}`);
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

    // 7-8. Site furniture: the header and footer template parts. When S4's
    // design lane produced a part it ships — validated at the FINAL epoch,
    // compiled by the site's own save(), nav links injected the way placeholder
    // urls are. The deterministic builders below stay as the floor (and the
    // header's floor is the theme's own part plus the nav post).
    const furniture = ctx.state.artifacts?.furniture ?? {};
    const furnitureTree = (part) => JSON.parse(readFileSync(join(ctx.runDir, 'trees', `furniture--${part}.json`), 'utf8')).tree;
    const partsRes = await rest('GET', '/wp/v2/template-parts');
    const allParts = Array.isArray(partsRes) ? partsRes : [];
    // Canonical slug FIRST — Twenty Twenty-Five ships several footer-area parts
    // and only `footer` is the one its templates render; area is the fallback.
    const findPart = (slug) => allParts.find((p) => p.slug === slug || String(p.id).endsWith(`//${slug}`))
        ?? allParts.find((p) => p.area === slug);
    const writePart = async (slug, markup) => {
        const part = findPart(slug);
        if (!part) return false;
        // area rides along: a customized part posted without it loses its area
        // and the next run cannot find it.
        await rest('POST', `/wp/v2/template-parts/${encodeURIComponent(part.id)}`, { body: { content: markup, area: slug } });
        ctx.state.published[`${slug}_part`] = part.id;
        return true;
    };
    // The furniture gate at the final epoch: validate + screen + compile.
    // Failures here degrade to the deterministic floor, never kill the run.
    const compilePart = async (part, tree) => {
        const validation = await ctx.call('wp_validate', tree);
        if (!validation.ok) {
            ctx.log(`${part} part: wp_validate errored at the final epoch (${validation.data.message}) — using the deterministic ${part}`);
            return null;
        }
        const screen = screenTreeDiagnostics(validation.data, { allowedUnknown: new Set() });
        if (screen.status !== 'pass') {
            ctx.log(`${part} part: failed validation at the final epoch (${screen.failures.slice(0, 2).map((f) => f.code).join(', ')}) — using the deterministic ${part}`);
            return null;
        }
        const compiled = await ctx.call('wp_compile', tree);
        if (!compiled.ok || compiled.data.all_valid !== true || (compiled.data.content_lost ?? []).length > 0) {
            ctx.log(`${part} part: the site's own save() would not accept it (or dropped authored content) — using the deterministic ${part}`);
            return null;
        }
        return compiled.data.markup;
    };

    const navLinks = (brief.navigation.items ?? []).map((it) => ({
        name: 'core/navigation-link',
        attributes: { label: it.label, url: `/${it.page_slug}/`, kind: 'custom' },
        innerBlocks: [],
    }));

    // Header: the designed part when it survived S4, else the theme's own
    // header with the nav post — exactly the pre-furniture behavior.
    let headerShipped = false;
    if (furniture.header?.status === 'pass' && navLinks.length > 0) {
        const tree = { ...furnitureTree('header'), epoch };
        const findNav = (ns) => {
            for (const n of ns ?? []) {
                if (n.name === 'core/navigation') return n;
                const hit = findNav(n.innerBlocks);
                if (hit) return hit;
            }
            return null;
        };
        const navNode = findNav(tree.blocks);
        if (navNode) {
            // FLAT links, injected like placeholder urls: submenu nesting fails
            // E_NEST_PARENT on instances whose navigation-link parent list is
            // ['core/navigation'] only.
            navNode.innerBlocks = navLinks;
            const markup = await compilePart('header', tree);
            if (markup) headerShipped = await writePart('header', markup);
        }
        if (headerShipped) ctx.log('header template part shipped from the design lane, nav links injected');
        else ctx.log('designed header could not ship — keeping the theme header and the nav post');
    }
    if (!headerShipped && navLinks.length > 0) {
        const navTree = { version: 1, epoch, blocks: [{ name: 'core/navigation', attributes: {}, innerBlocks: navLinks }] };
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

    // Footer: the designed part (the brief's own footer intent, built) when it
    // survived S4, else the deterministic two-paragraph floor that replaced the
    // theme's demo links from day one.
    let footerShipped = false;
    if (furniture.footer?.status === 'pass') {
        const markup = await compilePart('footer', { ...furnitureTree('footer'), epoch });
        if (markup) footerShipped = await writePart('footer', markup);
        if (footerShipped) ctx.log("footer template part shipped from the design lane — the brief's footer intent, built");
    }
    if (!footerShipped && ((brief.footer.items ?? []).length > 0 || brief.footer.intent)) {
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
        if (!(await writePart('footer', footerCompiled.markup))) {
            ctx.log('this theme has no footer template part — footer skipped');
        }
    }

    // 9. The asset pass: ONE conveyor, two lanes. Budget-metered per birth —
    // content one call per surviving slot, surfaces ONE call per unique
    // dictionary asset however many bands reference it; applications are free.
    // Under --no-images the WHOLE pass is skipped, both lanes: the placeholders
    // minted above stay in place, no surface marker was minted, and the
    // published page is exactly today's flat output.
    if (ctx.state.no_images) {
        ctx.log('the asset pass skipped whole (--no-images) — placeholder pixels and flat bands stay in place');
        return;
    }
    const outDir = join(ctx.runDir, 'images');
    const born = ctx.state.surface_births ?? (ctx.state.surface_births = []);
    for (const page of ctx.state.published.pages.filter((p) => p.has_images || p.has_surfaces)) {
        let pageDict = pageSurfaceDict(brief, page.slug, appliedPalette);
        if (ctx.state.surface_support?.group_background === false) {
            // Only the cover mechanism survives a support-less instance; the
            // rest already degraded to their flat bands at mint time.
            pageDict = pageDict.filter((d) => d.intensity === 'loud' && (d.class === 'field' || d.class === 'pattern'));
        }
        const dry = await toolOrThrow(ctx, 'wp_images_generate', { post_id: page.id, dry_run: true, surfaces: pageDict, out_dir: outDir }, 'wp_images_generate dry_run');
        if (dry.found === 0 && (dry.found_surfaces ?? 0) === 0) continue;
        // Births are metered BEFORE the buy; replayed assets and slots
        // (resume: the file already sits in runs/<ts>/images/) spend nothing.
        const cachedContent = new Set(dry.cached_content ?? []);
        const cachedAssets = new Set(dry.cached ?? []);
        for (const ref of dry.images) {
            if (!cachedContent.has(ref.path)) ctx.budget.spend('image', `${page.slug}${ref.path ?? ''}`);
        }
        for (const d of pageDict) {
            if (!born.includes(d.id) && !cachedAssets.has(d.id)) {
                ctx.budget.spend('image', d.id);
                born.push(d.id);
            }
        }
        ctx.log(`asset pass for /${page.slug}/: ${dry.found} content slot(s), ${dry.found_surfaces ?? 0} surface target(s), ${pageDict.length} dictionary asset(s)`);
        const started = Date.now();
        const gen = await toolOrThrow(ctx, 'wp_images_generate', {
            post_id: page.id,
            style: brief.art_direction,
            // The surface lane gets the MATERIAL-SAFE half of the combo: the
            // artistic style plus its texture cue. Scene-flavoured art
            // direction pulls textures into becoming scenes (field evidence:
            // a "foxed paper" field came back as a photographed teacup).
            surface_style: surfaceStyleLine(brief),
            surfaces: pageDict,
            out_dir: outDir,
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
        // Surface births enter the ledger with the DICTIONARY ID as the label:
        // the manifest is the audit trail for the fan-out to many targets.
        // attempt > 1 records a texture-bound retry (in-tool, like the Gemini
        // client's transport retries — not a new metered call).
        for (const s of gen.surfaces ?? []) {
            ctx.ledger.record({
                task_type: 'image',
                label: s.asset_id,
                provider: 'gemini',
                model: 'wp_images_generate',
                prompt_hash: sha256(s.asset_id),
                payload_hash: sha256(s.asset_id),
                usage: { input_tokens: 0, output_tokens: 0 },
                attempt: s.attempts ?? 1,
                outcome: s.file ? 'ok' : 'error',
                started_at: started,
                ms: s.ms ?? 0,
            });
            ctx.state.surface_report.assets.push({ asset_id: s.asset_id, class: s.class, post_processing: s.post_processing, paths: s.paths ?? [], page: page.slug });
        }
        for (const err of gen.scan_errors ?? []) {
            ctx.state.surface_report.degraded.push({ page: page.slug, reason: `scan refused: ${err}` });
        }
        // Texture-bound rejects: the asset was bought (its births are in the
        // ledger) but was not a material; the flat band ships and the report
        // carries the exact reason.
        for (const r of gen.rejected ?? []) {
            ctx.state.surface_report.degraded.push({ page: page.slug, asset_id: r.asset_id, reason: r.reason });
            ctx.log(`surface rejected on /${page.slug}/: ${r.asset_id} — ${r.reason}`);
        }
        if (gen.generated === 0 && cachedContent.size === 0 && cachedAssets.size === 0) {
            throw new PipelineError('companion_error', `the asset pass produced nothing for /${page.slug}/`, '', { failures: gen.failures });
        }
        const applied = await toolOrThrow(ctx, 'wp_images_apply', { post_id: page.id, manifest_path: gen.manifest_path ?? join(outDir, 'images-manifest.json') }, 'wp_images_apply');
        if (applied.all_valid !== true) {
            throw new PipelineError('gate_failed', `wp_images_apply left /${page.slug}/ not all_valid`);
        }
        for (const s of applied.skipped ?? []) {
            ctx.state.surface_report.refusals.push({ page: page.slug, detail: s });
            ctx.log(`asset refusal on /${page.slug}/: ${s}`);
        }
        ctx.log(`/${page.slug}/: ${gen.generated} asset(s) generated, ${applied.swapped} content swap(s), ${applied.surfaces_applied ?? 0} surface write(s)`);
    }

    // 10. The page canvas ships with the tokens (x-surfaces M6): the asset was
    // born at S3 (its luminance constrained every canvas band's ink menus);
    // here it is uploaded and styles.background rides a token re-apply through
    // the companion's one sanctioned addition — before S9 verifies the pages.
    const canvasEntry = (brief.surfaces ?? []).find((s) => s.class === 'canvas');
    if (canvasEntry) {
        if (ctx.state.surface_support?.global_styles_background === false) {
            ctx.state.surface_report.degraded.push({ asset_id: canvasEntry.id, reason: 'this instance has no global-styles background support — the page canvas stays the flat ground' });
            ctx.log(`surface degraded: the page canvas "${canvasEntry.id}" cannot ship on this instance`);
            return;
        }
        const manifestPath = join(outDir, 'images-manifest.json');
        let canvasAsset = null;
        if (existsSync(manifestPath)) {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            canvasAsset = (manifest.surfaces ?? []).find((s) => s.asset_id === canvasEntry.id) ?? null;
        }
        if (!canvasAsset) {
            ctx.state.surface_report.degraded.push({ asset_id: canvasEntry.id, reason: 'the canvas asset was never born (S3 birth failed or was skipped) — the page canvas stays the flat ground' });
            ctx.log(`surface degraded: no canvas asset "${canvasEntry.id}" in the manifest`);
            return;
        }
        if (!canvasAsset.media_url) {
            const front = ctx.state.published.pages.find((p) => p.front_page);
            const uploaded = await toolOrThrow(ctx, 'wp_images_apply', { post_id: front.id, manifest_path: manifestPath }, 'wp_images_apply (canvas upload)');
            const outcome = (uploaded.surfaces ?? []).find((s) => s.asset_id === canvasEntry.id);
            canvasAsset.media_url = outcome?.media_url;
            canvasAsset.media_id = outcome?.media_id;
        }
        if (!canvasAsset.media_url) {
            ctx.state.surface_report.degraded.push({ asset_id: canvasEntry.id, reason: 'the canvas asset failed to upload — the page canvas stays the flat ground' });
            ctx.log(`surface degraded: canvas asset "${canvasEntry.id}" failed to upload`);
            return;
        }
        const tokens = JSON.parse(readFileSync(join(ctx.runDir, 'tokens.json'), 'utf8'));
        const payload = {
            ...tokens,
            styles: {
                background: {
                    backgroundImage: { url: canvasAsset.media_url, ...(canvasAsset.media_id ? { id: canvasAsset.media_id } : {}) },
                    backgroundSize: 'cover',
                },
            },
        };
        const shipped = await toolOrThrow(ctx, 'wp_tokens_apply', payload, 'wp_tokens_apply (page canvas)');
        if (shipped.fingerprint) ctx.state.fingerprint = shipped.fingerprint;
        ctx.state.surface_report.assets.push({ asset_id: canvasEntry.id, class: 'canvas', post_processing: canvasAsset.post_processing, paths: ['styles.background'], page: '(site)' });
        ctx.log(`page canvas "${canvasEntry.id}" shipped through global styles — admin-undoable in the Styles UI`);
    }
}
