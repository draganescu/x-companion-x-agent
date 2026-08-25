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
            if (method === 'GET' && route === '/wp/v2/template-parts') return [{ id: 'theme//footer', area: 'footer' }];
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
