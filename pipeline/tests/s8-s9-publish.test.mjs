import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetMeter, Ledger } from '../budget.mjs';
import { screenOutline } from '../lib/gates.mjs';
import * as s8 from '../stages/s8-publish.mjs';
import * as s9 from '../stages/s9-verify.mjs';

const brief = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));

function sectionTree(key, extraBlocks = []) {
    return {
        tree: {
            version: 1,
            epoch: 'old',
            blocks: [{ name: 'core/group', attributes: {}, innerBlocks: [{ name: 'core/heading', attributes: { content: key } }] }, ...extraBlocks],
        },
        gate: { status: 'pass' },
    };
}

function makeCtx({ restLog, toolLog, validateResult, theme, furniture, sectionPanes = {} }) {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s8-'));
    for (const d of ['trees', 'pages', 'images']) mkdirSync(join(runDir, d), { recursive: true });
    const sections = [];
    for (const page of brief.pages) {
        for (const section of page.sections) {
            const key = `${page.slug}--${section.id}`;
            const extra = section.image_intent
                ? [{ name: 'core/image', attributes: { url: '', metadata: { imageIntent: section.image_intent } }, innerBlocks: [] }]
                : [];
            const st = sectionTree(key, extra);
            if (sectionPanes[key]) st.tree.blocks[0].attributes.metadata = { pane: sectionPanes[key] };
            writeFileSync(join(runDir, 'trees', `${key}.json`), JSON.stringify(st));
            sections.push({ key, page: page.slug, id: section.id, file: join('sections', `${key}.json`) });
        }
    }
    const budget = new BudgetMeter({});
    budget.setCeiling(16);
    const ledger = new Ledger(runDir);
    let installFp = 0;
    return {
        runDir, budget, ledger,
        config: { concurrency: 3 },
        state: {
            brief: structuredClone(brief),
            fingerprint: 'f-tokens',
            sections,
            artifacts: {
                trees: {},
                blocks: { 'signup-banner': { status: 'pass', zip_path: '/z/block.zip' } },
                packages: { newsletter: { status: 'pass', zip_path: '/z/schema.zip' } },
                ...(furniture ? { furniture } : {}),
            },
            ...(theme ? { theme } : {}),
        },
        log: () => {},
        call: async (name, args) => {
            toolLog.push([name, args]);
            if (name === 'wp_schema_install' || name === 'wp_block_install') {
                installFp += 1;
                return { ok: true, data: { installed: {}, fingerprint: `f-install-${installFp}`, replaced_previous: false, previous_fingerprint: 'x', manifest_refreshed: true, session_reloaded: true } };
            }
            if (name === 'wp_placeholder') return { ok: true, data: { id: 77, url: 'http://x/x-pixel-d96c2c.gif', color: '#D96C2C', slug: 'accent', reused: false } };
            if (name === 'wp_validate') return { ok: true, data: validateResult ?? { valid: true, epoch_ok: true, diagnostics: [] } };
            if (name === 'wp_compile') return { ok: true, data: { markup: '<!-- wp:navigation -->\n<!-- wp:navigation-link /-->\n<!-- /wp:navigation -->', all_valid: true, invalid: [], registry_gaps: [], epoch: args.epoch, timing: { total_ms: 1, page_ms: 1, compile_ms: 1, cold: false }, harness: { reloaded: 0, degraded: null, via_editor_fallback: false } } };
            if (name === 'wp_images_generate') {
                if (args.dry_run) return { ok: true, data: { post_id: args.post_id, found: 2, generated: 0, dry_run: true, images: [{ path: '/blocks/0', intent: 'a' }, { path: '/blocks/1', intent: 'b' }] } };
                return { ok: true, data: { post_id: args.post_id, found: 2, generated: 2, dry_run: false, manifest_path: '/m.json', images: [{ path: '/blocks/0', intent: 'a', file: '/a.jpg', ms: 5, block_name: 'core/image', aspect_ratio: '16:9' }, { path: '/blocks/1', intent: 'b', file: '/b.jpg', ms: 6, block_name: 'core/image', aspect_ratio: '16:9' }] } };
            }
            if (name === 'wp_images_apply') return { ok: true, data: { post_id: args.post_id, uploaded: [], swapped: 2, skipped: [], all_valid: true, link: 'http://x/home/' } };
            throw new Error(`unexpected tool ${name}`);
        },
        rest: async (method, route, opts) => {
            restLog.push([method, route, opts]);
            if (method === 'GET' && route === '/wp/v2/pages' && opts?.query?.slug === 'sample-page') return [{ id: 2 }];
            if (method === 'GET' && route === '/wp/v2/pages') return [];
            if (method === 'POST' && route === '/wp/v2/pages') return { id: 8, link: 'http://x/home/' };
            if (method === 'POST' && route === '/wp/v2/settings') return {};
            if (method === 'DELETE' && route.startsWith('/wp/v2/pages/')) return {};
            if (method === 'GET' && route === '/wp/v2/navigation') return [{ id: 9 }];
            if (method === 'POST' && route === '/wp/v2/navigation/9') return { id: 9 };
            if (method === 'GET' && route === '/wp/v2/template-parts') return [{ id: 'theme//header', area: 'header' }, { id: 'theme//footer', area: 'footer' }, { id: 'theme//rail', area: 'rail' }];
            if (method === 'POST' && route.startsWith('/wp/v2/template-parts/')) return {};
            throw new Error(`unexpected rest ${method} ${route}`);
        },
    };
}

