import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSchema } from '../lib/schema.mjs';
import { themeSpecChecks } from '../lib/theme-spec.mjs';

const contract = JSON.parse(readFileSync(new URL('../../contract/schemas/theme-spec.schema.json', import.meta.url), 'utf8'));

const validSpec = () => ({
    version: 1,
    identity: {
        name: 'Salon Regale Theme',
        slug: 'salon-regale',
        description: 'A bespoke ground for the Salon Regale — gilt editorial calm.',
    },
    skeleton: 'stacked',
    measure: { contentSize: '70ch', wideSize: '90ch' },
    physics: {
        blockGap: '1.5rem',
        rootPadding: { top: '0px', right: '24px', bottom: '0px', left: '24px' },
    },
    presets: {
        shadows: [{ slug: 'lift', name: 'Lift', shadow: '0 8px 24px rgba(0,0,0,0.12)' }],
        gradients: [{ slug: 'dusk', name: 'Dusk', gradient: 'linear-gradient(180deg, #2a1a2e 0%, #0e0a10 100%)' }],
        duotones: [{ slug: 'brass', name: 'Brass', colors: ['#2a1a2e', '#d4af37'] }],
        custom: {},
    },
});

test('a valid ThemeSpec passes the contract and the cross-checks', () => {
    const spec = validSpec();
    assert.deepEqual(validateSchema(contract, spec), []);
    assert.deepEqual(themeSpecChecks(spec), []);
});

test('an unknown skeleton fails the contract naming the enum', () => {
    const spec = { ...validSpec(), skeleton: 'floating' };
    const issues = validateSchema(contract, spec);
    const hit = issues.find((i) => i.path === '/skeleton');
    assert.ok(hit, 'expected an issue at /skeleton');
    assert.match(hit.message, /stacked/);
    assert.match(hit.message, /split/);
    assert.match(hit.message, /rail/);
});

test('contentSize must be under wideSize when units match', () => {
    const spec = validSpec();
    spec.measure = { contentSize: '1400px', wideSize: '900px' };
    const issues = themeSpecChecks(spec);
    const hit = issues.find((i) => i.path === '/measure');
    assert.ok(hit, 'expected an issue at /measure');
    assert.match(hit.message, /1400px/);
    assert.match(hit.message, /900px/);
});

test('mismatched measure units fail asking for one unit', () => {
    const spec = validSpec();
    spec.measure = { contentSize: '70ch', wideSize: '1200px' };
    const issues = themeSpecChecks(spec);
    const hit = issues.find((i) => i.path === '/measure');
    assert.ok(hit, 'expected an issue at /measure');
    assert.match(hit.message, /same unit/);
});

test('duplicate preset slugs fail naming the duplicate', () => {
    const spec = validSpec();
    spec.presets.shadows.push({ slug: 'lift', name: 'Lift Again', shadow: '0 2px 4px rgba(0,0,0,0.2)' });
    const issues = themeSpecChecks(spec);
    const hit = issues.find((i) => i.path === '/presets/shadows');
    assert.ok(hit, 'expected an issue at /presets/shadows');
    assert.match(hit.message, /lift/);
});

test('reserved and companion-colliding slugs are refused', () => {
    for (const slug of ['twentytwentyfive', 'x-companion']) {
        const spec = validSpec();
        spec.identity.slug = slug;
        const issues = themeSpecChecks(spec);
        assert.ok(issues.some((i) => i.path === '/identity/slug'), `expected a slug issue for "${slug}"`);
    }
});

test('the contract stays inside the validator subset and both copies agree byte-for-byte', () => {
    const copies = [
        '../../contract/schemas/theme-spec.schema.json',
        '../../x-agent/schemas/theme-spec.schema.json',
    ].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'));
    assert.equal(copies[0], copies[1], 'x-agent copy drifted from the contract');

    // The pipeline validator silently ignores unsupported keywords; a contract
    // leaning on one would be decorative. Walk the schema and refuse them.
    const supported = new Set([
        '$schema', 'title', 'description', 'type', 'oneOf', 'const', 'enum', 'pattern',
        'minLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'items',
        'required', 'properties', 'additionalProperties',
    ]);
    const offenders = [];
    (function walk(node, at) {
        if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${at}/${i}`));
        if (!node || typeof node !== 'object') return;
        for (const [key, v] of Object.entries(node)) {
            if (at.endsWith('/properties')) { walk(v, `${at}/${key}`); continue; }
            if (!supported.has(key)) offenders.push(`${at}/${key}`);
            walk(v, `${at}/${key}`);
        }
    }(contract, ''));
    assert.deepEqual(offenders, []);
});
