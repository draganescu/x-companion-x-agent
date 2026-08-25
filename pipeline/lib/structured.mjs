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

export function toStructuredSchema(schema) {
    const walk = (node) => {
        if (Array.isArray(node)) return node.map(walk);
        if (!node || typeof node !== 'object') return node;
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            if (UNSUPPORTED.has(k)) continue;
            if (k === 'oneOf') {
                out.anyOf = walk(v);
                continue;
            }
            out[k] = walk(v);
        }
        if (out.type === 'object') out.additionalProperties = false;
        return out;
    };
    return walk(schema);
}
