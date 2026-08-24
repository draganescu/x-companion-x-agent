import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenTreeDiagnostics, localTreeCheck, screenFileMap, blockGate, schemaGate } from '../lib/gates.mjs';

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
