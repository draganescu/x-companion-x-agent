/**
 * The asset-pass manifest, v2: ONE file per run directory carrying typed
 * entries for both lanes. Content entries are one-file-one-path, keyed by
 * (post_id, path). Surface entries are the dictionary: ONE file and MANY
 * target paths, keyed by asset_id — reuse is what reads as a designed
 * material system instead of AI noise.
 *
 * Writes always merge into what is on disk instead of overwriting it, so a
 * run that generates per page (or births its canvas early, at S3) grows one
 * manifest instead of clobbering it — the audit trail for the fan-out from
 * one asset to many targets.
 */
import * as fs from 'node:fs';
export const MANIFEST_SCHEMA_VERSION = 2;
export const MANIFEST_FILENAME = 'images-manifest.json';
export function emptyManifest(model, style) {
    const m = { schema_version: 2, model, content: [], surfaces: [] };
    if (style !== undefined)
        m.style = style;
    return m;
}
function isV1(raw) {
    return typeof raw === 'object' && raw !== null && !('schema_version' in raw) && Array.isArray(raw.images);
}
export function loadManifest(path) {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (isV1(raw)) {
        const m = emptyManifest(raw.model, raw.style);
        m.content = raw.images.map((img) => ({ kind: 'content', post_id: raw.post_id, rest_base: raw.rest_base, ...img }));
        return m;
    }
    return raw;
}
export function loadManifestIfPresent(path) {
    return fs.existsSync(path) ? loadManifest(path) : null;
}
const contentKey = (e) => `${e.post_id}${e.path}`;
const targetKey = (t) => `${t.post_id}${t.path}`;
export function mergeManifest(existing, incoming) {
    if (!existing)
        return incoming;
    const merged = emptyManifest(incoming.model, incoming.style ?? existing.style);
    const content = new Map();
    for (const e of existing.content)
        content.set(contentKey(e), e);
    for (const e of incoming.content)
        content.set(contentKey(e), e);
    merged.content = [...content.values()];
    const surfaces = new Map();
    for (const s of existing.surfaces)
        surfaces.set(s.asset_id, s);
    for (const s of incoming.surfaces) {
        const prior = surfaces.get(s.asset_id);
        if (!prior) {
            surfaces.set(s.asset_id, s);
            continue;
        }
        const targets = new Map();
        for (const t of prior.targets)
            targets.set(targetKey(t), t);
        for (const t of s.targets)
            targets.set(targetKey(t), t);
        surfaces.set(s.asset_id, { ...s, targets: [...targets.values()] });
    }
    merged.surfaces = [...surfaces.values()];
    return merged;
}
export function saveManifest(path, m) {
    fs.writeFileSync(path, JSON.stringify(m, null, 2));
}
/**
 * Dedup and replay in one decision: one image call per unique dictionary
 * asset per run, and none at all for an asset the manifest already holds with
 * its file still on disk — a resumed run replays assets instead of re-buying
 * them. Applications are free; only births are metered.
 */
export function planSurfaceCalls(dictionary, manifest, fileExists = fs.existsSync) {
    const generate = [];
    const cached = [];
    const seen = new Set();
    for (const entry of dictionary) {
        if (seen.has(entry.id))
            continue;
        seen.add(entry.id);
        const prior = manifest?.surfaces.find((s) => s.asset_id === entry.id);
        if (prior && fileExists(prior.file))
            cached.push(entry.id);
        else
            generate.push(entry);
    }
    return { generate, cached };
}
//# sourceMappingURL=manifest.js.map