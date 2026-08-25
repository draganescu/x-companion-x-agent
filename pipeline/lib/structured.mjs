// Anthropic structured outputs (output_config.format json_schema) accept a
// subset of JSON Schema. This narrows a contract schema into that subset
// WITHOUT weakening the pipeline's gate: the local validator still enforces
// the full contract (patterns, lengths, exact oneOf) on the way back — the
// grammar's job is to make syntax slips, mangled keys, and stray properties
// unwritable, so the metered schema-retry is spent on semantic checks the
// grammar cannot express (contrast ratios, quantization ledger, containment).
//
// - strips pattern / minLength / maxLength / minItems / maxItems (unsupported)
// - rewrites oneOf -> anyOf (oneOf unsupported; our alternatives are disjoint)
// - forces additionalProperties: false on every typed object (API requirement)
const UNSUPPORTED = new Set(['pattern', 'minLength', 'maxLength', 'minItems', 'maxItems']);
const CONCRETE = ['type', 'enum', 'const', 'anyOf', 'allOf', '$ref', 'properties', 'items'];

// The API refuses any-value schemas ("Empty schema ({}) ... is not supported").
// Contracts use {} honestly in two places — a block attribute's default (any
// JSON value) and the Region recursion terminal — so an empty SCHEMA position
// becomes this concrete union instead. It narrows what the model can EMIT
// there, never what the contract accepts back.
const ANY_VALUE = {
    anyOf: [
        { type: 'null' },
        { type: 'boolean' },
        { type: 'number' },
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
        { type: 'object', additionalProperties: false },
    ],
};

// Which keys of a schema hold nested SCHEMAS (vs plain keyword data): needed so
// the empty-schema substitution never fires on keyword maps like `required`.
const SCHEMA_MAP_KEYS = new Set(['properties', 'definitions', '$defs']);
const SCHEMA_KEYS = new Set(['items', 'additionalProperties']);
const SCHEMA_LIST_KEYS = new Set(['oneOf', 'anyOf', 'allOf']);

export function toStructuredSchema(schema) {
    const walkSchema = (node) => {
        if (typeof node === 'boolean') return node; // true/false schemas pass through
        if (!node || typeof node !== 'object') return node;
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            if (UNSUPPORTED.has(k)) continue;
            if (k === 'oneOf') {
                out.anyOf = v.map(walkSchema);
            } else if (SCHEMA_LIST_KEYS.has(k)) {
                out[k] = v.map(walkSchema);
            } else if (SCHEMA_MAP_KEYS.has(k)) {
                out[k] = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, walkSchema(s)]));
            } else if (SCHEMA_KEYS.has(k) && typeof v === 'object') {
                out[k] = Array.isArray(v) ? v.map(walkSchema) : walkSchema(v);
            } else {
                out[k] = v;
            }
        }
        if (out.type === 'object') out.additionalProperties = false;
        if (!CONCRETE.some((k) => k in out)) return { ...ANY_VALUE, ...('description' in out ? { description: out.description } : {}) };
        return out;
    };
    return walkSchema(schema);
}
