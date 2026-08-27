import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenTreeDiagnostics, screenTreeLiterals, localTreeCheck, screenFileMap, screenBlockCss, blockGate, schemaGate, styleLiteralSeverity, screenImageGeometry, screenBandRoot, screenBandWidths, screenBandSeams, screenTextContrast, screenContentParity } from '../lib/gates.mjs';

const diag = (code, severity, message = '', path = '/blocks/0') => ({ code, severity, path, message });

test('screenTreeDiagnostics: clean and harness-warning trees pass', () => {
    assert.equal(screenTreeDiagnostics({ valid: true, diagnostics: [] }).status, 'pass');
    const r = screenTreeDiagnostics({ valid: true, diagnostics: [diag('W_STATIC_NEEDS_HARNESS', 'warning')] });
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.deferred, []);
});

test('screenTreeDiagnostics: W_ATTR_UNKNOWN and W_STYLE_UNKNOWN fail the artifact', () => {
    for (const code of ['W_ATTR_UNKNOWN', 'W_STYLE_UNKNOWN']) {
        const r = screenTreeDiagnostics({ valid: true, diagnostics: [diag(code, 'warning')] });
        assert.equal(r.status, 'fail');
        assert.equal(r.failures[0].code, code);
    }
});

test('screenTreeDiagnostics: E_UNKNOWN_BLOCK defers only brief-declared agent blocks', () => {
    const allowed = new Set(['agent/signup-banner']);
    const ok = screenTreeDiagnostics(
        { valid: false, diagnostics: [diag('E_UNKNOWN_BLOCK', 'error', 'unknown block agent/signup-banner')] },
        { allowedUnknown: allowed });
    assert.equal(ok.status, 'pass');
    assert.deepEqual(ok.deferred, ['agent/signup-banner']);

    const bad = screenTreeDiagnostics(
        { valid: false, diagnostics: [diag('E_UNKNOWN_BLOCK', 'error', 'unknown block agent/ghost')] },
        { allowedUnknown: allowed });
    assert.equal(bad.status, 'fail');

    const err = screenTreeDiagnostics({ valid: false, diagnostics: [diag('E_NEST_PARENT', 'error', 'bad nesting')] }, { allowedUnknown: allowed });
    assert.equal(err.status, 'fail');
});

test('localTreeCheck: epoch, shape, and smuggled markup', () => {
    const good = { version: 1, epoch: 'f2', blocks: [{ name: 'core/group', attributes: {}, innerBlocks: [{ name: 'core/heading', attributes: { content: 'Hi' } }] }] };
    assert.deepEqual(localTreeCheck(good, { epoch: 'f2' }), []);

    const staleEpoch = localTreeCheck({ ...good, epoch: 'f1' }, { epoch: 'f2' });
    assert.ok(staleEpoch.some((i) => i.path === '/epoch'));

    const smuggled = structuredClone(good);
    smuggled.blocks[0].innerHTML = '<div>no</div>';
    assert.ok(localTreeCheck(smuggled, { epoch: 'f2' }).some((i) => /innerHTML/.test(i.path)));

    const badName = structuredClone(good);
    badName.blocks[0].name = 'notablock';
    assert.ok(localTreeCheck(badName, { epoch: 'f2' }).some((i) => i.path.endsWith('/name')));

    assert.ok(localTreeCheck({ version: 1, epoch: 'f2', blocks: [] }, { epoch: 'f2' }).length > 0);
});

test('screenFileMap: allowed names only, root-level only, strings only', () => {
    const allowed = new Set(['render.php', 'view.js', 'style.css']);
    assert.deepEqual(screenFileMap({ files: { 'render.php': '<?php' } }, { allowed }), []);
    assert.ok(screenFileMap({ files: { 'block.json': '{}' } }, { allowed }).length > 0);
    assert.ok(screenFileMap({ files: { '../evil.php': 'x' } }, { allowed }).some((i) => /basenames/.test(i.message)));
    assert.ok(screenFileMap({ files: { 'render.php': 42 } }, { allowed }).length > 0);
    assert.ok(screenFileMap({ nope: true }, { allowed }).length > 0);
});

