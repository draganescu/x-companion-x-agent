import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintSurfaceMarkers, pageSurfaceDict, pageSurfacePlan, surfaceHexes } from '../lib/surfaces.mjs';

const PALETTE = [
    { slug: 'base', color: '#F6EFE6' },
    { slug: 'contrast', color: '#3B2A1E' },
    { slug: 'ember', color: '#D96C2C' },
];

function brief(surfaces) {
    return {
        palette: [
            { name: 'Bone', color: '#F6EFE6', role: 'background' },
            { name: 'Espresso', color: '#3B2A1E', role: 'text' },
            { name: 'Ember', color: '#D96C2C', role: 'accent' },
        ],
        surfaces,
        pages: [{
            slug: 'home',
            sections: [
                { id: 'hero', role: 'hero', design: { band: 'contrast', layout: 'stack' } },
                { id: 'menu', role: 'section', design: { band: 'base', layout: 'grid' } },
                { id: 'cta', role: 'cta', design: { band: 'accent', layout: 'stack' } },
            ],
        }],
    };
}

const FIELD = { id: 'linen-wash', class: 'field', prompt_seed: 'Woven linen texture', intensity: 'whisper', attach: ['home/menu'] };
const FRIEZE = { id: 'deco-frieze', class: 'frieze', prompt_seed: 'Deco border strip', intensity: 'present', attach: ['home/menu'], edge: 'bottom' };
const LOUD = { id: 'damask-field', class: 'pattern', prompt_seed: 'Aged damask', intensity: 'loud', attach: ['home/hero'] };

function sectionRoot(children = []) {
    return { name: 'core/group', attributes: { align: 'full', backgroundColor: 'base', layout: { type: 'constrained' } }, innerBlocks: children };
}

test('pageSurfacePlan: classes route to their mechanisms; missing support degrades loudly', () => {
    const { plans } = pageSurfacePlan(brief([FIELD, FRIEZE, LOUD]), 'home');
    assert.equal(plans.get('menu').skin.id, 'linen-wash');
    assert.equal(plans.get('menu').edge.id, 'deco-frieze');
    assert.equal(plans.get('menu').edge.position, 'bottom');
    assert.equal(plans.get('hero').loud.id, 'damask-field');

    const degraded = pageSurfacePlan(brief([FIELD]), 'home', { groupSupport: false });
    assert.equal(degraded.plans.size, 0);
    assert.equal(degraded.degraded.length, 1);
    assert.match(degraded.degraded[0].reason, /no background support/);
});

test('mintSurfaceMarkers: skin on the root; skin + edge nests ONE wrapper group — one group, one layer', () => {
    const tree = { version: 1, blocks: [sectionRoot([{ name: 'core/heading', attributes: {} }]), sectionRoot([{ name: 'core/paragraph', attributes: {} }]), sectionRoot()] };
    const { plans } = pageSurfacePlan(brief([FIELD, FRIEZE]), 'home');
    const sections = [{ id: 'hero' }, { id: 'menu' }, { id: 'cta' }];
    const out = mintSurfaceMarkers(tree, sections, plans);
    assert.equal(out.minted, 2);
    assert.equal(out.wrapped, 1);
    const menuRoot = tree.blocks[1];
    assert.equal(menuRoot.attributes.metadata.surfaceIntent, 'linen-wash');
    assert.equal(menuRoot.attributes.backgroundColor, 'base'); // the reservation stays
    const wrapper = menuRoot.innerBlocks[0];
    assert.equal(wrapper.name, 'core/group');
    assert.equal(wrapper.attributes.metadata.surfaceIntent, 'deco-frieze');
    assert.equal(wrapper.innerBlocks[0].name, 'core/paragraph'); // content moved inside the layer
});

test('mintSurfaceMarkers: a loud surface takes the cover; without one it degrades to a group skin, recorded', () => {
    const cover = { name: 'core/cover', attributes: { overlayColor: 'contrast', dimRatio: 80 }, innerBlocks: [] };
    const tree = { version: 1, blocks: [sectionRoot([cover]), sectionRoot(), sectionRoot()] };
    const { plans } = pageSurfacePlan(brief([LOUD]), 'home');
    const out = mintSurfaceMarkers(tree, [{ id: 'hero' }, { id: 'menu' }, { id: 'cta' }], plans);
    assert.equal(out.minted, 1);
    assert.equal(cover.attributes.metadata.surfaceIntent, 'damask-field');
    assert.equal(tree.blocks[0].attributes.metadata?.surfaceIntent, undefined);

    const bare = { version: 1, blocks: [sectionRoot(), sectionRoot(), sectionRoot()] };
    const again = mintSurfaceMarkers(bare, [{ id: 'hero' }, { id: 'menu' }, { id: 'cta' }], pageSurfacePlan(brief([LOUD]), 'home').plans);
    assert.equal(bare.blocks[0].attributes.metadata.surfaceIntent, 'damask-field');
    assert.equal(again.degraded.length, 1);
    assert.match(again.degraded[0].reason, /no core\/cover/);
});

test('mintSurfaceMarkers: a dead section keeps its flat baseline and the degrade is recorded', () => {
    const tree = { version: 1, blocks: [sectionRoot(), sectionRoot(), sectionRoot()] };
    const { plans } = pageSurfacePlan(brief([FIELD]), 'home');
    const out = mintSurfaceMarkers(tree, [{ id: 'hero' }, { id: 'menu', dead: true }, { id: 'cta' }], plans);
    assert.equal(out.minted, 0);
    assert.equal(tree.blocks[1].attributes.metadata?.surfaceIntent, undefined);
    assert.match(out.degraded[0].reason, /baseline/);
});

test('surfaceHexes: the exact band hexes ride along; hexless is a thrown bug', () => {
    const b = brief([{ ...FIELD, attach: ['home/hero', 'home/menu'] }]);
    assert.deepEqual(surfaceHexes(b.surfaces[0], b, PALETTE), ['#3B2A1E', '#F6EFE6']);
    const dangling = { ...FIELD, attach: ['home/no-such'] };
    assert.throws(() => surfaceHexes(dangling, brief([dangling]), PALETTE), (e) => e.code === 'internal');
});

test('pageSurfaceDict: per-page entries with hexes resolved; canvas never rides the page dict', () => {
    const canvas = { id: 'plaster-ground', class: 'canvas', prompt_seed: 'Fine plaster', intensity: 'whisper', attach: [] };
    const dict = pageSurfaceDict(brief([FIELD, FRIEZE, canvas]), 'home', PALETTE);
    assert.deepEqual(dict.map((d) => d.id), ['linen-wash', 'deco-frieze']);
    assert.deepEqual(dict[0].hexes, ['#F6EFE6']);
    assert.equal(dict[1].position, 'bottom'); // edge rides as the position knob
});