test('S8: sequential installs, final epoch stamped, publish + nav + footer + metered images', async () => {
    const restLog = [];
    const toolLog = [];
    const ctx = makeCtx({ restLog, toolLog });
    await s8.run(ctx);

    // installs sequential, schema before blocks, final fingerprint = last install's
    assert.deepEqual(ctx.state.installs.map((i) => i.kind), ['schema', 'block']);
    assert.equal(ctx.state.fingerprint, 'f-install-2');

    // the assembled page tree carries the final epoch into validate and compile
    const validated = toolLog.find(([n, a]) => n === 'wp_validate' && a.blocks.length > 1);
    assert.equal(validated[1].epoch, 'f-install-2');

    // placeholder minted for the two image intents, url/id set before validation
    const imageNodes = [];
    const walk = (ns) => ns.forEach((n) => { if (n.name === 'core/image') imageNodes.push(n); walk(n.innerBlocks ?? []); });
    walk(validated[1].blocks);
    assert.equal(imageNodes.length, 2);
    assert.ok(imageNodes.every((n) => n.attributes.url.includes('x-pixel')));

    // page published with the no-title template; front page set; sample page deleted
    const pagePost = restLog.find(([m, r]) => m === 'POST' && r === '/wp/v2/pages');
    assert.equal(pagePost[2].body.template, 'page-no-title');
    assert.ok(restLog.some(([m, r, o]) => m === 'POST' && r === '/wp/v2/settings' && o.body.page_on_front === 8));
    assert.ok(restLog.some(([m, r]) => m === 'DELETE' && r === '/wp/v2/pages/2'));

    // nav wrapper stripped by LINE slice: only the inner line posted
    const navPost = restLog.find(([m, r]) => m === 'POST' && r === '/wp/v2/navigation/9');
    assert.equal(navPost[2].body.content, '<!-- wp:navigation-link /-->');

    // footer part replaced
    assert.ok(restLog.some(([m, r]) => m === 'POST' && r.startsWith('/wp/v2/template-parts/')));

    // image budget: dry_run first, one spend per found pair, ledger entries recorded
    assert.equal(ctx.budget.calls.filter((c) => c.task_type === 'image').length, 2);
    assert.equal(ctx.ledger.entries.filter((e) => e.task_type === 'image').length, 2);
    assert.ok(existsSync(join(ctx.runDir, 'pages', 'home.html')));
});

test('S8: an unresolved deferral at the final epoch is a run failure', async () => {
    const ctx = makeCtx({
        restLog: [], toolLog: [],
        validateResult: { valid: false, epoch_ok: true, diagnostics: [{ code: 'E_UNKNOWN_BLOCK', severity: 'error', path: '/blocks/2', message: 'unknown block agent/signup-banner' }] },
    });
    await assert.rejects(s8.run(ctx), (e) => e.code === 'gate_failed' && /final epoch/.test(e.message));
});

