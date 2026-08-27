/** JPEG quality per class; pattern and spot ship PNG (lossless / alpha). */
const JPEG_QUALITY = {
    field: 0.8,
    canvas: 0.8,
    frieze: 0.85,
};
/** RGB distance under which a spot pixel counts as the key-color ground. */
const CHROMA_TOLERANCE = 48;
/**
 * The chroma key a spot is generated on: the candidate farthest from every
 * palette color, so the knockout can never eat the ornament itself. Pure and
 * stable — the chosen hex is recorded in the manifest.
 */
export function computeKeyHex(paletteHexes) {
    const candidates = ['#00b140', '#ff00ff', '#00ffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#000000', '#ffffff'];
    const parse = (hex) => {
        const h = hex.replace('#', '');
        const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
        return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
    };
    const palette = paletteHexes.map(parse);
    let best = candidates[0];
    let bestScore = -1;
    for (const candidate of candidates) {
        const c = parse(candidate);
        const score = palette.length
            ? Math.min(...palette.map((p) => Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2])))
            : 255;
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return best;
}
export async function processAsset(session, input, inputMime, opts) {
    const page = await session.page({ fresh: true });
    try {
        // Same dev-runtime shim the oracle installs: tsx/esbuild keepNames rewrites
        // arrow consts through a module-scoped __name helper the page lacks.
        await page.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; };').catch(() => { });
        const payload = {
            dataUrl: `data:${inputMime};base64,${input.toString('base64')}`,
            cls: opts.class,
            keyHex: opts.key_hex ?? null,
            quality: JPEG_QUALITY[opts.class] ?? 0.85,
            tolerance: CHROMA_TOLERANCE,
        };
        const raw = (await page.evaluate(async (p) => {
            try {
                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = () => resolve();
                    img.onerror = () => reject(new Error('image failed to decode'));
                    img.src = p.dataUrl;
                });
                const w = img.naturalWidth;
                const h = img.naturalHeight;
                if (!w || !h)
                    return { error: 'decoded image has no pixels' };
                const canvas = document.createElement('canvas');
                let mode;
                if (p.cls === 'pattern') {
                    mode = 'mirror-tile';
                    canvas.width = 2 * w;
                    canvas.height = 2 * h;
                    const g = canvas.getContext('2d');
                    g.drawImage(img, 0, 0);
                    g.save();
                    g.scale(-1, 1);
                    g.drawImage(img, -2 * w, 0);
                    g.restore();
                    g.save();
                    g.scale(1, -1);
                    g.drawImage(img, 0, -2 * h);
                    g.restore();
                    g.save();
                    g.scale(-1, -1);
                    g.drawImage(img, -2 * w, -2 * h);
                    g.restore();
                }
                else {
                    mode = p.cls === 'spot' ? 'chroma-key' : 'recompress';
                    canvas.width = w;
                    canvas.height = h;
                    const g = canvas.getContext('2d');
                    g.drawImage(img, 0, 0);
                    if (p.cls === 'spot' && p.keyHex) {
                        const hex = p.keyHex.replace('#', '');
                        const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
                        const kr = parseInt(full.slice(0, 2), 16);
                        const kg = parseInt(full.slice(2, 4), 16);
                        const kb = parseInt(full.slice(4, 6), 16);
                        const data = g.getImageData(0, 0, w, h);
                        const px = data.data;
                        for (let i = 0; i < px.length; i += 4) {
                            const dr = px[i] - kr;
                            const dg = px[i + 1] - kg;
                            const db = px[i + 2] - kb;
                            if (Math.sqrt(dr * dr + dg * dg + db * db) <= p.tolerance)
                                px[i + 3] = 0;
                        }
                        g.putImageData(data, 0, 0);
                    }
                }
                const final = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
                const px = final.data;
                let lumMin = 1;
                let lumMax = 0;
                let seen = false;
                const lin = (v) => {
                    const c = v / 255;
                    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
                };
                for (let i = 0; i < px.length; i += 16) {
                    if (px[i + 3] === 0)
                        continue;
                    const lum = 0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]);
                    if (lum < lumMin)
                        lumMin = lum;
                    if (lum > lumMax)
                        lumMax = lum;
                    seen = true;
                }
                if (!seen) {
                    lumMin = 0;
                    lumMax = 1;
                }
                const usePng = p.cls === 'pattern' || p.cls === 'spot';
                const dataUrl = usePng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', p.quality);
                return {
                    out: dataUrl.slice(dataUrl.indexOf(',') + 1),
                    mime: usePng ? 'image/png' : 'image/jpeg',
                    lumMin: Math.round(lumMin * 1000) / 1000,
                    lumMax: Math.round(lumMax * 1000) / 1000,
                    _mode: mode,
                };
            }
            catch (e) {
                return { error: e.message };
            }
        }, payload));
        if (raw.error || !raw.out) {
            throw new Error(`asset post-processing failed: ${raw.error ?? 'no output'}`);
        }
        const post = opts.class === 'pattern' ? 'mirror-tile' : opts.class === 'spot' ? 'chroma-key' : 'recompress';
        return {
            bytes: Buffer.from(raw.out, 'base64'),
            mime_type: raw.mime,
            post_processing: post,
            lum_min: raw.lumMin ?? 0,
            lum_max: raw.lumMax ?? 1,
        };
    }
    finally {
        await page.close().catch(() => { });
    }
}
//# sourceMappingURL=process.js.map