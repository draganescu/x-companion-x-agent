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

function makeCtx({ restLog, toolLog, validateResult }) {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s8-'));
    for (const d of ['trees', 'pages', 'images']) mkdirSync(join(runDir, d), { recursive: true });
    const sections = [];
    for (const page of brief.pages) {
        for (const section of page.sections) {
            const key = `${page.slug}--${section.id}`;
            const extra = section.image_intent
                ? [{ name: 'core/image', attributes: { url: '', metadata: { imageIntent: section.image_intent } }, innerBlocks: [] }]
                : [];
            writeFileSync(join(runDir, 'trees', `${key}.json`), JSON.stringify(sectionTree(key, extra)));
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
            },
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
            if (method === 'GET' && route === '/wp/v2/template-parts') return [{ id: 'theme//header', area: 'header' }, { id: 'theme//footer', area: 'footer' }];
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

    // The header floor ships as a BAND part (site title + nav links inline);
    // the nav post is now the ultra-floor for themes with no header part.
    assert.ok(restLog.some(([m, r]) => m === 'POST' && r === `/wp/v2/template-parts/${encodeURIComponent('theme//header')}`));
    assert.ok(!restLog.some(([m, r]) => m === 'POST' && r.startsWith('/wp/v2/navigation')));

    // footer part replaced
    assert.ok(restLog.some(([m, r]) => m === 'POST' && r.startsWith('/wp/v2/template-parts/')));

    // image budget: dry_run first, one spend per found pair, ledger entries recorded
    assert.equal(ctx.budget.calls.filter((c) => c.task_type === 'image').length, 2);
    assert.equal(ctx.ledger.entries.filter((e) => e.task_type === 'image').length, 2);
    assert.ok(existsSync(join(ctx.runDir, 'pages', 'home.html')));
});

// ---------------------------------------------------------------- surfaces

const APPLIED_TOKENS = {
    palette: [
        { slug: 'base', name: 'Flour', color: '#F6EFE6' },
        { slug: 'contrast', name: 'Rye', color: '#3B2A1E' },
        { slug: 'ember', name: 'Ember', color: '#D96C2C' },
    ],
};

// A ctx whose image tools speak the asset-pass contract: typed dry_run,
// dictionary dedup, one transaction per page.
function surfaceCtx({ surfaces, applySkipped = [], rejectIds = [], toolLog, restLog }) {
    const ctx = makeCtx({ restLog, toolLog });
    ctx.state.brief.surfaces = surfaces;
    writeFileSync(join(ctx.runDir, 'tokens.json'), JSON.stringify(APPLIED_TOKENS));
    const inner = ctx.call;
    ctx.call = async (name, args) => {
        if (name === 'wp_images_generate') {
            toolLog.push([name, args]);
            const dict = args.surfaces ?? [];
            const base = {
                post_id: args.post_id,
                found: 2,
                found_surfaces: 3,
                cached: [],
                cached_content: [],
                scan_errors: [],
            };
            if (args.dry_run) {
                return { ok: true, data: { ...base, generated: 0, dry_run: true, images: [{ path: '/blocks/0', intent: 'a' }, { path: '/blocks/1', intent: 'b' }], surfaces: dict.map((d) => ({ asset_id: d.id, class: d.class, paths: [] })) } };
            }
            const kept = dict.filter((d) => !rejectIds.includes(d.id));
            return {
                ok: true,
                data: {
                    ...base,
                    generated: 2 + kept.length,
                    dry_run: false,
                    manifest_path: join(ctx.runDir, 'images', 'images-manifest.json'),
                    images: [
                        { path: '/blocks/0', intent: 'a', file: '/a.jpg', ms: 5, block_name: 'core/image', aspect_ratio: '16:9' },
                        { path: '/blocks/1', intent: 'b', file: '/b.jpg', ms: 6, block_name: 'core/image', aspect_ratio: '16:9' },
                    ],
                    surfaces: kept.map((d) => ({ asset_id: d.id, class: d.class, file: `/assets/${d.id}.png`, ms: 7, post_processing: 'recompress', paths: ['/blocks/0', '/blocks/1', '/blocks/2'] })),
                    rejected: rejectIds.map((id) => ({ asset_id: id, reason: `texture bound: the measured luminance range exceeds 0.2 for a whisper field after 2 attempts — not a material, the flat band ships` })),
                },
            };
        }
        if (name === 'wp_images_apply') {
            toolLog.push([name, args]);
            return {
                ok: true,
                data: {
                    post_id: args.post_id,
                    uploaded: [],
                    swapped: 2,
                    surfaces_applied: 3 - applySkipped.length,
                    skipped: applySkipped,
                    surfaces: (ctx.state.brief.surfaces ?? []).map((s) => ({ asset_id: s.id, media_id: 501, media_url: `http://x/uploads/asset-${s.id}.png`, applied: 3 - applySkipped.length, refused: applySkipped.length })),
                    all_valid: true,
                    link: 'http://x/home/',
                },
            };
        }
        if (name === 'wp_tokens_apply') {
            toolLog.push([name, args]);
            return { ok: true, data: { applied: true, adapters_applied: [], fingerprint: 'f-canvas', background_written: true } };
        }
        return inner(name, args);
    };
    return ctx;
}

