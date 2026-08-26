import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStyles, normalizeStyleText, seededShuffle, matchPinnedStyles, styleChecks, renderPinNote, renderStyleNote } from '../lib/styles.mjs';

const styles = loadStyles();

test('the rosters load, every entry complete, names unique within and across normalization', () => {
    for (const list of ['artistic', 'ui']) {
        assert.ok(styles[list].length >= 150, `${list} roster is implausibly small`);
        const seen = new Set();
        for (const e of styles[list]) {
            assert.ok(e.name && e.name.length >= 2, `${list}: entry without a name`);
            for (const cue of ['palette', 'typography', 'composition', 'texture']) {
                assert.ok(e.cues?.[cue]?.length >= 3, `${list} "${e.name}": missing cue ${cue}`);
            }
            const norm = normalizeStyleText(e.name);
            assert.ok(!seen.has(norm), `${list}: "${e.name}" collides after normalization`);
            seen.add(norm);
        }
    }
});

test('no exact name lives in both rosters (a shared name must ride the flexible-pin lane)', () => {
    const a = new Set(styles.artistic.map((e) => normalizeStyleText(e.name)));
    const both = styles.ui.map((e) => normalizeStyleText(e.name)).filter((n) => a.has(n));
    assert.deepEqual(both, []);
});

test('seededShuffle: deterministic per seed, a permutation, different seeds differ', () => {
    const names = styles.artistic.map((e) => e.name);
    const a = seededShuffle(names, 'prompt one:artistic');
    const b = seededShuffle(names, 'prompt one:artistic');
    const c = seededShuffle(names, 'prompt two:artistic');
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
    assert.notDeepEqual(a, names); // 215 items: identity permutation is astronomically unlikely
    assert.deepEqual([...a].sort(), [...names].sort());
});

test('pin matching: an artistic name in the prompt pins the artistic slot only', () => {
    const pins = matchPinnedStyles('A bakery site, Art Deco please, with warm copy', styles);
    assert.equal(pins.artistic, 'Art Deco');
    assert.equal(pins.ui, null);
    assert.equal(pins.flexible, null);
});

test('pin matching: a UI name pins the UI slot; punctuation and case do not matter', () => {
    const pins = matchPinnedStyles('a portfolio in NEO-BRUTALISM style', styles);
    assert.equal(pins.ui, 'Neo-Brutalism');
    assert.equal(pins.artistic, null);
});

test('pin matching: both slots pin independently', () => {
    const pins = matchPinnedStyles('bauhaus mood with a bento grid layout', styles);
    assert.equal(pins.artistic, 'Bauhaus');
    assert.equal(pins.ui, 'Bento Grid Layout');
});

test('pin matching: longest name wins its span — "pop art ui" never also pins "Pop Art"', () => {
    const pins = matchPinnedStyles('a pop art ui gallery site', styles);
    assert.equal(pins.ui, 'Pop Art UI');
    assert.equal(pins.artistic, null);
    assert.deepEqual(pins.also_named, []);
});

test('pin matching: two names in one list — first mention pins, the rest are noted', () => {
    const pins = matchPinnedStyles('somewhere between wabi-sabi and art deco', styles);
    assert.equal(pins.artistic, 'Wabi-Sabi');
    assert.deepEqual(pins.also_named, ['Art Deco']);
});

test('pin matching: aliases and diacritics reach their entries', () => {
    assert.equal(matchPinnedStyles('a y2k fan page', styles).artistic, 'Y2K Aesthetic');
    assert.equal(matchPinnedStyles('an ukiyoe print shop', styles).artistic, 'Ukiyo-e');
    assert.equal(matchPinnedStyles('windows 95 throwback', styles).ui, 'Windows 95 Aesthetic');
    assert.equal(normalizeStyleText('Sōsaku-hanga'), 'sosaku hanga'); // diacritics fold before matching
});

test('pin matching: a plain prompt pins nothing', () => {
    const pins = matchPinnedStyles('A one-page site for a small ceramics studio', styles);
    assert.deepEqual(pins, { artistic: null, ui: null, flexible: null, also_named: [] });
    assert.match(renderPinNote(pins), /both choices are fully yours/);
});

test('styleChecks: membership is exact-name, with a spell-it-exactly hint on a near miss', () => {
    const brief = { style: { artistic: 'art deco', ui: 'Bento Grid Layout', rationale: 'x'.repeat(30) } };
    const issues = styleChecks(brief, { styles });
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /exactly as "Art Deco"/);
    assert.deepEqual(styleChecks({ style: { artistic: 'Art Deco', ui: 'Bento Grid Layout', rationale: 'x'.repeat(30) } }, { styles }), []);
});

test('styleChecks: a name off both rosters is rejected outright', () => {
    const issues = styleChecks({ style: { artistic: 'Vibe-core', ui: 'Bento Grid Layout', rationale: 'x'.repeat(30) } }, { styles });
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /not in the artistic styles list/);
});

test('styleChecks: a pinned style is set in stone — never overridden', () => {
    const pins = matchPinnedStyles('an Art Deco hotel site', styles);
    const issues = styleChecks({ style: { artistic: 'Bauhaus', ui: 'Luxury High-End Minimal', rationale: 'x'.repeat(30) } }, { styles, pins });
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /set in stone/);
    assert.deepEqual(styleChecks({ style: { artistic: 'Art Deco', ui: 'Luxury High-End Minimal', rationale: 'x'.repeat(30) } }, { styles, pins }), []);
});

test('styleChecks: a flexible (both-roster) pin must occupy one slot, either satisfies', () => {
    const pins = { artistic: null, ui: null, flexible: { artistic: 'Bauhaus', ui: 'Bauhaus UI' }, also_named: [] };
    const neither = styleChecks({ style: { artistic: 'Art Deco', ui: 'SaaS Minimal', rationale: 'x'.repeat(30) } }, { styles, pins });
    assert.equal(neither.length, 1);
    assert.match(neither[0].message, /must occupy one of the two slots/);
    assert.deepEqual(styleChecks({ style: { artistic: 'Bauhaus', ui: 'SaaS Minimal', rationale: 'x'.repeat(30) } }, { styles, pins }), []);
    assert.deepEqual(styleChecks({ style: { artistic: 'Art Deco', ui: 'Bauhaus UI', rationale: 'x'.repeat(30) } }, { styles, pins }), []);
});

test('renderStyleNote: the combo renders with both cue lines; a pre-style brief renders empty', () => {
    const note = renderStyleNote({ artistic: 'Art Deco', ui: 'Bento Grid Layout', rationale: 'geometry meets modular luxury' }, styles);
    assert.match(note, /Artistic style: Art Deco — palette:/);
    assert.match(note, /UI design style: Bento Grid Layout — palette:/);
    assert.match(note, /geometry meets modular luxury/);
    assert.equal(renderStyleNote(undefined, styles), '');
    assert.equal(renderStyleNote(null, styles), '');
});