test('screenOutline: one h1 sane, two h1s fail, level jumps fail', () => {
    const ok = [{ role: 'heading', name: 'A', level: 1 }, { role: 'heading', name: 'B', level: 2 }, { role: 'heading', name: 'C', level: 2 }];
    assert.deepEqual(screenOutline(ok), []);
    assert.ok(screenOutline([...ok, { role: 'heading', name: 'D', level: 1 }]).length > 0);
    assert.ok(screenOutline([{ role: 'heading', name: 'A', level: 1 }, { role: 'heading', name: 'X', level: 4 }]).some((f) => /jump/.test(f.message)));
});

test('S9: verify gate + exactly one screenshot; unloaded image fails', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s9-'));
    const mk = (verifyData) => ({
        runDir,
        state: { instance: { site_url: 'http://x' }, published: { pages: [{ slug: 'home', front_page: true, link: 'http://x/home/' }] } },
        log: () => {},
        shots: 0,
        call: async function (name) {
            if (name === 'wp_disconnect') return { ok: true, data: { disconnected: true } };
            if (name === 'wp_verify') return { ok: true, data: verifyData };
            if (name === 'wp_screenshot') { this.shots += 1; return { ok: true, data: { path_to_png: join(runDir, 'screenshot.png') } }; }
            throw new Error(`unexpected ${name}`);
        },
    });
    const good = mk({
        pass: true,
        box_tree: [],
        a11y_outline: [{ role: 'heading', name: 'H', level: 1 }, { role: 'heading', name: 'S', level: 2 }],
        images: [{ selector_path: 'img', box: { x: 0, y: 0, w: 1, h: 1 }, natural_w: 100, natural_h: 100, loaded: true, lazy: false }],
    });
    await s9.run(good);
    assert.equal(good.shots, 1);
    assert.ok(existsSync(join(runDir, 'verify.json')));
    await assert.rejects(s9.run(good), (e) => /second wp_screenshot/.test(e.message)); // state guards a re-run

    const bad = mk({ pass: true, box_tree: [], a11y_outline: [{ role: 'heading', name: 'H', level: 1 }], images: [{ selector_path: 'img', box: { x: 0, y: 0, w: 1, h: 1 }, natural_w: 0, natural_h: 0, loaded: false, lazy: true }] });
    await assert.rejects(s9.run(bad), (e) => e.code === 'gate_failed' && /not loaded/.test(e.message));
});

test('S9: a band clamped to the content column fails the width audit', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s9-width-'));
    const ctx = {
        runDir,
        state: { instance: { site_url: 'http://x' }, published: { pages: [] } },
        log: () => {},
        call: async (name) => {
            if (name === 'wp_disconnect') return { ok: true, data: { disconnected: true } };
            if (name === 'wp_verify') {
                return { ok: true, data: {
                    pass: true,
                    measured: { viewport: { width: 1440, height: 900 } },
                    // the field bug: the header part renders at 645px while the footer spans the row
                    box_tree: [
                        { selector_path: 'body:nth-child(2) > header.wp-block-template-part:nth-child(1)', block_name: 'core/template-part', box: { x: 397, y: 0, w: 645, h: 80 } },
                        { selector_path: 'body:nth-child(2) > footer.wp-block-template-part:nth-child(3)', block_name: 'core/template-part', box: { x: 0, y: 900, w: 1425, h: 200 } },
                    ],
                    a11y_outline: [{ role: 'heading', name: 'H', level: 1 }],
                    images: [],
                } };
            }
            throw new Error(`unexpected ${name}`);
        },
    };
    await assert.rejects(s9.run(ctx), (e) => e.code === 'gate_failed' && /clamped to the content column/.test(e.message));
});