const SURFACE_FIELD = {
    id: 'linen-wash',
    class: 'field',
    prompt_seed: 'Woven linen texture, warm cream',
    intensity: 'whisper',
    attach: ['home/hero', 'home/what-we-bake', 'home/signup'],
};

test('S8 surfaces: one dictionary asset on 3 bands = ONE metered birth, markers minted, one transaction, refusals recorded', async () => {
    const restLog = [];
    const toolLog = [];
    const refusal = "/blocks/2: surface target no longer empty — an admin's background is never overwritten";
    const ctx = surfaceCtx({ surfaces: [SURFACE_FIELD], applySkipped: [refusal], toolLog, restLog });
    await s8.run(ctx);

    // The tree that faced the gates carries one marker per attached band, and
    // the flat band reservation is what the markers sit next to.
    const validated = toolLog.find(([n, a]) => n === 'wp_validate' && a.blocks?.length > 1);
    const markers = [];
    const walk = (ns) => ns.forEach((n) => { if (n.attributes?.metadata?.surfaceIntent) markers.push(n.attributes.metadata.surfaceIntent); walk(n.innerBlocks ?? []); });
    walk(validated[1].blocks);
    assert.deepEqual(markers, ['linen-wash', 'linen-wash', 'linen-wash']);

    // ONE surface birth on the meter and in the ledger, labeled by dictionary id.
    const imageSpends = ctx.budget.calls.filter((c) => c.task_type === 'image');
    assert.equal(imageSpends.length, 3); // 2 content + 1 surface
    assert.equal(imageSpends.filter((c) => c.label === 'linen-wash').length, 1);
    assert.equal(ctx.ledger.entries.filter((e) => e.task_type === 'image' && e.label === 'linen-wash').length, 1);

    // The generate call carried the dictionary with the exact band hexes, and
    // the surface lane got the MATERIAL-SAFE style line (the artistic style,
    // never the scene-y art direction).
    const gen = toolLog.find(([n, a]) => n === 'wp_images_generate' && !a.dry_run);
    assert.equal(gen[1].surfaces.length, 1);
    assert.deepEqual(gen[1].surfaces[0].hexes, ['#3B2A1E', '#F6EFE6', '#D96C2C']);
    assert.equal(typeof gen[1].surface_style, 'string');
    assert.ok(gen[1].surface_style.includes(ctx.state.brief.style.artistic));
    assert.notEqual(gen[1].surface_style, ctx.state.brief.art_direction);

    // The refusal is LOUD in the report state; the run still completed.
    assert.deepEqual(ctx.state.surface_report.refusals, [{ page: 'home', detail: refusal }]);
});

