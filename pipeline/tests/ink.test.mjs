import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInkMenus, resolveInkMenusFromLuminance } from '../lib/tokens.mjs';
import { screenTreeInk, substituteInk } from '../lib/gates.mjs';

// The Salon Regale field-bug palette: brass on bone measured 2.74:1 live.
const PALETTE = [
    { slug: 'base', color: '#F5F2EC' },
    { slug: 'bone', color: '#E6E0D5' },
    { slug: 'ink', color: '#121619' },
    { slug: 'graphite', color: '#1B2126' },
    { slug: 'brass', color: '#B07D3A' },
    { slug: 'steel', color: '#767E85' },
];

const band = (attrs, inner) => ({
    version: 1,
    epoch: 'e',
    blocks: [{ name: 'core/group', attributes: { align: 'full', layout: { type: 'constrained' }, ...attrs }, innerBlocks: inner }],
});
const p = (content, attrs = {}) => ({ name: 'core/paragraph', attributes: { content, ...attrs }, innerBlocks: [] });

test('resolveInkMenus: brass never reaches a light ground, steel is display-only, real inks are safe', () => {
    const menus = resolveInkMenus('bone', PALETTE);
    assert.ok(!menus.safe_inks.includes('brass') && !menus.display_only_inks.includes('brass'));
    assert.ok(menus.display_only_inks.includes('steel'));
    assert.ok(menus.safe_inks.includes('ink') && menus.safe_inks.includes('graphite'));
    const onDark = resolveInkMenus('ink', PALETTE);
    assert.ok(onDark.safe_inks.includes('brass')); // brass belongs on dark grounds
});

test('screenTreeInk: the field bug — brass numerals on a bone band fail at birth', () => {
    const tree = band({ backgroundColor: 'bone', textColor: 'ink' },
        [p('01', { textColor: 'brass' }), p('02', { textColor: 'brass' }), p('body copy')]);
    const { failures, advisories } = screenTreeInk(tree, { palette: PALETTE });
    assert.equal(failures.length, 2);
    assert.match(failures[0].message, /"brass" reads 2\.74:1 on its actual ground "bone"/);
    assert.equal(advisories.length, 0); // the band pair itself is safe
});

test('screenTreeInk: 3–4.5:1 is advisory, not fatal — mirroring S9', () => {
    const tree = band({ backgroundColor: 'bone', textColor: 'ink' }, [p('kicker', { textColor: 'steel' })]);
    const { failures, advisories } = screenTreeInk(tree, { palette: PALETTE });
    assert.equal(failures.length, 0);
    assert.equal(advisories.length, 1);
});

test('screenTreeInk: an inner group that re-grounds is checked against its NEW ground', () => {
    const tree = band({ backgroundColor: 'ink', textColor: 'base' }, [
        p('fine on dark', { textColor: 'brass' }),
        { name: 'core/group', attributes: { backgroundColor: 'bone' }, innerBlocks: [p('inherits brass onto bone', { textColor: 'brass' })] },
    ]);
    const { failures } = screenTreeInk(tree, { palette: PALETTE });
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /on its actual ground "bone"/);
});

test('screenTreeInk: buttons are measurable only when they declare both colours; gradients pause checks', () => {
    const tree = band({ backgroundColor: 'bone', textColor: 'ink' }, [
        { name: 'core/button', attributes: { text: 'Book', textColor: 'brass' }, innerBlocks: [] }, // theme paints its surface — skip
        { name: 'core/button', attributes: { text: 'Book', textColor: 'brass', backgroundColor: 'bone' }, innerBlocks: [] }, // measurable — fails
        { name: 'core/group', attributes: { gradient: 'sunset' }, innerBlocks: [p('on a gradient', { textColor: 'brass' })] }, // unmeasurable ground — skip
    ]);
    const { failures } = screenTreeInk(tree, { palette: PALETTE });
    assert.equal(failures.length, 1);
});

test('screenTreeInk: unknown slugs and an empty palette no-op instead of guessing', () => {
    const tree = band({ backgroundColor: 'bone', textColor: 'ink' }, [p('x', { textColor: 'not-a-slug' })]);
    assert.equal(screenTreeInk(tree, { palette: PALETTE }).failures.length, 0);
    assert.equal(screenTreeInk(tree, {}).failures.length, 0);
});

test('substituteInk: swaps only failing DECLARED inks to the closest compliant slug, and the result screens clean', () => {
    const tree = band({ backgroundColor: 'bone', textColor: 'ink' },
        [p('01', { textColor: 'brass' }), p('untouched body copy')]);
    const changes = substituteInk(tree, PALETTE);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].from, 'brass');
    assert.ok(['ink', 'graphite'].includes(changes[0].to)); // nearest slug clearing 4.5:1 on bone
    assert.equal(tree.blocks[0].innerBlocks[0].attributes.textColor, changes[0].to);
    assert.equal(tree.blocks[0].innerBlocks[1].attributes.textColor, undefined); // inherited ink untouched
    assert.equal(screenTreeInk(tree, { palette: PALETTE }).failures.length, 0);
});

test('substituteInk: a clean tree yields zero changes — the rescue lane knows when it does not apply', () => {
    const tree = band({ backgroundColor: 'ink', textColor: 'base' }, [p('brass on dark is fine', { textColor: 'brass' })]);
    assert.deepEqual(substituteInk(tree, PALETTE), []);
});

test('resolveInkMenusFromLuminance: worst-case rating against a measured ground range', () => {
    const APPLIED = [
        { slug: 'pale', color: '#F6EFE6' },
        { slug: 'espresso', color: '#3B2A1E' },
        { slug: 'ember', color: '#D96C2C' },
    ];
    // A light canvas (lum 0.8-0.9): only the dark slug survives; the mid orange
    // reads under 3:1 at worst case and lands in NEITHER menu.
    const light = resolveInkMenusFromLuminance(0.8, 0.9, APPLIED);
    assert.ok(light.safe_inks.includes('espresso'));
    assert.ok(!light.safe_inks.includes('ember'));
    assert.ok(!light.display_only_inks.includes('ember'));
    assert.ok(!light.safe_inks.includes('pale'));
    // A dark canvas (lum 0.02-0.05): pale is safe; ember clears 3:1 only at the
    // dark end, so worst-case puts it display-only.
    const dark = resolveInkMenusFromLuminance(0.02, 0.05, APPLIED);
    assert.ok(dark.safe_inks.includes('pale'));
    assert.ok(dark.display_only_inks.includes('ember'));
    // No palette: both menus empty, never a throw.
    assert.deepEqual(resolveInkMenusFromLuminance(0.5, 0.6, []), { safe_inks: [], display_only_inks: [] });
});
