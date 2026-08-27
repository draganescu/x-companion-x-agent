import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    FF39_UA,
    familySlug,
    parseCss2Faces,
    gstaticVersion,
    resolveGoogleFamily,
    ensureCached,
    installFontFamilies,
    enrichFamilies,
} from '../lib/fonts.mjs';

const CSS2 = `
/* latin */
@font-face {
  font-family: 'Playfair Display';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/playfairdisplay/v39/abc400.woff2) format('woff2');
}
@font-face {
  font-family: 'Playfair Display';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/playfairdisplay/v39/abc700.woff2) format('woff2');
}
`;

const WOFF2_400 = Buffer.from('wOF2-bytes-400-abcdefgh');
const WOFF2_700 = Buffer.from('wOF2-bytes-700-abcdefgh-and-then-some');

function stubFetch(log = []) {
    return async (url, opts = {}) => {
        log.push([url, opts.headers?.['User-Agent'] ?? null]);
        const body = (() => {
            if (url.startsWith('https://fonts.googleapis.com/css2')) return CSS2;
            if (url.startsWith('https://fonts.google.com/metadata/fonts/')) return `)]}'\n${JSON.stringify({ license: 'OFL', family: 'Playfair Display' })}`;
            if (url.includes('raw.githubusercontent.com')) return 'Copyright: the OFL license text.';
            if (url.endsWith('abc400.woff2')) return WOFF2_400;
            if (url.endsWith('abc700.woff2')) return WOFF2_700;
            return null;
        })();
        if (body === null) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
        return {
            ok: true,
            status: 200,
            text: async () => String(body),
            arrayBuffer: async () => (Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : Buffer.from(String(body)).buffer),
        };
    };
}

const SOURCE = { provider: 'google', family: 'Playfair Display', weights: [400, 700] };
const FAMILY = { slug: 'display', name: 'Display', fontFamily: '"Playfair Display", Georgia, serif', source: SOURCE };

test('parseCss2Faces extracts one face per block; gstaticVersion pins the /vNN/ segment', () => {
    const faces = parseCss2Faces(CSS2);
    assert.deepEqual(faces.map((f) => f.weight), [400, 700]);
    assert.equal(faces[0].style, 'normal');
    assert.equal(gstaticVersion(faces[0].url), 'v39');
    assert.equal(familySlug('Playfair Display'), 'playfair-display');
});

test('resolveGoogleFamily uses the FF39 UA, resolves version + license, fails loudly on an unknown family', async () => {
    const log = [];
    const resolved = await resolveGoogleFamily(SOURCE, { fetchImpl: stubFetch(log) });
    assert.equal(log[0][1], FF39_UA);
    assert.equal(resolved.version, 'v39');
    assert.equal(resolved.license, 'ofl');
    assert.match(resolved.license_text, /OFL license text/);
    assert.equal(resolved.faces.length, 2);

    const missing404 = async (url, opts) => ({ ok: false, status: 404, text: async () => '' });
    await assert.rejects(
        () => resolveGoogleFamily({ provider: 'google', family: 'No Such Face', weights: [400] }, { fetchImpl: missing404 }),
        (e) => e.code === 'font_failed' && /No Such Face/.test(e.message),
    );
});

test('ensureCached: miss downloads + writes LICENSE and hash-pinned meta; hit fetches NOTHING; corruption re-downloads', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'x-fonts-'));
    const log = [];
    const resolved = await resolveGoogleFamily(SOURCE, { fetchImpl: stubFetch(log) });

    const first = await ensureCached(resolved, { cacheDir, fetchImpl: stubFetch(log) });
    assert.equal(first.cache, 'miss');
    assert.equal(first.files.length, 2);
    const dir = join(cacheDir, 'playfair-display@v39');
    assert.deepEqual(readdirSync(dir).sort(), ['LICENSE.txt', 'meta.json', 'playfair-display-400.woff2', 'playfair-display-700.woff2']);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.equal(meta.license, 'ofl');
    assert.equal(Object.keys(meta.files).length, 2);

    const hitLog = [];
    const second = await ensureCached(resolved, { cacheDir, fetchImpl: stubFetch(hitLog) });
    assert.equal(second.cache, 'hit');
    assert.deepEqual(hitLog, [], 'a cache hit performs zero fetches');

    writeFileSync(join(dir, 'playfair-display-400.woff2'), 'corrupted');
    const third = await ensureCached(resolved, { cacheDir, fetchImpl: stubFetch([]) });
    assert.equal(third.cache, 'miss');
});