test('blockGate: pass, built:false, style literals, front console errors', () => {
    const pass = blockGate({ ok: true, data: { built: true, zip_path: '/z.zip', smoke: { registered: true, rendered_html: '<x>', front: { console_errors: [], view_ready: true, block_present: true } } } });
    assert.equal(pass.status, 'pass');

    const notBuilt = blockGate({ ok: true, data: { built: false, smoke: { registered: false, rendered_html: '' }, failure: { code: 'build_failed', message: 'tsc died', hint: '' } } });
    assert.equal(notBuilt.status, 'fail');
    assert.equal(notBuilt.failures[0].code, 'build_failed');

    const literal = blockGate({ ok: true, data: { built: true, zip_path: '/z.zip', smoke: { registered: true, rendered_html: '<x>' }, style_warnings: [{ line: 3, literal: '#c8102e', text: 'color: #c8102e' }] } });
    assert.equal(literal.status, 'fail');
    assert.match(literal.failures[0].message, /#c8102e/);

    const consoleErr = blockGate({ ok: true, data: { built: true, zip_path: '/z.zip', smoke: { registered: true, rendered_html: '<x>', front: { console_errors: ['ReferenceError: x'] } } } });
    assert.equal(consoleErr.status, 'fail');

    const thrown = blockGate({ ok: false, data: { code: 'build_failed', message: 'npm install failed', hint: 'network' } });
    assert.equal(thrown.status, 'fail');
});

test('schemaGate: thrown envelope is the failure lane; success needs uninstall_clean', () => {
    const fail = schemaGate({ ok: false, data: { code: 'schema_policy', message: 'direct $wpdb use', hint: '', smoke: { booted: false } } });
    assert.equal(fail.status, 'fail');
    assert.equal(fail.failures[0].code, 'schema_policy');

    const dirty = schemaGate({ ok: true, data: { built: true, zip_path: '/z.zip', smoke: { uninstall_clean: false } } });
    assert.equal(dirty.status, 'fail');

    const pass = schemaGate({ ok: true, data: { built: true, zip_path: '/z.zip', smoke: { uninstall_clean: true } } });
    assert.equal(pass.status, 'pass');
});

test('screenFileMap rejects file-level non-compound use in PHP; compound namespaces pass', () => {
    const allowed = new Set(['routes.php', 'view.js']);
    const bad = screenFileMap({ files: { 'routes.php': '<?php\nuse WP_REST_Server;\n' } }, { allowed });
    assert.ok(bad.some((i) => /PHP warning on every request/.test(i.message)));
    const okCompound = screenFileMap({ files: { 'routes.php': '<?php\nuse Vendor\\Thing\\Helper;\n' } }, { allowed });
    assert.deepEqual(okCompound, []);
    const js = screenFileMap({ files: { 'view.js': 'use strict;' } }, { allowed });
    assert.deepEqual(js, []); // .php only
});

test('salvageJson digs the payload out of a notice-prefixed body', async () => {
    const { salvageJson } = await import('../lib/rest.mjs');
    const body = '<br />\n<b>Warning</b>: something in routes.php on line 13<br />\n[{"id":7,"slug":"home"}]';
    assert.deepEqual(salvageJson(body), [{ id: 7, slug: 'home' }]);
    assert.throws(() => salvageJson('<br/>just junk'));
});

test('styleLiteralSeverity: hard only where a preset exists to spend through', () => {
    const sev = (literal, text) => styleLiteralSeverity({ literal, text });
    // A preset exists — a literal here bypasses the design system.
    assert.equal(sev('#c47a2b', 'color: #c47a2b;'), 'fail');
    assert.equal(sev('16px', 'font-size: 16px;'), 'fail');
    assert.equal(sev('1.5rem', 'padding-block: 1.5rem;'), 'fail');
    assert.equal(sev('2rem', 'margin: 2rem;'), 'fail');
    assert.equal(sev('24px', 'gap: 24px;'), 'fail');
    // No preset can express these — failing them makes the gate unsatisfiable.
    assert.equal(sev('0.08em', 'letter-spacing: 0.08em;'), 'warn');
    assert.equal(sev('999px', 'border-radius: 999px;'), 'warn');
    assert.equal(sev('1px', 'border-bottom: 1px solid var( --wp--preset--color--x );'), 'warn');
    assert.equal(sev('1px', 'width: 1px;'), 'warn');
    // CSS forbids var() inside a media query condition; a hard fail here would
    // ban responsive block stylesheets outright.
    assert.equal(sev('600px', '@media ( max-width: 600px ) {'), 'warn');
    // rem is not em: 1.5rem on a spacing property is still a real bypass.
    assert.notEqual(sev('1.5rem', 'padding: 1.5rem;'), 'warn');
});

test('blockGate: advisory literals do not fail the artifact, hard ones do', () => {
    const built = (styleWarnings) => ({ ok: true, data: { built: true, zip_path: '/z.zip', style_warnings: styleWarnings } });
    const soft = blockGate(built([
        { line: 3, literal: '0.08em', text: 'letter-spacing: 0.08em;' },
        { line: 9, literal: '600px', text: '@media ( max-width: 600px ) {' },
    ]));
    assert.equal(soft.status, 'pass');
    assert.equal(soft.warnings.length, 2);
    assert.equal(soft.failures.length, 0);

    const hard = blockGate(built([{ line: 4, literal: '#c47a2b', text: 'color: #c47a2b;' }]));
    assert.equal(hard.status, 'fail');
    assert.equal(hard.failures[0].code, 'style_literal');
});

test('the literal screen is property-aware: no preset category means no failure', () => {
    // letter-spacing, line heights, hairline borders, radii — the token system
    // has no preset to spend these through, and the tree prompt's own editorial
    // details (letterspaced kickers) depend on them.
    assert.deepEqual(screenTreeLiterals({
        version: 1, epoch: 'e',
        blocks: [{ name: 'core/paragraph', attributes: { style: {
            typography: { letterSpacing: '0.22em', lineHeight: '1.4' },
            border: { radius: '4px', top: { width: '1px' } },
        } } }],
    }), []);
    // spacing and font sizes DO have presets — literals there stay dead.
    const spacing = screenTreeLiterals({
        version: 1, epoch: 'e',
        blocks: [{ name: 'core/group', attributes: { style: { spacing: { padding: { top: '32px' } } } } }],
    });
    assert.equal(spacing.length, 1);
    assert.match(spacing[0].message, /spacing preset/);
    const font = screenTreeLiterals({
        version: 1, epoch: 'e',
        blocks: [{ name: 'core/heading', attributes: { style: { typography: { fontSize: '3rem' } } } }],
    });
    assert.equal(font.length, 1);
    // em never fails — relative to its own context, a mechanic (parity with
    // styleLiteralSeverity in the S5 CSS gate). Hex fails anywhere.
    assert.deepEqual(screenTreeLiterals({
        version: 1, epoch: 'e',
        blocks: [{ name: 'core/heading', attributes: { style: { typography: { fontSize: '1.2em' } } } }],
    }), []);
    assert.equal(screenTreeLiterals({
        version: 1, epoch: 'e',
        blocks: [{ name: 'core/heading', attributes: { style: { color: { text: '#ff0000' } } } }],
    }).length, 1);
});

test('screenBandRoot: one full-band core/group root with a declared inner layout', () => {
    const root = (attributes) => ({ version: 1, epoch: 'e', blocks: [{ name: 'core/group', attributes, innerBlocks: [] }] });
    assert.deepEqual(screenBandRoot(root({ align: 'full', layout: { type: 'constrained' } })), []);
    assert.deepEqual(screenBandRoot(root({ align: 'full', layout: { type: 'default' } })), []);
    // the 645px-header field bug: no align — the band ships clamped to the content column
    assert.ok(screenBandRoot(root({ layout: { type: 'constrained' } })).some((f) => /align "full"/.test(f.message)));
    // an undeclared inner layout leaves the cascade to chance
    assert.ok(screenBandRoot(root({ align: 'full' })).some((f) => /inner layout/.test(f.message)));
    // exactly one root, and it is a group
    assert.ok(screenBandRoot({ version: 1, epoch: 'e', blocks: [root({}).blocks[0], root({}).blocks[0]] })
        .some((f) => /ONE root/.test(f.message)));
    assert.ok(screenBandRoot({ version: 1, epoch: 'e', blocks: [{ name: 'core/cover', attributes: { align: 'full', layout: { type: 'constrained' } }, innerBlocks: [] }] })
        .some((f) => /core\/group/.test(f.message)));
});

test('screenBandWidths: clamped bands and disagreeing parts fail; full-bleed passes', () => {
    const node = (selector_path, block_name, w) => ({ selector_path, block_name, box: { x: 0, y: 0, w, h: 100 } });
    const pc = 'body:nth-child(2) > div:nth-child(1) > main:nth-child(2) > div.wp-block-post-content:nth-child(1)';
    const clean = [
        node('body:nth-child(2) > header.wp-block-template-part:nth-child(1)', 'core/template-part', 1425),
        node('body:nth-child(2) > footer.wp-block-template-part:nth-child(3)', 'core/template-part', 1425),
        node(pc, 'core/post-content', 1425),
        node(`${pc} > div.wp-block-group:nth-child(1)`, 'core/group', 1425),
        // constrained INNER content is allowed to be narrow — not a band root
        node(`${pc} > div.wp-block-group:nth-child(1) > div.wp-block-group:nth-child(1)`, 'core/group', 640),
    ];
    assert.deepEqual(screenBandWidths(clean, { viewportWidth: 1440 }), []);

    // the field bug: a 645px header on a 1440px viewport over a full-bleed footer
    const bug = structuredClone(clean);
    bug[0].box.w = 645;
    const failures = screenBandWidths(bug, { viewportWidth: 1440 });
    assert.ok(failures.some((f) => /645px of a 1440px viewport/.test(f.message)));
    assert.ok(failures.some((f) => /template parts disagree/.test(f.message)));

    // a section band clamped to contentSize
    const clamped = structuredClone(clean);
    clamped[3].box.w = 640;
    assert.ok(screenBandWidths(clamped, { viewportWidth: 1440 }).some((f) => /clamped to the content column/.test(f.message)));

    // no measured viewport: only the parts-agreement check can run
    assert.deepEqual(screenBandWidths(clamped, {}), []);
    assert.equal(screenBandWidths(bug, {}).length, 1);
    assert.deepEqual(screenBandWidths([], { viewportWidth: 1440 }), []);
});

test('screenBlockCss: a bare-root repaint fails; element-level colour moments and structure pass', () => {
    const css = (s) => ({ files: { 'style.css': s, 'render.php': '<?php' } });
    // the field bug verbatim: root sets color by slug name
    assert.ok(screenBlockCss(css('.wp-block-agent-review-wall{display:flex;color:var(--wp--preset--color--ink)}'))
        .some((i) => /does not own a colour scheme/.test(i.message)));
    // root background is the same hazard through the other side
    assert.ok(screenBlockCss(css('.agent-review-wall{background-color:var(--wp--preset--color--paper)}')).length > 0);
    // structure on the root, colour on elements: the allowed shape
    assert.deepEqual(screenBlockCss(css('.agent-review-wall{display:grid;gap:var(--wp--preset--spacing--40)}\n.agent-review-wall__meter{background-color:var(--wp--preset--color--safety-yellow)}\n.agent-review-wall__rule{border-top:1px solid currentColor}')), []);
    // descendant selectors and comments do not confuse the parser
    assert.deepEqual(screenBlockCss(css('/* .x{color:red} */ .agent-review-wall .card{color:var(--wp--preset--color--contrast)}')), []);
    // non-css files are not this screen's business
    assert.deepEqual(screenBlockCss({ files: { 'render.php': '.x{color:#fff}' } }), []);
});

test('screenTextContrast: size-aware — unreadable fails, muddy is advisory ONLY at display scale', () => {
    const invisible = { selector_path: 'p:nth-child(1)', ratio: 1, color: 'rgb(21, 25, 29)', background: 'rgb(21, 25, 29)', sample: 'NIGHT DISPATCH', font_px: 40 };
    const muddyDisplay = { selector_path: 'p:nth-child(2)', ratio: 3.63, color: 'rgb(108, 114, 120)', background: 'rgb(21, 25, 29)', sample: 'Hours', font_px: 40 };
    const muddySmall = { selector_path: 'p:nth-child(3)', ratio: 3.63, color: 'rgb(108, 114, 120)', background: 'rgb(21, 25, 29)', sample: 'Established 1887', font_px: 12 };
    const failures = screenTextContrast([invisible, muddyDisplay, muddySmall]);
    assert.equal(failures.length, 2);
    assert.match(failures[0].message, /1:1.*NIGHT DISPATCH/);
    // The Vienna strapline bug: 3.63:1 letterspaced caps at 12px is NOT legible.
    assert.match(failures[1].message, /12px.*Established 1887/);
    assert.deepEqual(screenTextContrast([muddyDisplay]), []);
    // No measured size = treated as small: the strict reading is the default.
    assert.equal(screenTextContrast([{ ...muddySmall, font_px: undefined }]).length, 1);
    assert.deepEqual(screenTextContrast(undefined), []);
});

test('screenBandSeams: the 19px block-gap seam fails; flush bands pass; parts alone are skipped', () => {
    const node = (selector_path, block_name, y, h) => ({ selector_path, block_name, box: { x: 0, y, w: 1440, h } });
    const pc = 'body:nth-child(2) > main:nth-child(2) > div.wp-block-post-content:nth-child(1)';
    const header = 'body:nth-child(2) > header.wp-block-template-part:nth-child(1)';
    const footer = 'body:nth-child(2) > footer.wp-block-template-part:nth-child(3)';
    const flush = [
        node(header, 'core/template-part', 0, 113),
        node(pc, 'core/post-content', 113, 2000),
        node(`${pc} > div.wp-block-group:nth-child(1)`, 'core/group', 113, 900),
        node(`${pc} > div.wp-block-group:nth-child(2)`, 'core/group', 1013, 1100),
        node(footer, 'core/template-part', 2113, 400),
    ];
    assert.deepEqual(screenBandSeams(flush), []);

    // the measured field bug: core's default block gap between every band
    const seamed = [
        node(header, 'core/template-part', 0, 113),
        node(pc, 'core/post-content', 113, 2038),
        node(`${pc} > div.wp-block-group:nth-child(1)`, 'core/group', 113, 900),
        node(`${pc} > div.wp-block-group:nth-child(2)`, 'core/group', 1032, 1100),
        node(footer, 'core/template-part', 2151, 400),
    ];
    const failures = screenBandSeams(seamed);
    assert.equal(failures.length, 2);
    assert.match(failures[0].message, /19px of page background/);

    // template parts with no measured band between them are not adjacent — no verdict
    assert.deepEqual(screenBandSeams([flush[0], flush[4]]), []);
});

test('screenImageGeometry: an intent node must carry width and aspectRatio', () => {
    const intentImage = (attributes) => ({
        version: 1, epoch: 'e',
        blocks: [{ name: 'core/group', attributes: {}, innerBlocks: [
            { name: 'core/image', attributes: { url: '', metadata: { imageIntent: 'a moody cellar' }, ...attributes }, innerBlocks: [] },
        ] }],
    });
    // both present: passes (the shape the working hero shipped)
    assert.deepEqual(screenImageGeometry(intentImage({ width: '100%', aspectRatio: '3/4', scale: 'cover' })), []);
    // missing either: the 1x1 placeholder would render at one pixel
    const missing = screenImageGeometry(intentImage({ aspectRatio: '4/3' }));
    assert.equal(missing.length, 1);
    assert.match(missing[0].message, /width/);
    assert.equal(screenImageGeometry(intentImage({})).length, 2);
    // an image WITHOUT an intent is not this gate's business
    assert.deepEqual(screenImageGeometry({
        version: 1, epoch: 'e',
        blocks: [{ name: 'core/image', attributes: { url: 'http://x/real.jpg' }, innerBlocks: [] }],
    }), []);
});

test('screenContentParity: content_lost entries fail with their path; a clean compile passes', () => {
    // The quote-value class: validation passed, save() dropped the text.
    const lost = screenContentParity({
        all_valid: true,
        invalid: [],
        content_lost: [{ path: '/0/innerBlocks/1/attributes/value', name: 'core/quote', attribute: 'value', message: 'save() does not render it' }],
    });
    assert.equal(lost.length, 1);
    assert.equal(lost[0].code, 'content_lost');
    assert.equal(lost[0].path, '/0/innerBlocks/1/attributes/value');
    // all_valid false folds each invalid block in as a failure too.
    const invalid = screenContentParity({ all_valid: false, invalid: [{ path: '/0', name: 'core/x', validation_issues: [] }], content_lost: [] });
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].code, 'compile_invalid');
    // Clean compile: nothing to report. An older toolchain result without the
    // field behaves identically (normalized upstream, guarded here too).
    assert.deepEqual(screenContentParity({ all_valid: true, invalid: [], content_lost: [] }), []);
    assert.deepEqual(screenContentParity({ all_valid: true, invalid: [] }), []);
});
