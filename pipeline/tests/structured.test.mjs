import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toStructuredSchema } from '../lib/structured.mjs';
import { kitEnvelopeSchema } from '../lib/kit.mjs';

test('toStructuredSchema strips unsupported keywords, rewrites oneOf, closes objects', () => {
    const out = toStructuredSchema({
        type: 'object',
        properties: {
            slug: { type: 'string', pattern: '^[a-z-]+$', minLength: 2 },
            fluid: { oneOf: [{ type: 'boolean' }, { type: 'object', properties: { min: { type: 'string' } } }] },
            items: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
        required: ['slug'],
    });
    assert.equal(out.additionalProperties, false);
    assert.ok(!('pattern' in out.properties.slug) && !('minLength' in out.properties.slug));
    assert.ok(!('oneOf' in out.properties.fluid) && Array.isArray(out.properties.fluid.anyOf));
    assert.equal(out.properties.fluid.anyOf[1].additionalProperties, false);
    assert.ok(!('minItems' in out.properties.items));
    assert.deepEqual(out.required, ['slug']); // required survives untouched
});

test('the real contracts narrow cleanly: no unsupported keyword survives, every object is closed', () => {
    const brief = JSON.parse(readFileSync(new URL('../schemas/brief.schema.json', import.meta.url), 'utf8'));
    for (const schema of [toStructuredSchema(brief), toStructuredSchema(kitEnvelopeSchema)]) {
        const walk = (o) => {
            if (Array.isArray(o)) return o.forEach(walk);
            if (!o || typeof o !== 'object') return;
            for (const k of ['pattern', 'minLength', 'maxLength', 'minItems', 'maxItems', 'oneOf']) {
                assert.ok(!(k in o), `unsupported keyword "${k}" survived`);
            }
            if (o.type === 'object') assert.equal(o.additionalProperties, false);
            Object.values(o).forEach(walk);
        };
        walk(schema);
    }
});

// The API refuses any-value schemas ("Empty schema ({}) ... is not supported",
// req_011CeQ4aPHCf8mijEjyyzJaK) — a live brief call died on attributes[].default.
test('no empty schema survives narrowing — every schema position gets a concrete type', () => {
    const brief = JSON.parse(readFileSync(new URL('../schemas/brief.schema.json', import.meta.url), 'utf8'));
    for (const schema of [toStructuredSchema(brief), toStructuredSchema(kitEnvelopeSchema)]) {
        const walk = (o, path) => {
            if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${path}/${i}`));
            if (!o || typeof o !== 'object') return;
            assert.ok(Object.keys(o).length > 0, `empty {} survived at ${path}`);
            Object.entries(o).forEach(([k, v]) => walk(v, `${path}/${k}`));
        };
        walk(schema, '');
    }
    // the substitution itself: an any-value default becomes a concrete union
    const out = toStructuredSchema({ type: 'object', properties: { default: { description: 'any value' } } });
    assert.ok(Array.isArray(out.properties.default.anyOf));
    assert.equal(out.properties.default.description, 'any value');
    // ...but keyword maps are never touched: required stays a plain array
    const req = toStructuredSchema({ type: 'object', required: ['a'], properties: { a: { type: 'string' } } });
    assert.deepEqual(req.required, ['a']);
});
