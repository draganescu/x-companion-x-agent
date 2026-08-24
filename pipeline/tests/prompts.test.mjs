import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTemplate, renderPrompt } from '../lib/prompts.mjs';

const dir = mkdtempSync(join(tmpdir(), 'x-pipeline-prompts-'));
writeFileSync(join(dir, 'tree.md'), [
    '---',
    'task_type: tree',
    'required: [section, manifest_slice, epoch]',
    '---',
    'Build section {{section}} against {{manifest_slice}} at epoch {{epoch}}.',
].join('\n'));

test('frontmatter parses task_type and required', () => {
    const t = loadTemplate(dir, 'tree');
    assert.equal(t.task_type, 'tree');
    assert.deepEqual(t.required, ['section', 'manifest_slice', 'epoch']);
    assert.match(t.body, /^Build section/);
});

test('rendering substitutes strings verbatim and objects as pretty JSON', () => {
    const t = loadTemplate(dir, 'tree');
    const out = renderPrompt(t, { section: 'hero', manifest_slice: { blocks: ['core/group'] }, epoch: 'abc' });
    assert.match(out, /section hero against/);
    assert.match(out, /"blocks": \[\s+"core\/group"\s+\]/);
    assert.match(out, /at epoch abc\./);
});

test('a missing required field throws naming the field', () => {
    const t = loadTemplate(dir, 'tree');
    assert.throws(() => renderPrompt(t, { section: 'hero', epoch: 'abc' }),
        (e) => e.code === 'prompt_payload_missing' && /manifest_slice/.test(e.message));
});

test('a template without frontmatter fails preflight', () => {
    writeFileSync(join(dir, 'block.md'), 'no frontmatter here');
    assert.throws(() => loadTemplate(dir, 'block'), (e) => e.code === 'preflight_failed');
});
