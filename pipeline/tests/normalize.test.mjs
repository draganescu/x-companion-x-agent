import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTreeBorders } from '../lib/normalize.mjs';

const tree = (attributes, innerBlocks = []) => ({
    version: 1, epoch: 'f', blocks: [{ name: 'core/group', attributes, innerBlocks }],
});

test('flat borderColor beside a per-side border folds into the declared sides', () => {
    // The field bug: intent was a 1px top rule; has-border-color painted the
    // other three sides solid at the browser's 3px default.
    const t = tree({
        borderColor: 'alama',
        style: { border: { top: { width: '1px', style: 'solid' } } },
    });
    assert.equal(normalizeTreeBorders(t), 1);
    const attrs = t.blocks[0].attributes;
    assert.equal(attrs.borderColor, undefined, 'the flat attribute is dropped');
    assert.deepEqual(attrs.style.border, {
        top: { width: '1px', style: 'solid', color: 'var:preset|color|alama' },
    }, 'only the declared side survives, carrying the colour inside it');
});

test('a declared side keeps its own colour and gains solid when style is missing', () => {
    const t = tree({
        borderColor: 'base',
        style: { border: { top: { width: '2px', color: 'var:preset|color|chihlimbar' }, bottom: { width: '1px' } } },
    });
    normalizeTreeBorders(t);
    const border = t.blocks[0].attributes.style.border;
    assert.equal(border.top.color, 'var:preset|color|chihlimbar', 'an explicit side colour is never overwritten');
    assert.equal(border.top.style, 'solid');
    assert.deepEqual(border.bottom, { style: 'solid', width: '1px', color: 'var:preset|color|base' });
});

test('flat borderColor with a flat border (the full box) is left alone', () => {
    const t = tree({ borderColor: 'alama', style: { border: { width: '1px', radius: '2px' } } });
    assert.equal(normalizeTreeBorders(t), 0);
    assert.equal(t.blocks[0].attributes.borderColor, 'alama');
});

test('walks innerBlocks and counts every fold', () => {
    const inner = { name: 'core/columns', attributes: { borderColor: 'lemn-afumat', style: { border: { top: { width: '1px', style: 'solid' } } } }, innerBlocks: [] };
    const t = tree({}, [inner, structuredClone(inner)]);
    assert.equal(normalizeTreeBorders(t), 2);
    assert.ok(t.blocks[0].innerBlocks.every((n) => n.attributes.borderColor === undefined));
});

test('trees without the pattern pass through untouched', () => {
    const t = tree({ style: { border: { top: { width: '1px', style: 'solid', color: 'var:preset|color|alama' } } } });
    assert.equal(normalizeTreeBorders(t), 0);
    assert.equal(normalizeTreeBorders({ version: 1, epoch: 'f', blocks: [] }), 0);
    assert.equal(normalizeTreeBorders(null), 0);
});
