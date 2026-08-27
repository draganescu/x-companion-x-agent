import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionGrammar, widthRecipe } from '../lib/grammar.mjs';
import { screenTreeType, screenTreeWidths } from '../lib/gates.mjs';
import { stripUnknownAttrs } from '../lib/normalize.mjs';

const TYPOGRAPHY = {
    families: [],
    sizes: [
        { slug: 'small', size: '0.875rem' },
        { slug: 'medium', size: '1.125rem' },
        { slug: 'large', size: '1.75rem' },
        { slug: 'x-large', size: '2.75rem' },
        { slug: 'display', size: '4rem', fluid: { min: '2.75rem', max: '6.5rem' } },
    ],
};

test('sectionGrammar: level->slug map from the applied scale, fluid sizes judged by their max', () => {
    const g = sectionGrammar(TYPOGRAPHY);
    assert.deepEqual(g, { h1: 'display', h2: 'x-large', h3: 'large', kicker: 'small' });
    assert.equal(sectionGrammar({ sizes: [] }), null);
    assert.equal(sectionGrammar(undefined), null);
    // A two-step scale still maps every level.
    const tiny = sectionGrammar({ sizes: [{ slug: 'big', size: '3rem' }, { slug: 'small', size: '1rem' }] });
    assert.deepEqual(tiny, { h1: 'big', h2: 'small', h3: 'small', kicker: 'small' });
});

test('widthRecipe: stack reads at content width; composed layouts get exactly one wide container', () => {
    assert.deepEqual(widthRecipe('stack'), { alignwide_children: 0 });
    assert.deepEqual(widthRecipe('grid'), { alignwide_children: 1 });
    assert.deepEqual(widthRecipe('split'), { alignwide_children: 1 });
    assert.deepEqual(widthRecipe(undefined), { alignwide_children: 0 });
});

const GRAMMAR = { h1: 'display', h2: 'x-large', h3: 'large', kicker: 'small' };

function band(children) {
    return { version: 1, blocks: [{ name: 'core/group', attributes: { align: 'full', layout: { type: 'constrained' } }, innerBlocks: children }] };
}

test('screenTreeType: off-map headings die at birth with the exact correction — the 104px h3 field bug', () => {
    const bad = band([
        { name: 'core/heading', attributes: { level: 3, fontSize: 'display', content: '01 512 84 09' } },
        { name: 'core/heading', attributes: { level: 2, content: 'no size at all' } },
        { name: 'core/heading', attributes: { level: 2, fontSize: 'x-large', content: 'this one is right' } },
    ]);
    const failures = screenTreeType(bad, { grammar: GRAMMAR });
    assert.equal(failures.length, 2);
    assert.match(failures[0].message, /level 3 .* declares fontSize "display" .* maps level 3 to "large"/);
    assert.match(failures[1].message, /declares fontSize nothing/);

    const good = band([
        { name: 'core/heading', attributes: { level: 1, fontSize: 'display' } },
        { name: 'core/group', attributes: {}, innerBlocks: [{ name: 'core/heading', attributes: { level: 3, fontSize: 'large' } }] },
    ]);
    assert.deepEqual(screenTreeType(good, { grammar: GRAMMAR }), []);
    // No grammar (unparseable scale): the gate stands down rather than guessing.
    assert.deepEqual(screenTreeType(bad, {}), []);
});

test('screenTreeWidths: random narrow/wide alternation dies — none wide for stack, exactly one for grid', () => {
    const wideGroup = { name: 'core/group', attributes: { align: 'wide' }, innerBlocks: [] };
    const plain = { name: 'core/group', attributes: {}, innerBlocks: [] };

    assert.deepEqual(screenTreeWidths(band([plain, plain]), { layout: 'stack' }), []);
    assert.match(screenTreeWidths(band([wideGroup]), { layout: 'stack' })[0].message, /"stack" section reads at content width/);
    assert.deepEqual(screenTreeWidths(band([plain, wideGroup]), { layout: 'grid' }), []);
    assert.match(screenTreeWidths(band([plain, plain]), { layout: 'grid' })[0].message, /EXACTLY ONE alignwide container/);
    assert.match(screenTreeWidths(band([wideGroup, wideGroup]), { layout: 'split' })[0].message, /2 alignwide/);
    // align full on a content child is never legal…
    const fullChild = { name: 'core/group', attributes: { align: 'full' }, innerBlocks: [] };
    assert.match(screenTreeWidths(band([fullChild]), { layout: 'stack' })[0].message, /full-bleed belongs to the band root/);
    // …but a loud cover is the ground, and the recipe applies INSIDE it.
    const cover = { name: 'core/cover', attributes: { align: 'full', overlayColor: 'contrast', dimRatio: 80 }, innerBlocks: [plain, wideGroup] };
    assert.deepEqual(screenTreeWidths(band([cover]), { layout: 'grid' }), []);
});

test('stripUnknownAttrs: exactly the flagged attributes come off, nothing else — the footer textAlign bug', () => {
    const tree = band([
        { name: 'core/site-title', attributes: {} },
        { name: 'core/heading', attributes: { level: 2, textAlign: 'center', fontSize: 'x-large', content: 'Visit us' } },
    ]);
    const removed = stripUnknownAttrs(tree, [
        { code: 'W_ATTR_UNKNOWN', path: '/blocks/0/innerBlocks/1/attributes/textAlign', message: 'not declared' },
        { code: 'W_STATIC_NEEDS_HARNESS', path: '/blocks/0', message: 'unrelated' },
        { code: 'W_ATTR_UNKNOWN', path: '/blocks/9/attributes/ghost', message: 'no such node' },
    ]);
    assert.deepEqual(removed, ['/blocks/0/innerBlocks/1/attributes/textAlign']);
    const heading = tree.blocks[0].innerBlocks[1];
    assert.equal(heading.attributes.textAlign, undefined);
    assert.equal(heading.attributes.fontSize, 'x-large');
    assert.equal(heading.attributes.content, 'Visit us');
});