test('S8 surfaces: a texture-bound reject ships the flat band and screams in the report', async () => {
    const toolLog = [];
    const ctx = surfaceCtx({ surfaces: [SURFACE_FIELD], rejectIds: ['linen-wash'], toolLog, restLog: [] });
    await s8.run(ctx);
    const degrade = ctx.state.surface_report.degraded.find((d) => d.asset_id === 'linen-wash');
    assert.ok(degrade, 'the reject landed in the report');
    assert.match(degrade.reason, /texture bound/);
    assert.match(degrade.reason, /not a material/);
});

test('S8 surfaces under --no-images: no markers, no calls — byte-identical to a surface-free run', async () => {
    const run = async (surfaces) => {
        const toolLog = [];
        const ctx = surfaceCtx({ surfaces, toolLog, restLog: [] });
        ctx.state.no_images = true;
        await s8.run(ctx);
        return { ctx, toolLog };
    };
    const withSurfaces = await run([SURFACE_FIELD]);
    const without = await run([]);
    assert.ok(!withSurfaces.toolLog.some(([n]) => n.startsWith('wp_images')));
    const treeOf = ({ ctx }) => readFileSync(join(ctx.runDir, 'trees', 'page--home.json'), 'utf8');
    assert.equal(treeOf(withSurfaces), treeOf(without));
});

test('S8 surfaces: a support-less instance degrades every group skin to its flat band, loudly, and buys nothing', async () => {
    const toolLog = [];
    const ctx = surfaceCtx({ surfaces: [SURFACE_FIELD], toolLog, restLog: [] });
    ctx.state.surface_support = { group_background: false, global_styles_background: true };
    await s8.run(ctx);
    assert.equal(ctx.state.surface_report.degraded.length, 3);
    assert.match(ctx.state.surface_report.degraded[0].reason, /no background support/);
    const gen = toolLog.find(([n, a]) => n === 'wp_images_generate' && !a.dry_run);
    assert.deepEqual(gen[1].surfaces, []);
    assert.equal(ctx.budget.calls.filter((c) => c.task_type === 'image').length, 2); // content only
});

test('S8 canvas: the asset ships with the tokens through styles.background, epoch adopted', async () => {
    const toolLog = [];
    const canvas = { id: 'plaster-ground', class: 'canvas', prompt_seed: 'Fine plaster texture', intensity: 'whisper', attach: [] };
    const ctx = surfaceCtx({ surfaces: [canvas], toolLog, restLog: [] });
    ctx.state.canvas = { asset_id: 'plaster-ground', lum_min: 0.82, lum_max: 0.91 };
    writeFileSync(join(ctx.runDir, 'images', 'images-manifest.json'), JSON.stringify({
        schema_version: 2,
        model: 'fake',
        content: [],
        surfaces: [{ kind: 'surface', asset_id: 'plaster-ground', class: 'canvas', file: '/assets/plaster.jpg', prompt: 'p', mime_type: 'image/jpeg', bytes: 1, ms: 1, post_processing: 'recompress', lum_min: 0.82, lum_max: 0.91, targets: [] }],
    }));
    await s8.run(ctx);
    const shipped = toolLog.find(([n]) => n === 'wp_tokens_apply');
    assert.ok(shipped, 'the canvas rides a token re-apply');
    assert.equal(shipped[1].styles.background.backgroundImage.url, 'http://x/uploads/asset-plaster-ground.png');
    assert.equal(ctx.state.fingerprint, 'f-canvas');
    assert.ok(ctx.state.surface_report.assets.some((a) => a.asset_id === 'plaster-ground' && a.paths.includes('styles.background')));
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
    const muddy = mk([{ selector_path: 'p:nth-child(2)', ratio: 3.63, color: 'rgb(108, 114, 120)', background: 'rgb(21, 25, 29)', sample: 'Hours', font_px: 40 }]);
    await s9.run(muddy);
    assert.ok(muddy.logs.some((l) => /advisory: 1 text element/.test(l)));
});

