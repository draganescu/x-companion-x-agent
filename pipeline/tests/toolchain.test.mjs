import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolchain } from '../lib/toolchain.mjs';

test('createToolchain loads handlers and shims callTool results', async () => {
    const tc = await createToolchain({ cwd: mkdtempSync(join(tmpdir(), 'x-pipeline-tc-')) });
    // wp_spec_validate is local:true — callable with no instance at all.
    const res = await tc.call('wp_spec_validate', { version: 1 });
    assert.equal(typeof res.ok, 'boolean');
    assert.ok(res.data); // parsed result or envelope, never raw text
    // An unknown tool comes back as a structured envelope, not a throw.
    const bad = await tc.call('wp_definitely_not_a_tool', {});
    assert.equal(bad.ok, false);
    assert.equal(bad.data.code, 'invalid_input');
    await tc.dispose();
});
