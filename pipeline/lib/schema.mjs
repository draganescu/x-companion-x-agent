// Minimal draft-07 subset validator — house rule: no ajv (see x-agent/tests/schemas.test.ts).
// Supports exactly the keywords pipeline/schemas/*.json use; ignores anything else.

function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

export function validateSchema(schema, value, path = '', issues = []) {
    if (!schema || typeof schema !== 'object') return issues;

    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        const t = typeOf(value);
        const ok = types.some((want) => (want === 'integer' ? t === 'number' && Number.isInteger(value) : t === want));
        if (!ok) {
            issues.push({ path, message: `expected ${types.join('|')}, got ${t}` });
            return issues; // wrong type: deeper checks are noise
        }
    }
    if (schema.oneOf !== undefined) {
        const passing = schema.oneOf.filter((sub) => validateSchema(sub, value, path, []).length === 0).length;
        if (passing !== 1) {
            issues.push({ path, message: `must match exactly one of ${schema.oneOf.length} alternatives (matched ${passing})` });
        }
    }
    if (schema.const !== undefined && value !== schema.const) {
        issues.push({ path, message: `expected const ${JSON.stringify(schema.const)}` });
    }
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
        issues.push({ path, message: `expected one of ${schema.enum.join(', ')}` });
    }
    if (typeof value === 'string') {
        if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
            issues.push({ path, message: `does not match ${schema.pattern}` });
        }
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            issues.push({ path, message: `shorter than minLength ${schema.minLength}` });
        }
    }
    if (typeof value === 'number') {
        if (schema.type === 'integer' && !Number.isInteger(value)) {
            issues.push({ path, message: 'expected an integer' });
        }
        if (schema.minimum !== undefined && value < schema.minimum) {
            issues.push({ path, message: `below minimum ${schema.minimum}` });
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            issues.push({ path, message: `above maximum ${schema.maximum}` });
        }
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            issues.push({ path, message: `fewer than minItems ${schema.minItems} (at least ${schema.minItems})` });
        }
        if (schema.maxItems !== undefined && value.length > schema.maxItems) {
            issues.push({ path, message: `more than maxItems ${schema.maxItems}` });
        }
        if (schema.items !== undefined) {
            value.forEach((v, i) => validateSchema(schema.items, v, `${path}/${i}`, issues));
        }
    }
    if (typeOf(value) === 'object') {
        for (const key of schema.required ?? []) {
            if (!(key in value)) issues.push({ path, message: `missing required property "${key}"` });
        }
        const props = schema.properties ?? {};
        for (const [key, v] of Object.entries(value)) {
            const esc = key.replace(/~/g, '~0').replace(/\//g, '~1');
            if (key in props) {
                validateSchema(props[key], v, `${path}/${esc}`, issues);
            } else if (schema.additionalProperties === false) {
                issues.push({ path: `${path}/${esc}`, message: 'unexpected property' });
            } else if (typeof schema.additionalProperties === 'object') {
                validateSchema(schema.additionalProperties, v, `${path}/${esc}`, issues);
            }
        }
    }
    return issues;
}