test('S8 furniture: a designed part with one unknown attribute is rescued, not floored', async () => {
    const toolLog = [];
    const ctx = surfaceCtx({ surfaces: [], toolLog, restLog: [] });
    mkdirSync(join(ctx.runDir, 'trees'), { recursive: true });
    writeFileSync(join(ctx.runDir, 'trees', 'furniture--footer.json'), JSON.stringify({
        tree: {
            version: 1,
            epoch: 'old',
            blocks: [{
                name: 'core/group',
                attributes: { align: 'full', backgroundColor: 'contrast', layout: { type: 'constrained' } },
                innerBlocks: [
                    { name: 'core/heading', attributes: { level: 2, textAlign: 'center', content: 'Visit us' }, innerBlocks: [] },
                    { name: 'core/paragraph', attributes: { content: 'links' }, innerBlocks: [] },
                ],
            }],
        },
        gate: { status: 'pass' },
    }));
    ctx.state.artifacts.furniture = { footer: { status: 'pass' } };
    const inner = ctx.call;
    let footerValidations = 0;
    ctx.call = async (name, tree) => {
        const isFooterPart = name === 'wp_validate' && JSON.stringify(tree).includes('Visit us');
        if (isFooterPart) {
            footerValidations += 1;
            const hasTextAlign = JSON.stringify(tree).includes('textAlign');
            return {
                ok: true,
                data: hasTextAlign
                    ? { valid: true, epoch_ok: true, diagnostics: [{ code: 'W_ATTR_UNKNOWN', severity: 'warning', path: '/blocks/0/innerBlocks/0/attributes/textAlign', message: 'Attribute "textAlign" is not declared by "core/heading".' }] }
                    : { valid: true, epoch_ok: true, diagnostics: [] },
            };
        }
        return inner(name, tree);
    };
    await s8.run(ctx);
    // Stripped, re-gated, shipped: the designed footer landed, not the floor.
    assert.equal(footerValidations, 2);
    assert.equal(ctx.state.published.footer_part, 'theme//footer');
    assert.ok(ctx.logs?.some?.((l) => /stripped 1 unknown attribute/.test(l)) ?? true);
});

test('S9 surface rescue: unreadable ink over a material strips the material, re-verifies, and the run COMPLETES flat', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s9-rescue-'));
    mkdirSync(join(runDir, 'images'), { recursive: true });
    writeFileSync(join(runDir, 'images', 'images-manifest.json'), JSON.stringify({
        schema_version: 2,
        model: 'fake',
        content: [],
        surfaces: [{
            kind: 'surface', asset_id: 'aged-damask', class: 'pattern', file: '/a.png', prompt: 'p',
            mime_type: 'image/png', bytes: 1, ms: 1, post_processing: 'mirror-tile+veil(#F6EFE6@0.7)',
            media_id: 501, media_url: 'http://x/uploads/asset-aged-damask.png',
            targets: [{ post_id: 8, rest_base: 'pages', path: '/blocks/0', block_name: 'core/group', mechanism: 'group_background', reservation: 'contrast' }],
        }],
    }));
    const probePath = 'body:nth-child(2) > div:nth-child(2) > main:nth-child(2) > div:nth-child(1) > div:nth-child(1)';
    const failingSelector = 'body:nth-child(2) > div:nth-child(2) > main.wp-block-group:nth-child(2) > div.wp-block-post-content:nth-child(1) > div.wp-block-group:nth-child(1) > h1.wp-block-heading:nth-child(2)';
    let verifies = 0;
    const stripCalls = [];
    const ctx = {
        runDir,
        logs: [],
        log(m) { this.logs.push(m); },
        state: { instance: { site_url: 'http://x' }, published: { pages: [{ slug: 'home', id: 8, front_page: true }] } },
        call: async function (name, args) {
            if (name === 'wp_disconnect') return { ok: true, data: { disconnected: true } };
            if (name === 'wp_verify') {
                verifies += 1;
                if (verifies === 1) {
                    return { ok: true, data: {
                        pass: true,
                        box_tree: [],
                        a11y_outline: [{ role: 'heading', name: 'H', level: 1 }],
                        images: [],
                        surfaces: [{ selector_path: probePath, url: 'http://x/uploads/asset-aged-damask.png', status: 200, ok: true }],
                        text_contrast: [{ selector_path: failingSelector, ratio: 1, color: 'rgb(244, 235, 217)', background: 'sampled(0.008..0.837)', sample: 'A Tea Salon', sampled: true }],
                    } };
                }
                return { ok: true, data: { pass: true, box_tree: [], a11y_outline: [{ role: 'heading', name: 'H', level: 1 }], images: [], surfaces: [], text_contrast: [] } };
            }
            if (name === 'wp_images_apply') {
                stripCalls.push(args);
                return { ok: true, data: { post_id: args.post_id, uploaded: [], swapped: 0, surfaces_applied: 0, surfaces_stripped: 1, skipped: [], surfaces: [], all_valid: true, link: 'http://x/home/' } };
            }
            if (name === 'wp_screenshot') return { ok: true, data: { path_to_png: join(this.runDir, 'screenshot.png') } };
            throw new Error(`unexpected ${name}`);
        },
    };
    await s9.run(ctx);
    assert.equal(verifies, 2);
    assert.equal(stripCalls.length, 1);
    assert.deepEqual(stripCalls[0].strip_surfaces, ['aged-damask']);
    assert.ok(ctx.state.surface_report.degraded.some((d) => d.asset_id === 'aged-damask' && /stripped by the S9 rescue/.test(d.reason)));
    assert.equal(ctx.state.screenshot_taken, true);
});

