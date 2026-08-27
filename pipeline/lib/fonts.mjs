// The Font Library lane (specs/theme-factory.spec.json, s3_fonts): real
// typography without the instance ever calling out. The AGENT resolves a
// tokens family's `source` against Google Fonts, downloads the woff2s into a
// hash-pinned cache (license recorded beside them), uploads them through
// core's own wp/v2/font-families + font-faces REST, and hands back the
// fontFace activation data that rides the tokens write into global styles.
//
// Discipline: never metered, never in the ledger (the report carries the
// record); a sourced family is a PROMISE, so a lane failure is a RUN failure —
// except the license-TEXT fetch, which degrades to 'unknown' and a log line
// (recorded decision 13). Cache hits perform zero network fetches.
//
// Everything external is injectable ({fetchImpl, rest, cacheDir}) so the
// offline suite runs with zero network and zero WordPress.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from './errors.mjs';

/**
 * The legacy-Firefox trick (verified live): Firefox 39 supported woff2 but not
 * CSS unicode-range, so Google serves ONE complete woff2 per weight instead of
 * seven script subsets — exactly what a self-hosting Font Library wants.
 */
export const FF39_UA = 'Mozilla/5.0 (Windows NT 6.3; rv:39.0) Gecko/20100101 Firefox/39.0';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export const familySlug = (name) => String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Parse css2 output into one face per @font-face block. */
export function parseCss2Faces(css) {
    const faces = [];
    for (const m of String(css).matchAll(/@font-face\s*\{([^}]*)\}/g)) {
        const body = m[1];
        const url = /url\(\s*([^)\s]+?)\s*\)/.exec(body)?.[1]?.replace(/^['"]|['"]$/g, '');
        if (!url) continue;
        const weight = Number(/font-weight:\s*([0-9]+)/.exec(body)?.[1] ?? '400');
        const style = /font-style:\s*(\w+)/.exec(body)?.[1] ?? 'normal';
        faces.push({ weight, style, url });
    }
    return faces;
}

/** The version pin: the /v<NN>/ segment of a fonts.gstatic.com url. */
export function gstaticVersion(url) {
    return /\/v([0-9]+)\//.exec(String(url))?.[0]?.replace(/\//g, '') ?? null;
}

/**
 * Resolve one sourced family: css2 (FF39 UA) for the woff2 urls, the keyless
 * metadata endpoint for the license id, the google/fonts repo for the license
 * text. Only the css2 fetch is load-bearing; the license lookups degrade.
 */
export async function resolveGoogleFamily({ family, weights }, { fetchImpl = fetch, log = () => {} } = {}) {
    const familyParam = family.trim().replace(/ /g, '+');
    const cssUrl = `https://fonts.googleapis.com/css2?family=${familyParam}:wght@${[...weights].sort((a, b) => a - b).join(';')}`;
    const res = await fetchImpl(cssUrl, { headers: { 'User-Agent': FF39_UA } });
    if (!res.ok) {
        throw new PipelineError('font_failed', `Google Fonts has no answer for "${family}" (${res.status} from css2)`,
            'A tokens family with a source is a PROMISE. Check source.family against fonts.google.com spelling; the run fails rather than silently falling back to the stack.');
    }
    const faces = parseCss2Faces(await res.text()).filter((f) => f.style === 'normal' && weights.includes(f.weight));
    const missing = weights.filter((w) => !faces.some((f) => f.weight === w));
    if (faces.length === 0 || missing.length > 0) {
        throw new PipelineError('font_failed', `Google Fonts served no woff2 for "${family}" weight(s) ${missing.join(', ') || weights.join(', ')}`,
            'The css2 response carried no usable @font-face for the requested weights — the family may not ship them.');
    }
    const version = gstaticVersion(faces[0].url) ?? 'v0';

    let license = 'unknown';
    let licenseText = null;
    try {
        const meta = await fetchImpl(`https://fonts.google.com/metadata/fonts/${encodeURIComponent(family.trim())}`, { headers: { Accept: 'application/json' } });
        if (meta.ok) {
            const raw = (await meta.text()).replace(/^\)\]\}'/, '');
            const id = JSON.parse(raw)?.license;
            if (typeof id === 'string' && id) license = id.toLowerCase();
        }
    } catch { /* best effort */ }
    if (license !== 'unknown') {
        const fileFor = { ofl: 'OFL.txt', apache: 'LICENSE.txt', ufl: 'UFL.txt' };
        try {
            const text = await fetchImpl(`https://raw.githubusercontent.com/google/fonts/main/${license}/${family.toLowerCase().replace(/ /g, '')}/${fileFor[license] ?? 'OFL.txt'}`);
            if (text.ok) licenseText = await text.text();
        } catch { /* best effort */ }
    }
    if (license === 'unknown') log(`font lane: could not resolve a license id for "${family}" — recorded as unknown, the download proceeds`);

    return { family: family.trim(), slug: familySlug(family), version, license, license_text: licenseText, faces };
}