test('S9: daylight between bands fails the seam audit', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s9-seam-'));
    const pc = 'body:nth-child(2) > main:nth-child(2) > div.wp-block-post-content:nth-child(1)';
    const ctx = {
        runDir,
        state: { instance: { site_url: 'http://x' }, published: { pages: [] } },
        log: () => {},
        call: async (name) => {
            if (name === 'wp_disconnect') return { ok: true, data: { disconnected: true } };
            if (name === 'wp_verify') {
                return { ok: true, data: {
                    pass: true,
                    measured: { viewport: { width: 1440, height: 900 } },
                    box_tree: [
                        { selector_path: 'body:nth-child(2) > header.wp-block-template-part:nth-child(1)', block_name: 'core/template-part', box: { x: 0, y: 0, w: 1425, h: 113 } },
                        { selector_path: pc, block_name: 'core/post-content', box: { x: 0, y: 113, w: 1425, h: 1019 } },
                        { selector_path: `${pc} > div.wp-block-group:nth-child(1)`, block_name: 'core/group', box: { x: 0, y: 113, w: 1425, h: 500 } },
                        { selector_path: `${pc} > div.wp-block-group:nth-child(2)`, block_name: 'core/group', box: { x: 0, y: 632, w: 1425, h: 500 } },
                        { selector_path: 'body:nth-child(2) > footer.wp-block-template-part:nth-child(3)', block_name: 'core/template-part', box: { x: 0, y: 1151, w: 1425, h: 300 } },
                    ],
                    a11y_outline: [{ role: 'heading', name: 'H', level: 1 }],
                    images: [],
                } };
            }
            throw new Error(`unexpected ${name}`);
        },
    };
    await assert.rejects(s9.run(ctx), (e) => e.code === 'gate_failed' && /page background between bands/.test(e.message));
});

test('S9: measured unreadable text fails the run; muddy text is advisory only', async () => {
    const mk = (text_contrast) => ({
        runDir: mkdtempSync(join(tmpdir(), 'x-pipeline-s9-ink-')),
        state: { instance: { site_url: 'http://x' }, published: { pages: [] } },
        logs: [],
        log(m) { this.logs.push(m); },
        call: async function (name) {
            if (name === 'wp_disconnect') return { ok: true, data: { disconnected: true } };
            if (name === 'wp_verify') return { ok: true, data: { pass: true, box_tree: [], a11y_outline: [{ role: 'heading', name: 'H', level: 1 }], images: [], text_contrast } };
            if (name === 'wp_screenshot') return { ok: true, data: { path_to_png: join(this.runDir, 'screenshot.png') } };
            throw new Error(`unexpected ${name}`);
        },
    });
    // the field bug: ink identical to the ground it sits on
    const bad = mk([{ selector_path: 'span:nth-child(1)', ratio: 1, color: 'rgb(21, 25, 29)', background: 'rgb(21, 25, 29)', sample: 'NIGHT DISPATCH' }]);
    await assert.rejects(s9.run(bad), (e) => e.code === 'gate_failed' && /unreadable text/.test(e.message));

    // 3–4.5:1 is muddy, not fatal: the run completes and says so
    const muddy = mk([{ selector_path: 'p:nth-child(2)', ratio: 3.63, color: 'rgb(108, 114, 120)', background: 'rgb(21, 25, 29)', sample: 'Hours' }]);
    await s9.run(muddy);
    assert.ok(muddy.logs.some((l) => /advisory: 1 text element/.test(l)));
});

test('the footer part is chosen by canonical slug, not by whichever has area=footer', () => {
    // Twenty Twenty-Five's real listing order: the variants come back first.
    const parts = [
        { id: 'twentytwentyfive//footer-columns', slug: 'footer-columns', area: 'footer' },
        { id: 'twentytwentyfive//footer-newsletter', slug: 'footer-newsletter', area: 'footer' },
        { id: 'twentytwentyfive//footer', slug: 'footer', area: 'footer' },
    ];
    const pick = (all) => all.find((p) => p.slug === 'footer' || String(p.id).endsWith('//footer'))
        ?? all.find((p) => p.area === 'footer');

    assert.equal(pick(parts).id, 'twentytwentyfive//footer',
        'must pick the part the theme actually renders, not the first area match');
    // A theme with only a differently-named footer part still resolves.
    assert.equal(pick([{ id: 't//site-footer', slug: 'site-footer', area: 'footer' }]).slug, 'site-footer');
    // No footer part at all is a clean miss, not a throw.
    assert.equal(pick([{ id: 't//header', slug: 'header', area: 'header' }]), undefined);
});

