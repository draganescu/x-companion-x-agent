import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSchema } from '../lib/schema.mjs';

const schema = JSON.parse(readFileSync(new URL('../schemas/brief.schema.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));

test('the M1 budget fixture validates clean', () => {
    assert.deepEqual(validateSchema(schema, fixture), []);
});

test('fixture declares exactly S=3, B=1, P=1, I=2', () => {
    const S = fixture.pages.reduce((n, p) => n + p.sections.length, 0);
    const I = fixture.pages.reduce((n, p) => n + p.sections.filter((s) => s.image_intent).length, 0);
    assert.equal(S, 3);
    assert.equal(fixture.custom_blocks.length, 1);
    assert.equal(fixture.schema_packages.length, 1);
    assert.equal(I, 2);
});

test('a sectionless page, a bad role, and a gap-argument-free block all fail', () => {
    const bad = structuredClone(fixture);
    bad.pages[0].sections = [];
    assert.ok(validateSchema(schema, bad).length > 0);

    const badRole = structuredClone(fixture);
    badRole.pages[0].sections[0].role = 'jumbotron';
    assert.ok(validateSchema(schema, badRole).some((i) => i.path.endsWith('/role')));

    const badBlock = structuredClone(fixture);
    delete badBlock.custom_blocks[0].gap_argument;
    assert.ok(validateSchema(schema, badBlock).some((i) => /gap_argument/.test(i.message)));
});

test('free-form extra keys are rejected (additionalProperties:false throughout)', () => {
    const bad = structuredClone(fixture);
    bad.creative_notes = 'no free text lanes';
    assert.ok(validateSchema(schema, bad).some((i) => i.path === '/creative_notes'));
});

test('design is required per section; bad band fails; array image_intent is valid', () => {
    const noDesign = structuredClone(fixture);
    delete noDesign.pages[0].sections[0].design;
    assert.ok(validateSchema(schema, noDesign).some((i) => /design/.test(i.message)));

    const badBand = structuredClone(fixture);
    badBand.pages[0].sections[0].design.band = 'neon';
    assert.ok(validateSchema(schema, badBand).some((i) => i.path.endsWith('/band')));

    const arrayIntents = structuredClone(fixture);
    arrayIntents.pages[0].sections[1].image_intent = [
        'A boule on linen, warm top light, shallow depth.',
        'Two croissants stacked, flaky detail close-up.',
    ];
    assert.deepEqual(validateSchema(schema, arrayIntents), []);
});
