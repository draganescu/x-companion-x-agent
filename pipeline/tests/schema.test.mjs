import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../lib/schema.mjs';

const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'items'],
    properties: {
        version: { const: 1 },
        name: { type: 'string', minLength: 2, pattern: '^[a-z-]+$' },
        kind: { enum: ['a', 'b'] },
        count: { type: 'integer', minimum: 0, maximum: 10 },
        items: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['id'],
                additionalProperties: false,
                properties: { id: { type: 'string' } },
            },
        },
    },
};

test('valid document returns no issues', () => {
    const issues = validateSchema(schema, { version: 1, name: 'ok-name', kind: 'a', count: 3, items: [{ id: 'x' }] });
    assert.deepEqual(issues, []);
});

test('each violation is reported with a JSON pointer', () => {
    const issues = validateSchema(schema, {
        version: 2, name: 'X', kind: 'c', count: 11.5, items: [{ id: 42, extra: true }], stray: 1,
    });
    const paths = issues.map((i) => i.path);
    assert.ok(paths.includes('/version'));            // const
    assert.ok(paths.includes('/name'));               // minLength + pattern
    assert.ok(paths.includes('/kind'));               // enum
    assert.ok(paths.includes('/count'));              // maximum + integer
    assert.ok(paths.includes('/items/0/id'));         // type
    assert.ok(paths.includes('/items/0/extra'));      // additionalProperties:false
    assert.ok(paths.includes('/stray'));              // additionalProperties:false
});

test('missing required and minItems', () => {
    const issues = validateSchema(schema, { version: 1, items: [] });
    assert.ok(issues.some((i) => i.path === '/items' && /minItems|at least/.test(i.message)));
    const missing = validateSchema(schema, { items: [{ id: 'x' }] });
    assert.ok(missing.some((i) => i.path === '' && /version/.test(i.message)));
});

test('oneOf: exactly one alternative must match', () => {
    const s = { oneOf: [{ type: 'string' }, { type: 'object', required: ['min'], properties: { min: { type: 'string' } } }] };
    assert.deepEqual(validateSchema(s, '2rem'), []);
    assert.deepEqual(validateSchema(s, { min: '1rem' }), []);
    assert.ok(validateSchema(s, 42).length > 0);
});

test('the vendored design-tokens contract validates the Moulin Rouge token set', async () => {
    const { readFileSync } = await import('node:fs');
    const contract = JSON.parse(readFileSync(new URL('../../contract/schemas/design-tokens.schema.json', import.meta.url), 'utf8'));
    const tokens = JSON.parse(readFileSync(new URL('../../sites/moulin-rouge/trees/tokens.json', import.meta.url), 'utf8'));
    assert.deepEqual(validateSchema(contract, tokens), []);
});
