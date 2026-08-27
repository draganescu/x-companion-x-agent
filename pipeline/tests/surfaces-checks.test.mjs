import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crossChecks } from '../lib/brief-checks.mjs';
import { isTextureNone, textureCueOf, loadStyles } from '../lib/styles.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));

function withSurfaces(surfaces, mutate = () => {}) {
    const brief = structuredClone(fixture);
    brief.surfaces = surfaces;
    mutate(brief);
    return brief;
}

const FIELD = { id: 'linen-wash', class: 'field', prompt_seed: 'Woven linen texture, warm cream', intensity: 'whisper', attach: ['home/hero'] };
const CANVAS = { id: 'plaster-ground', class: 'canvas', prompt_seed: 'Fine plaster texture, near white', intensity: 'whisper', attach: [] };

test('a clean dictionary and a clean empty dictionary are both silent', () => {
    assert.deepEqual(crossChecks(withSurfaces([FIELD])).filter((i) => i.path.startsWith('/surfaces')), []);
    assert.deepEqual(crossChecks(withSurfaces([])).filter((i) => i.path.startsWith('/surfaces')), []);
});

test('canvas bands and canvas assets require each other', () => {
    const bandNoAsset = withSurfaces([], (b) => { b.pages[0].sections[0].design.band = 'canvas'; });
    assert.ok(crossChecks(bandNoAsset).some((i) => /canvas band needs a canvas asset/.test(i.message)));

    const assetNoBand = withSurfaces([CANVAS]);
    assert.ok(crossChecks(assetNoBand).some((i) => /invisible without at least one canvas band/.test(i.message)));

    const both = withSurfaces([CANVAS], (b) => { b.pages[0].sections[0].design.band = 'canvas'; });
    assert.deepEqual(crossChecks(both).filter((i) => /canvas/.test(i.message)), []);
});

test('attach refs must resolve; canvas attach must be empty', () => {
    const dangling = withSurfaces([{ ...FIELD, attach: ['home/no-such-section'] }]);
    assert.ok(crossChecks(dangling).some((i) => /no-such-section/.test(i.message)));

    const canvasAttached = withSurfaces([{ ...CANVAS, attach: ['home/hero'] }], (b) => { b.pages[0].sections[0].design.band = 'canvas'; });
    assert.ok(crossChecks(canvasAttached).some((i) => /canvas asset is site-wide/.test(i.message)));
});

test('ground-baked decor is only legal on skin-less flat bands', () => {
    const spot = { id: 'corner-flourish', class: 'spot', prompt_seed: 'Filigree corner flourish', intensity: 'present', attach: ['home/hero'], ground_baked: true };
    const onSkinned = withSurfaces([FIELD, spot]);
    assert.ok(crossChecks(onSkinned).some((i) => /ground-baked decor is only legal on skin-less flat bands/.test(i.message)));

    const alphaSpot = withSurfaces([FIELD, { ...spot, ground_baked: false }]);
    assert.deepEqual(alphaSpot.surfaces.length, 2);
    assert.deepEqual(crossChecks(alphaSpot).filter((i) => /ground-baked/.test(i.message)), []);

    const onFlat = withSurfaces([spot]);
    assert.deepEqual(crossChecks(onFlat).filter((i) => /ground-baked/.test(i.message)), []);
});

test('a divider section exists only for its skin; a canvas band never carries one', () => {
    const bareDivider = withSurfaces([], (b) => { b.pages[0].sections[1].role = 'divider'; });
    assert.ok(crossChecks(bareDivider).some((i) => /divider/.test(i.message)));

    const skinnedCanvas = withSurfaces(
        [{ ...FIELD, attach: ['home/hero'] }, CANVAS],
        (b) => { b.pages[0].sections[0].design.band = 'canvas'; },
    );
    assert.ok(crossChecks(skinnedCanvas).some((i) => /canvas band(s)? sit(s)? bare/.test(i.message)));
});

test('flatness honored: a texture-cue-none combo forbids a non-empty dictionary', () => {
    const textures = { artistic: 'none — pure flat color planes', ui: 'stitching, grain' };
    const issues = crossChecks(withSurfaces([FIELD]), { textures });
    assert.ok(issues.some((i) => /flatness honored/.test(i.message)));

    const emptyOk = crossChecks(withSurfaces([]), { textures });
    assert.deepEqual(emptyOk.filter((i) => /flatness/.test(i.message)), []);

    const textured = { artistic: 'damask, filigree borders', ui: 'stitching, grain' };
    assert.deepEqual(crossChecks(withSurfaces([FIELD]), { textures: textured }).filter((i) => /flatness/.test(i.message)), []);
});

test('texture is support, not wallpaper: at most 2 full-band skins per page', () => {
    const three = withSurfaces([
        { ...FIELD, id: 'wash-one', attach: ['home/hero'] },
        { ...FIELD, id: 'wash-two', attach: ['home/what-we-bake'] },
        { ...FIELD, id: 'wash-three', attach: ['home/signup'] },
    ]);
    assert.ok(crossChecks(three).some((i) => /at most 2 full-band skins per page/.test(i.message)));

    const two = withSurfaces([
        { ...FIELD, id: 'wash-one', attach: ['home/hero'] },
        { ...FIELD, id: 'wash-two', attach: ['home/what-we-bake'] },
    ]);
    assert.deepEqual(crossChecks(two).filter((i) => /full-band skins/.test(i.message)), []);
});

test('text-heavy bands accept only whisper skins — louder material belongs to heroes, ctas and dividers', () => {
    // brief.m1: home/what-we-bake is role "features" (text-heavy).
    const loudOnText = withSurfaces([
        { ...FIELD, intensity: 'present', attach: ['home/what-we-bake'] },
    ]);
    assert.ok(crossChecks(loudOnText).some((i) => /only a whisper skin/.test(i.message)));

    const whisperOnText = withSurfaces([
        { ...FIELD, intensity: 'whisper', attach: ['home/what-we-bake'] },
    ]);
    assert.deepEqual(crossChecks(whisperOnText).filter((i) => /whisper skin/.test(i.message)), []);

    // home/hero is role "hero": present is fine there.
    const presentOnHero = withSurfaces([
        { ...FIELD, intensity: 'present', attach: ['home/hero'] },
    ]);
    assert.deepEqual(crossChecks(presentOnHero).filter((i) => /whisper skin/.test(i.message)), []);
});

test('texture cue helpers: roster lookup and none detection', () => {
    const styles = loadStyles();
    assert.equal(typeof textureCueOf('Bauhaus', styles.artistic), 'string');
    assert.equal(textureCueOf('No Such Style', styles.artistic), undefined);
    assert.ok(isTextureNone('none — pure flat color planes'));
    assert.ok(isTextureNone('None'));
    assert.ok(!isTextureNone('damask, filigree borders'));
});