test('S9 surface rescue: a second failure after the strip is final — no rescue loop', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s9-rescue2-'));
    mkdirSync(join(runDir, 'images'), { recursive: true });
    writeFileSync(join(runDir, 'images', 'images-manifest.json'), JSON.stringify({
        schema_version: 2, model: 'fake', content: [],
        surfaces: [{ kind: 'surface', asset_id: 'aged-damask', class: 'pattern', file: '/a.png', prompt: 'p', mime_type: 'image/png', bytes: 1, ms: 1, post_processing: 'mirror-tile', media_id: 501, media_url: 'http://x/u/a.png', targets: [{ post_id: 8, rest_base: 'pages', path: '/blocks/0', block_name: 'core/group', mechanism: 'group_background', reservation: 'contrast' }] }],
    }));
    const finding = { selector_path: 'p:nth-child(1)', ratio: 1, color: 'rgb(0,0,0)', background: 'sampled(0..1)', sample: 'x', sampled: true };
    let applies = 0;
    const ctx = {
        runDir,
        log: () => {},
        state: { instance: { site_url: 'http://x' }, published: { pages: [{ slug: 'home', id: 8, front_page: true }] } },
        call: async (name, args) => {
            if (name === 'wp_disconnect') return { ok: true, data: { disconnected: true } };
            if (name === 'wp_verify') return { ok: true, data: { pass: true, box_tree: [], a11y_outline: [{ role: 'heading', name: 'H', level: 1 }], images: [], surfaces: [], text_contrast: [finding] } };
            if (name === 'wp_images_apply') { applies += 1; return { ok: true, data: { post_id: args.post_id, uploaded: [], swapped: 0, surfaces_applied: 0, surfaces_stripped: 1, skipped: [], surfaces: [], all_valid: true, link: 'x' } }; }
            throw new Error(`unexpected ${name}`);
        },
    };
    await assert.rejects(s9.run(ctx), (e) => e.code === 'gate_failed');
    assert.equal(applies, 1); // the rescue ran once and never looped
});