test('S8 with --no-images: placeholders minted, the generation pass never runs, no image call spent', async () => {
    const restLog = [];
    const toolLog = [];
    const ctx = makeCtx({ restLog, toolLog });
    ctx.state.no_images = true;
    await s8.run(ctx);

    // Placeholders still carry the design: minted, url/id set, intent preserved.
    const validated = toolLog.find(([n, a]) => n === 'wp_validate' && a.blocks.length > 1);
    const imageNodes = [];
    const walk = (ns) => ns.forEach((n) => { if (n.name === 'core/image') imageNodes.push(n); walk(n.innerBlocks ?? []); });
    walk(validated[1].blocks);
    assert.equal(imageNodes.length, 2);
    assert.ok(imageNodes.every((n) => n.attributes.url.includes('x-pixel')));
    assert.ok(imageNodes.every((n) => n.attributes.metadata.imageIntent), 'intents stay for a later fill');

    // The metered pass is skipped whole: no generate, no apply, zero image spend.
    assert.ok(!toolLog.some(([n]) => n === 'wp_images_generate' || n === 'wp_images_apply'));
    assert.ok(!ctx.budget.calls.some((c) => c.task_type === 'image'));
    assert.ok(!ctx.ledger.entries.some((e) => e.task_type === 'image'));
    // Everything before the pass still happened: installs, publish, nav, footer.
    assert.deepEqual(ctx.state.installs.map((i) => i.kind), ['schema', 'block']);
    assert.ok(restLog.some(([m, r]) => m === 'POST' && r === '/wp/v2/pages'));
});

test('placeholder tone: accent when the pixel will be swapped, surface when it ships (--no-images)', async () => {
    const restLog = [];
    const toolLog = [];
    const ctx = makeCtx({ restLog, toolLog });
    ctx.state.no_images = true;
    ctx.state.brief.palette.push({ name: 'Parchment', color: '#EFE6D8', role: 'surface' });
    await s8.run(ctx);
    const mints = toolLog.filter(([n]) => n === 'wp_placeholder');
    assert.ok(mints.length > 0);
    assert.ok(mints.every(([, a]) => a.color === '#EFE6D8'), 'shipping placeholders take the surface tone');

    // without a surface/muted/secondary role the chain falls back to accent
    const toolLog2 = [];
    const ctx2 = makeCtx({ restLog: [], toolLog: toolLog2 });
    ctx2.state.no_images = true;
    await s8.run(ctx2);
    assert.ok(toolLog2.filter(([n]) => n === 'wp_placeholder').every(([, a]) => a.color === '#D96C2C'));
});

test('a shipping placeholder takes its tone from the image\'s own band, not one site-wide pick', async () => {
    const toolLog = [];
    const ctx = makeCtx({ restLog: [], toolLog });
    ctx.state.no_images = true;
    ctx.state.brief.palette.push({ name: 'Parchment', color: '#EFE6D8', role: 'surface' });
    // The applied tokens name the bands; base here is near-black — the exact
    // field bug was ONE quiet tone shipping as a dark hole on a light band.
    writeFileSync(join(ctx.runDir, 'tokens.json'), JSON.stringify({ palette: [{ slug: 'base', name: 'B', color: '#14110C' }] }));
    // Re-root the hero's intent image INSIDE a base band; what-we-bake keeps
    // its bandless top-level image from makeCtx.
    const hero = brief.pages[0].sections.find((s) => s.id === 'hero');
    writeFileSync(join(ctx.runDir, 'trees', 'home--hero.json'), JSON.stringify({
        tree: { version: 1, epoch: 'old', blocks: [{ name: 'core/group', attributes: { backgroundColor: 'base' }, innerBlocks: [
            { name: 'core/image', attributes: { url: '', metadata: { imageIntent: hero.image_intent } }, innerBlocks: [] },
        ] }] },
        gate: { status: 'pass' },
    }));
    await s8.run(ctx);
    const mintColors = toolLog.filter(([n]) => n === 'wp_placeholder').map(([, a]) => a.color);
    const { mixHex } = await import('../lib/tokens.mjs');
    assert.ok(mintColors.includes(mixHex('#14110C', '#FFFFFF', 0.12)), 'a dark band gets its own background nudged toward the ink');
    assert.ok(mintColors.includes('#EFE6D8'), 'a slot with no band around it still takes the role-chain tone');
});