test('installFontFamilies: create family (stringified settings), one multipart face per weight, srcs collected', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'x-fonts-'));
    const calls = [];
    const rest = async (method, route, opts = {}) => {
        calls.push([method, route, opts]);
        if (method === 'GET' && route === '/wp/v2/font-families') return [];
        if (method === 'POST' && route === '/wp/v2/font-families') return { id: 41, font_family_settings: parse(opts) };
        if (method === 'GET' && route === '/wp/v2/font-families/41/font-faces') return [];
        if (method === 'POST' && route === '/wp/v2/font-families/41/font-faces') {
            const settings = parse(opts);
            return { id: 90, font_face_settings: { ...settings, src: `http://x/wp-content/uploads/fonts/${settings.fontWeight}.woff2` } };
        }
        throw new Error(`unexpected ${method} ${route}`);
    };
    const parse = (opts) => JSON.parse(opts.multipart.find((p) => p.name.endsWith('_settings')).value);

    const { entries, fontFacesBySlug } = await installFontFamilies({ families: [FAMILY], rest, cacheDir, fetchImpl: stubFetch() });

    const createFamily = calls.find(([m, r]) => m === 'POST' && r === '/wp/v2/font-families');
    const settingsPart = createFamily[2].multipart.find((p) => p.name === 'font_family_settings');
    assert.equal(typeof settingsPart.value, 'string', 'settings ride as STRINGIFIED JSON (the multipart contract)');
    assert.deepEqual(JSON.parse(settingsPart.value), { name: 'Playfair Display', slug: 'playfair-display', fontFamily: '"Playfair Display", Georgia, serif' });

    const facePosts = calls.filter(([m, r]) => m === 'POST' && r === '/wp/v2/font-families/41/font-faces');
    assert.equal(facePosts.length, 2);
    for (const [, , opts] of facePosts) {
        const settings = JSON.parse(opts.multipart.find((p) => p.name === 'font_face_settings').value);
        assert.equal(settings.src, 'file-0', 'the file part is referenced by name from src');
        assert.ok(opts.multipart.some((p) => p.name === 'file-0' && p.filePath.endsWith('.woff2')));
    }

    assert.equal(entries.length, 1);
    assert.equal(entries[0].cache, 'miss');
    assert.equal(entries[0].license, 'ofl');
    assert.deepEqual(entries[0].weights, [400, 700]);
    assert.ok(entries[0].bytes > 0);
    assert.deepEqual(fontFacesBySlug.display.map((f) => f.src[0]), ['http://x/wp-content/uploads/fonts/400.woff2', 'http://x/wp-content/uploads/fonts/700.woff2']);
});

test('installFontFamilies reuses an existing family post and skips weights already installed', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'x-fonts-'));
    const calls = [];
    const rest = async (method, route, opts = {}) => {
        calls.push([method, route, opts]);
        if (method === 'GET' && route === '/wp/v2/font-families') return [{ id: 7 }];
        if (method === 'GET' && route === '/wp/v2/font-families/7/font-faces') {
            return [{ id: 71, font_face_settings: { fontFamily: 'Playfair Display', fontStyle: 'normal', fontWeight: '400', src: 'http://x/uploads/fonts/existing-400.woff2' } }];
        }
        if (method === 'POST' && route === '/wp/v2/font-families/7/font-faces') {
            return { id: 72, font_face_settings: { fontWeight: '700', src: ['http://x/uploads/fonts/new-700.woff2'] } };
        }
        throw new Error(`unexpected ${method} ${route}`);
    };

    const { fontFacesBySlug } = await installFontFamilies({ families: [FAMILY], rest, cacheDir, fetchImpl: stubFetch() });

    assert.ok(!calls.some(([m, r]) => m === 'POST' && r === '/wp/v2/font-families'), 'no duplicate family post');
    assert.equal(calls.filter(([m, r]) => m === 'POST' && r.endsWith('/font-faces')).length, 1, 'only the missing weight uploads');
    assert.deepEqual(fontFacesBySlug.display.map((f) => f.src[0]).sort(), ['http://x/uploads/fonts/existing-400.woff2', 'http://x/uploads/fonts/new-700.woff2']);
});

test('enrichFamilies: fontFace merged onto sourced entries, source never reaches the tool payload', () => {
    const families = [FAMILY, { slug: 'body', name: 'Body', fontFamily: 'Georgia, serif' }];
    const enriched = enrichFamilies(families, { display: [{ fontFamily: 'Playfair Display', fontStyle: 'normal', fontWeight: '400', src: ['http://x/f.woff2'] }] });
    assert.equal(enriched[0].source, undefined);
    assert.equal(enriched[0].fontFace.length, 1);
    assert.deepEqual(enriched[1], { slug: 'body', name: 'Body', fontFamily: 'Georgia, serif' });
});
