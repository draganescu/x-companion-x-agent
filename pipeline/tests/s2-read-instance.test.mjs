import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as s2 from '../stages/s2-read-instance.mjs';
import { pickPattern } from '../lib/instance.mjs';

const brief = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));

const CORE_BLOCKS = Object.fromEntries([
    'core/cover', 'core/group', 'core/heading', 'core/paragraph', 'core/buttons', 'core/button',
    'core/image', 'core/spacer', 'core/columns', 'core/column', 'core/list', 'core/list-item',
    'core/navigation',
].map((n) => [n, { attributes: { align: { type: 'string' } }, supports: { color: true } }]));

const PATTERNS = [
    { name: 'zeta/hero-banner', title: 'Zeta Hero', categories: ['banner'], parsed_tree: [{ name: 'core/cover' }] },
    { name: 'alpha/hero-splash', title: 'Alpha Hero', categories: ['hero'], parsed_tree: [{ name: 'core/cover' }] },
    { name: 'theme/header-plain', title: 'Plain Header', categories: ['header'], parsed_tree: [{ name: 'core/group' }] },
];

function makeCtx({ posture = 'toolchain', connectOk = true } = {}) {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s2-'));
    mkdirSync(join(runDir, 'sections'), { recursive: true });
    const calls = [];
    return {
        runDir,
        state: { brief: structuredClone(brief) },
        log: () => {},
        calls,
        call: async (name, args) => {
            calls.push([name, args]);
            if (name === 'wp_connect') {
                if (!connectOk) return { ok: false, data: { code: 'companion_unreachable', message: 'no companion', hint: 'boot it' } };
                return { ok: true, data: { site_url: 'http://127.0.0.1:9410', posture, fingerprint: 'f1'.padEnd(64, '0'), wp_version: '6.8', blocks_count: 13, suites: [] } };
            }
            if (name === 'wp_manifest') {
                return { ok: true, data: { blocks: CORE_BLOCKS, theme_tokens: { color: {}, spacing: { spacingSizes: [{ slug: '40', size: '1rem' }] }, typography: {}, layout: { contentSize: '640px', wideSize: '1200px' } } } };
            }
            if (name === 'wp_patterns') return { ok: true, data: PATTERNS };
            throw new Error(`unexpected tool ${name}`);
        },
    };
}

test('S2 writes instance.json and one payload per section with sliced vocabulary', async () => {
    const ctx = makeCtx();
    await s2.run(ctx);
    const instance = JSON.parse(readFileSync(join(ctx.runDir, 'instance.json'), 'utf8'));
    assert.equal(instance.posture, 'toolchain');
    assert.equal(instance.theme_tokens.layout.contentSize, '640px');
    assert.equal(ctx.state.sections.length, 3);

    const hero = JSON.parse(readFileSync(join(ctx.runDir, 'sections', 'home--hero.json'), 'utf8'));
    assert.ok(hero.manifest_slice.blocks['core/cover']);
    assert.equal(hero.manifest_slice.blocks['core/navigation'], undefined); // not a hero family
    assert.equal(hero.pattern.name, 'alpha/hero-splash'); // first term 'hero', alphabetical pick
    assert.equal(hero.manifest_slice.declared_custom_block, undefined);

    const signup = JSON.parse(readFileSync(join(ctx.runDir, 'sections', 'home--signup.json'), 'utf8'));
    assert.equal(signup.manifest_slice.declared_custom_block.name, 'agent/signup-banner');
    assert.equal(signup.manifest_slice.declared_custom_block.attributes.length, 2);
});

test('production posture fails preflight; a dead companion surfaces its envelope code', async () => {
    await assert.rejects(s2.run(makeCtx({ posture: 'production' })), (e) => e.code === 'preflight_failed');
    await assert.rejects(s2.run(makeCtx({ connectOk: false })), (e) => e.code === 'companion_unreachable');
});

test('pickPattern: no match returns null; first query term wins over later ones', () => {
    assert.equal(pickPattern([], 'hero'), null);
    const p = pickPattern(PATTERNS, 'hero');
    assert.equal(p.name, 'alpha/hero-splash');
    assert.equal(pickPattern(PATTERNS, 'faq'), null);
});

test('toTreeIrBlocks converts parse shape and drops whitespace nodes', async () => {
    const { toTreeIrBlocks } = await import('../lib/instance.mjs');
    const parsed = [
        { blockName: 'core/group', attrs: { align: 'full' }, innerHTML: '<div>x</div>', innerBlocks: [
            null,
            { blockName: null, attrs: {}, innerBlocks: [] },
            { blockName: 'core/heading', attrs: null, innerBlocks: [] },
        ] },
    ];
    assert.deepEqual(toTreeIrBlocks(parsed), [
        { name: 'core/group', attributes: { align: 'full' }, innerBlocks: [
            { name: 'core/heading', attributes: {}, innerBlocks: [] },
        ] },
    ]);
});