test('S8 furniture path: designed header ships with injected nav links, nav post skipped; designed footer ships', async () => {
    const restLog = [];
    const toolLog = [];
    const ctx = makeCtx({ restLog, toolLog });
    ctx.state.artifacts.furniture = { header: { status: 'pass' }, footer: { status: 'pass' } };
    writeFileSync(join(ctx.runDir, 'trees', 'furniture--header.json'), JSON.stringify({
        tree: { version: 1, epoch: 'stale', blocks: [{ name: 'core/group', attributes: { backgroundColor: 'base' }, innerBlocks: [
            { name: 'core/site-title', attributes: {}, innerBlocks: [] },
            { name: 'core/navigation', attributes: { overlayMenu: 'mobile' }, innerBlocks: [] },
        ] }] },
        gate: { status: 'pass' },
    }));
    writeFileSync(join(ctx.runDir, 'trees', 'furniture--footer.json'), JSON.stringify({
        tree: { version: 1, epoch: 'stale', blocks: [{ name: 'core/group', attributes: { backgroundColor: 'contrast' }, innerBlocks: [
            { name: 'core/paragraph', attributes: { content: 'designed footer' }, innerBlocks: [] },
        ] }] },
        gate: { status: 'pass' },
    }));
    await s8.run(ctx);

    // The header tree was validated at the FINAL epoch with the nav links injected.
    const headerValidate = toolLog.find(([n, a]) => n === 'wp_validate'
        && a.blocks[0]?.innerBlocks?.some((b) => b.name === 'core/navigation'));
    assert.ok(headerValidate, 'designed header validated');
    assert.equal(headerValidate[1].epoch, 'f-install-2');
    const navNode = headerValidate[1].blocks[0].innerBlocks.find((b) => b.name === 'core/navigation');
    assert.equal(navNode.innerBlocks.length, ctx.state.brief.navigation.items.length, 'flat links injected');
    assert.equal(navNode.attributes.overlayMenu, 'mobile', 'designed attributes kept');

    // Both parts written; the nav post lane never ran.
    assert.ok(restLog.some(([m, r]) => m === 'POST' && r === `/wp/v2/template-parts/${encodeURIComponent('theme//header')}`));
    assert.ok(restLog.some(([m, r]) => m === 'POST' && r === `/wp/v2/template-parts/${encodeURIComponent('theme//footer')}`));
    assert.ok(!restLog.some(([m, r]) => r.startsWith('/wp/v2/navigation')), 'nav post skipped when the header part ships');
    assert.equal(ctx.state.published.header_part, 'theme//header');
});

test('S8 furniture fallback: failed parts degrade to the nav post and the deterministic footer', async () => {
    const restLog = [];
    const toolLog = [];
    const ctx = makeCtx({ restLog, toolLog });
    ctx.state.artifacts.furniture = { header: { status: 'fail' }, footer: { status: 'fail' } };
    await s8.run(ctx);
    // exactly the pre-furniture behavior: nav post written, hardcoded footer compiled
    assert.ok(restLog.some(([m, r]) => m === 'POST' && r.startsWith('/wp/v2/navigation')));
    assert.ok(restLog.some(([m, r]) => m === 'POST' && r === `/wp/v2/template-parts/${encodeURIComponent('theme//footer')}`));
    assert.ok(!restLog.some(([m, r]) => r.includes('theme%2F%2Fheader')), 'theme header untouched');
});

