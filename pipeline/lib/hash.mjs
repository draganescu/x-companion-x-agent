import { createHash } from 'node:crypto';

function sortValue(v) {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v && typeof v === 'object') {
        return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortValue(v[k])]));
    }
    return v;
}

export function canonicalJson(value) {
    return JSON.stringify(sortValue(value));
}

export function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}
