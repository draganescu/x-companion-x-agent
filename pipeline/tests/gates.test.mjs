import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenTreeDiagnostics, screenTreeLiterals, localTreeCheck, screenFileMap, blockGate, schemaGate, styleLiteralSeverity } from '../lib/gates.mjs';

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