test('assembleSplitPage: panes routed by declaration, order preserved, one full frame', async () => {
    const { assembleSplitPage, SPLIT_SECONDARY_SIZE } = await import('../lib/skeleton.mjs');
    const block = (id, pane) => ({ name: 'core/group', attributes: { ...(pane ? { metadata: { pane } } : {}) }, innerBlocks: [{ name: 'core/heading', attributes: { content: id } }] });
    const out = assembleSplitPage([block('a', 'primary'), block('b', 'secondary'), block('c', 'primary'), block('d')]);
    assert.equal(out.length, 1);
    const frame = out[0];
    assert.equal(frame.attributes.align, 'full');
    assert.equal(frame.attributes.className, 'x-split-frame');
    const [primary, secondary] = frame.innerBlocks;
    assert.equal(primary.attributes.className, 'x-pane-primary');
    assert.equal(secondary.attributes.className, 'x-pane-secondary');
    assert.equal(secondary.attributes.style.layout.flexSize, SPLIT_SECONDARY_SIZE);
    // a, c, and undeclared d in primary (brief order); b in secondary
    assert.deepEqual(primary.innerBlocks.map((b) => b.innerBlocks[0].attributes.content), ['a', 'c', 'd']);
    assert.deepEqual(secondary.innerBlocks.map((b) => b.innerBlocks[0].attributes.content), ['b']);
});

test('S8 split skeleton: the published page tree is ONE two-pane frame (theme-factory M4)', async () => {
    const restLog = [];
    const toolLog = [];
    const ctx = makeCtx({ restLog, toolLog, theme: { skeleton: 'split' } });
    // Real S4 trees are ONE root per section (the band-root gate); rewrite the
    // mold's synthetic multi-root fixtures into that shape, panes declared.
    const paneTree = (key, pane) => ({
        tree: { version: 1, epoch: 'old', blocks: [{ name: 'core/group', attributes: { metadata: { pane } }, innerBlocks: [{ name: 'core/heading', attributes: { content: key } }] }] },
        gate: { status: 'pass' },
    });
    writeFileSync(join(ctx.runDir, 'trees', 'home--hero.json'), JSON.stringify(paneTree('home--hero', 'primary')));
    writeFileSync(join(ctx.runDir, 'trees', 'home--what-we-bake.json'), JSON.stringify(paneTree('home--what-we-bake', 'secondary')));
    writeFileSync(join(ctx.runDir, 'trees', 'home--signup.json'), JSON.stringify(paneTree('home--signup', 'primary')));
    await s8.run(ctx);
    const validated = toolLog.find(([n, a]) => n === 'wp_validate' && a.blocks?.[0]?.attributes?.className === 'x-split-frame');
    assert.ok(validated, 'the assembled page tree is the split frame');
    const frame = validated[1].blocks[0];
    assert.equal(validated[1].blocks.length, 1);
    const [primary, secondary] = frame.innerBlocks;
    assert.equal(primary.innerBlocks.length, 2);
    assert.equal(secondary.innerBlocks.length, 1);
});

test('S8 rail skeleton: the designed rail part ships with area "rail" (theme-factory M4)', async () => {
    const restLog = [];
    const toolLog = [];
    const ctx = makeCtx({
        restLog, toolLog,
        theme: { skeleton: 'rail' },
        furniture: { rail: { status: 'pass' } },
    });
    writeFileSync(join(ctx.runDir, 'trees', 'furniture--rail.json'), JSON.stringify({
        tree: { version: 1, epoch: 'old', blocks: [{ name: 'core/group', attributes: { layout: { type: 'default' } }, innerBlocks: [{ name: 'core/site-title', attributes: {}, innerBlocks: [] }] }] },
        gate: { status: 'pass' },
    }));
    await s8.run(ctx);
    const railWrite = restLog.find(([m, r, o]) => m === 'POST' && r.startsWith('/wp/v2/template-parts/') && o?.body?.area === 'rail');
    assert.ok(railWrite, 'the rail part was written with its area');
    assert.match(railWrite[1], /rail/);
});