/**
 * The agent-side cache: tools/.runtime/fonts/<slug>@<version>/ — woff2s,
 * LICENSE beside them, meta.json pinning every sha256. A hit re-verifies the
 * hashes and performs ZERO fetches; a corrupt file forces a re-download.
 */
export async function ensureCached(resolved, { cacheDir, fetchImpl = fetch, log = () => {} }) {
    const dir = join(cacheDir, `${resolved.slug}@${resolved.version}`);
    const metaPath = join(dir, 'meta.json');
    const fileName = (face) => `${resolved.slug}-${face.weight}${face.style === 'italic' ? '-italic' : ''}.woff2`;

    if (existsSync(metaPath)) {
        try {
            const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
            const files = resolved.faces.map((face) => {
                const name = fileName(face);
                const pin = meta.files?.[name];
                const path = join(dir, name);
                if (!pin || !existsSync(path) || sha256(readFileSync(path)) !== pin.sha256) throw new Error(`cache miss for ${name}`);
                return { weight: face.weight, style: face.style, path, bytes: pin.bytes, sha256: pin.sha256 };
            });
            return { dir, files, cache: 'hit', license: meta.license ?? resolved.license };
        } catch (e) {
            log(`font cache: ${resolved.slug}@${resolved.version} is stale (${e.message}) — re-downloading`);
        }
    }

    mkdirSync(dir, { recursive: true });
    const files = [];
    const meta = { family: resolved.family, version: resolved.version, license: resolved.license, files: {} };
    for (const face of resolved.faces) {
        const res = await fetchImpl(face.url);
        if (!res.ok) {
            throw new PipelineError('font_failed', `download failed for ${resolved.family} ${face.weight} (${res.status})`, 'The gstatic url from css2 refused; retry the run.');
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const name = fileName(face);
        writeFileSync(join(dir, name), buf);
        const pin = { sha256: sha256(buf), bytes: buf.length, url: face.url, weight: face.weight, style: face.style };
        meta.files[name] = pin;
        files.push({ weight: face.weight, style: face.style, path: join(dir, name), bytes: pin.bytes, sha256: pin.sha256 });
    }
    writeFileSync(join(dir, resolved.license === 'unknown' ? 'LICENSE-UNKNOWN.txt' : 'LICENSE.txt'),
        resolved.license_text ?? `License: ${resolved.license}\nSource: Google Fonts (${resolved.family} ${resolved.version})\nThe license text could not be fetched at build time; see fonts.google.com/specimen/${resolved.family.replace(/ /g, '+')}/license.\n`);
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    return { dir, files, cache: 'miss', license: resolved.license };
}

const parseSettings = (value) => {
    if (value && typeof value === 'object') return value;
    try {
        return JSON.parse(String(value ?? ''));
    } catch {
        return {};
    }
};

/**
 * Install every sourced family through core's Font Library REST (WP >= 6.5):
 * one wp_font_family post per family (slug-reused when it already exists —
 * duplicate slugs are a 400), one nested multipart font-face POST per missing
 * weight, `*_settings` as STRINGIFIED JSON per the controllers' contract.
 * Returns the report entries and the fontFace activation data per tokens slug.
 */
export async function installFontFamilies({ families, rest, cacheDir, fetchImpl = fetch, log = () => {} }) {
    const entries = [];
    const fontFacesBySlug = {};
    for (const family of families) {
        const source = family.source;
        const resolved = await resolveGoogleFamily(source, { fetchImpl, log });
        const cached = await ensureCached(resolved, { cacheDir, fetchImpl, log });

        const existing = await rest('GET', '/wp/v2/font-families', { query: { slug: resolved.slug } });
        let familyPost = Array.isArray(existing) && existing.length > 0 ? existing[0] : null;
        if (!familyPost) {
            familyPost = await rest('POST', '/wp/v2/font-families', {
                multipart: [
                    { name: 'font_family_settings', value: JSON.stringify({ name: resolved.family, slug: resolved.slug, fontFamily: family.fontFamily }) },
                    { name: 'theme_json_version', value: '3' },
                ],
            });
        }
        const familyId = familyPost?.id;
        if (!familyId) {
            throw new PipelineError('font_failed', `wp/v2/font-families returned no id for "${resolved.family}"`,
                'The Font Library needs WordPress >= 6.5 and an edit_theme_options credential.');
        }

        const existingFaces = await rest('GET', `/wp/v2/font-families/${familyId}/font-faces`);
        const present = new Map();
        for (const face of Array.isArray(existingFaces) ? existingFaces : []) {
            const settings = parseSettings(face.font_face_settings);
            if (settings.fontStyle && settings.fontStyle !== 'normal') continue;
            present.set(String(settings.fontWeight ?? ''), settings);
        }

        const faceData = [];
        let bytes = 0;
        for (const file of cached.files) {
            bytes += file.bytes;
            const already = present.get(String(file.weight));
            if (already) {
                faceData.push({ fontFamily: resolved.family, fontStyle: 'normal', fontWeight: String(file.weight), src: [already.src].flat().map(String) });
                continue;
            }
            const created = await rest('POST', `/wp/v2/font-families/${familyId}/font-faces`, {
                multipart: [
                    { name: 'font_face_settings', value: JSON.stringify({ fontFamily: resolved.family, fontStyle: 'normal', fontWeight: String(file.weight), fontDisplay: 'swap', src: 'file-0' }) },
                    { name: 'file-0', filePath: file.path },
                ],
            });
            const settings = parseSettings(created?.font_face_settings);
            const src = [settings.src].flat().filter(Boolean).map(String);
            if (src.length === 0) {
                throw new PipelineError('font_failed', `the font-face upload for ${resolved.family} ${file.weight} returned no src`,
                    'Core moves uploads into wp-content/uploads/fonts and echoes the final url; an empty src means the upload never landed.');
            }
            faceData.push({ fontFamily: resolved.family, fontStyle: 'normal', fontWeight: String(file.weight), src });
        }

        fontFacesBySlug[family.slug] = faceData;
        entries.push({
            slug: family.slug,
            family: resolved.family,
            version: resolved.version,
            license: cached.license,
            weights: cached.files.map((f) => f.weight),
            bytes,
            cache: cached.cache,
            family_id: familyId,
        });
        log(`font lane: ${resolved.family} ${resolved.version} (${cached.cache}) — ${faceData.length} face(s) in the Font Library, license ${cached.license}`);
    }
    return { entries, fontFacesBySlug };
}

/**
 * The tool-bound families: `source` stripped (agent-side only), `fontFace`
 * merged in for sourced families — the activation that rides wp_tokens_apply
 * into the user global styles, where wp_print_font_faces reads it.
 */
export function enrichFamilies(families, fontFacesBySlug) {
    return families.map((family) => {
        const { source: _source, ...rest } = family;
        const faces = fontFacesBySlug[family.slug];
        return faces && faces.length > 0 ? { ...rest, fontFace: faces } : rest;
    });
}
