// The brief is authored against brief.schema.json; the scaffold tools enforce
// their own patterns. Where the two disagree the model gets blamed for writing
// exactly what it was told to. These tests pin the translation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { toScaffoldInput } from '../stages/s6-schema-packages.mjs';
import { normalizeAttributes } from '../stages/s5-blocks.mjs';

// The patterns wp_schema_scaffold / wp_block_scaffold actually enforce.
const META_KEY = /^[a-z0-9_]+$/;      // snake_case
const BINDING_NAME = /^[a-z0-9-]+$/;  // kebab-case — the opposite convention

test('S6: binding names are kebab-cased and meta keys snake-cased for the tool', () => {
    const decl = {
        slug: 'bs-catalog',
        intent: 'catalog',
        post_types: [{ slug: 'bere', label: 'Bere', meta: [{ key: 'bere-abv', type: 'number' }] }],
        bindings: [
            { name: 'bere_abv', meta_key: 'bere_abv' },
            { name: 'concert_artist', meta_key: 'concert-artist', label: 'Artist' },
        ],
    };
    const out = toScaffoldInput(decl, '/tmp/run');

    for (const b of out.bindings) {
        assert.match(b.name, BINDING_NAME, `binding name "${b.name}" would be rejected by wp_schema_scaffold`);
        assert.match(b.meta_key, META_KEY, `meta_key "${b.meta_key}" would be rejected by wp_schema_scaffold`);
    }
    assert.deepEqual(out.bindings.map((b) => b.name), ['bere-abv', 'concert-artist']);
    assert.deepEqual(out.bindings.map((b) => b.meta_key), ['bere_abv', 'concert_artist']);
    assert.equal(out.bindings[1].label, 'Artist'); // optional field survives
    for (const m of out.post_types[0].meta) assert.match(m.key, META_KEY);
});

test('S5: select options widen from bare strings to {label, value}', () => {
    const out = normalizeAttributes([
        { name: 'zi', type: 'string', control: 'select', options: ['luni', 'marti'] },
        { name: 'gata', type: 'boolean', control: 'toggle' },
        { name: 'stil', type: 'string', control: 'select', options: [{ label: 'Pils', value: 'pils' }] },
    ]);
    assert.deepEqual(out[0].options, [{ label: 'luni', value: 'luni' }, { label: 'marti', value: 'marti' }]);
    assert.equal(out[1].options, undefined);                              // untouched
    assert.deepEqual(out[2].options, [{ label: 'Pils', value: 'pils' }]); // already correct, unchanged
});

test('the brief contract declares every pattern the scaffold tools enforce', () => {
    const brief = JSON.parse(readFileSync(new URL('../schemas/brief.schema.json', import.meta.url), 'utf8'));
    const sp = brief.properties.schema_packages.items.properties;
    // A missing pattern here is how all three of this class of bug got shipped:
    // the model authors a legal brief that the tool then rejects.
    assert.equal(sp.bindings.items.properties.name.pattern, '^[a-z0-9-]+$');
    assert.equal(sp.post_types.items.properties.meta.items.properties.key.pattern, '^[a-z0-9_]+$');
    const opts = brief.properties.custom_blocks.items.properties.attributes.items.properties.options;
    assert.equal(opts.items.type, 'object');
    assert.deepEqual(opts.items.required, ['label', 'value']);
});