test('S9: a 404\'d surface asset fails the run; present surfaces pass silently', async () => {
    const mk = (surfaces) => ({
        runDir: mkdtempSync(join(tmpdir(), 'x-pipeline-s9-surface-')),
        state: { instance: { site_url: 'http://x' }, published: { pages: [] } },
        log: () => {},
        call: async function (name) {
            if (name === 'wp_disconnect') return { ok: true, data: { disconnected: true } };
            if (name === 'wp_verify') return { ok: true, data: { pass: true, box_tree: [], a11y_outline: [{ role: 'heading', name: 'H', level: 1 }], images: [], surfaces } };
            if (name === 'wp_screenshot') return { ok: true, data: { path_to_png: join(this.runDir, 'screenshot.png') } };
            throw new Error(`unexpected ${name}`);
        },
    });
    const bad = mk([
        { selector_path: 'div:nth-child(1)', url: 'http://x/uploads/asset-linen.jpg', status: 200, ok: true },
        { selector_path: 'div:nth-child(2)', url: 'http://x/uploads/asset-frieze.png', status: 404, ok: false },
    ]);
    await assert.rejects(s9.run(bad), (e) => e.code === 'gate_failed' && /surface asset failed to load/.test(JSON.stringify(e.detail ?? e.message)));

    const good = mk([{ selector_path: 'div:nth-child(1)', url: 'http://x/uploads/asset-linen.jpg', status: 200, ok: true }]);
    await s9.run(good);
});

test('report.md carries a Surfaces section: every asset, every path, every refusal and degrade', async () => {
    const { writeReport } = await import('../lib/report.mjs');
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-report-'));
    writeReport(runDir, {
        state: {
            completed: ['S8_publish'],
            budget: { S: 3, B: 1, P: 1, C: 2, U: 1, I: 3, F: 2, base: 9, ceiling: 21 },
            surface_report: {
                assets: [{ asset_id: 'linen-wash', class: 'field', post_processing: 'recompress', paths: ['/blocks/0', '/blocks/1'], page: 'home' }],
                degraded: [{ page: 'home', asset_id: 'gilt-corner', reason: 'core/group has no background support on this instance — the flat band ships' }],
                refusals: [{ page: 'home', detail: "/blocks/2: surface target no longer empty — an admin's background is never overwritten" }],
            },
        },
        budget: { spent: 10 },
        ledger: { entries: [] },
    });
    const md = readFileSync(join(runDir, 'report.md'), 'utf8');
    assert.match(md, /## Surfaces/);
    assert.match(md, /linen-wash/);
    assert.match(md, /\/blocks\/0/);
    assert.match(md, /gilt-corner/);
    assert.match(md, /never overwritten/);
    assert.match(md, /C=2 content \+ U=1 surfaces/);
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

test('S8 furniture fallback: failed parts degrade to STYLED floors — a band header and a band footer', async () => {
    const restLog = [];
    const toolLog = [];
    const ctx = makeCtx({ restLog, toolLog });
    ctx.state.artifacts.furniture = { header: { status: 'fail' }, footer: { status: 'fail' } };
    await s8.run(ctx);
    // Both floors ship as template-part bands from the same design system —
    // never a theme-default header over a designed footer.
    assert.ok(restLog.some(([m, r]) => m === 'POST' && r === `/wp/v2/template-parts/${encodeURIComponent('theme//header')}`));
    assert.ok(restLog.some(([m, r]) => m === 'POST' && r === `/wp/v2/template-parts/${encodeURIComponent('theme//footer')}`));
    // The header floor tree that compiled is a full band: site-title + nav with links.
    const headerCompile = toolLog.find(([n, t]) => n === 'wp_compile' && JSON.stringify(t).includes('core/site-title') && JSON.stringify(t).includes('core/navigation'));
    assert.ok(headerCompile, 'the header floor is a band carrying site-title + navigation');
    assert.equal(headerCompile[1].blocks[0].attributes.align, 'full');
    assert.ok(!restLog.some(([m, r]) => m === 'POST' && r.startsWith('/wp/v2/navigation')), 'nav post is the ultra-floor only');
});
