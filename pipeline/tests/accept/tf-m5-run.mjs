// tf-m5's driver: the Font Library lane end to end against a live instance —
// no model spend anywhere. Real Google download (cache miss then hit), real
// core wp/v2/font-families + font-faces upload, activation via wp_tokens_apply,
// a probe page, wp_verify, the S9 screen, then the activation-strip poison.
// Usage: node tf-m5-run.mjs <scratch-cwd>
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = process.argv[2];
if (!scratch) {
    console.error('usage: node tf-m5-run.mjs <scratch-cwd>');
    process.exit(2);
}
const assert = (cond, what) => {
    if (!cond) {
        console.error(`FAILED: ${what}`);
        process.exit(1);
    }
    console.log(`ok: ${what}`);
};

const { installFontFamilies, enrichFamilies } = await import(join(repo, 'pipeline', 'lib', 'fonts.mjs'));
const { createRest, readConnection } = await import(join(repo, 'pipeline', 'lib', 'rest.mjs'));
const { screenFontFamilies } = await import(join(repo, 'pipeline', 'lib', 'gates.mjs'));
const { createToolchain } = await import(join(repo, 'pipeline', 'lib', 'toolchain.mjs'));

const connection = readConnection(scratch);
const rest = createRest(connection);
const cacheDir = join(scratch, 'fonts-cache');
mkdirSync(cacheDir, { recursive: true });

const families = [{
    slug: 'playfair-display',
    name: 'Playfair Display',
    fontFamily: '"Playfair Display", Georgia, serif',
    source: { provider: 'google', family: 'Playfair Display', weights: [400, 700] },
}];

// 1. cache miss -> install; 2. cache hit, faces reused.
const first = await installFontFamilies({ families, rest, cacheDir, log: console.error });
assert(first.entries[0].cache === 'miss', 'first run downloads (cache miss)');
assert(first.entries[0].license !== 'unknown', `license recorded (${first.entries[0].license})`);
const second = await installFontFamilies({ families, rest, cacheDir, log: console.error });
assert(second.entries[0].cache === 'hit', 'second run is a cache hit');
const srcs = second.fontFacesBySlug['playfair-display'].flatMap((f) => f.src);
assert(srcs.length === 2 && srcs.every((s) => s.includes('/uploads/fonts/')), `every face serves from uploads/fonts (${srcs.join(', ')})`);

// 3. activation rides the tokens write (fontFace into user global styles).
const toolchain = await createToolchain({ cwd: scratch, providerKeys: {} });
const tokens = {
    palette: [
        { slug: 'base', name: 'Base', color: '#faf6ef' },
        { slug: 'contrast', name: 'Contrast', color: '#191410' },
    ],
    spacing: { scale_unit: 'rem', steps: [] },
    typography: { families: enrichFamilies(families, second.fontFacesBySlug), sizes: [] },
    layout: { contentSize: '640px', wideSize: '1200px' },
};
// R9 passthrough: reuse the instance's own spacing/layout so the apply is honest.
const manifest = await toolchain.call('wp_manifest', { summary: true });
assert(manifest.ok, 'wp_manifest answered');
const themeTokens = manifest.data.theme_tokens;
const spacingSizes = themeTokens.spacing?.spacingSizes?.theme ?? themeTokens.spacing?.spacingSizes ?? [];
tokens.spacing = { scale_unit: 'px', steps: (Array.isArray(spacingSizes) ? spacingSizes : []).map((s) => ({ slug: String(s.slug), size: String(s.size) })) };
tokens.layout = { contentSize: String(themeTokens.layout?.contentSize ?? '640px'), wideSize: String(themeTokens.layout?.wideSize ?? '1200px') };

const applied = await toolchain.call('wp_tokens_apply', { ...tokens });
assert(applied.ok, `wp_tokens_apply carried the fontFace activation (${applied.ok ? 'ok' : JSON.stringify(applied.data)})`);

// 4. a probe page that SPENDS the family preset, published via core REST.
const probeMarkup = [
    '<!-- wp:heading {"level":1,"fontFamily":"playfair-display"} -->',
    '<h1 class="wp-block-heading has-playfair-display-font-family">The rendered promise</h1>',
    '<!-- /wp:heading -->',
    '<!-- wp:paragraph -->',
    '<p>Body copy on the stack; the display face is the sourced one.</p>',
    '<!-- /wp:paragraph -->',
].join('\n');
const page = await rest('POST', '/wp/v2/pages', { body: { title: 'tf-m5 font probe', slug: 'tf-m5-font-probe', status: 'publish', content: probeMarkup } });
assert(page.id, `probe page published (${page.link})`);

// 5. wp_verify + the S9 screen: loaded AND rendered. Fresh session first —
// the epoch just moved (tokens apply), and a warm session left over from the
// apply can be dead-but-cached (the recorded S9 discipline).
await toolchain.call('wp_disconnect', {});
const verify1 = await toolchain.call('wp_verify', { url: page.link, wait: 'domcontentloaded', nav_timeout_ms: 120000 });
assert(verify1.ok, 'wp_verify measured the probe page');
const promised = tokens.typography.families;
const clean = screenFontFamilies(verify1.data, promised);
assert(clean.length === 0, `the sourced font loaded and rendered (screen: ${JSON.stringify(clean)})`);

// 6. the no-hotlink pledge: zero font-CDN references anywhere the page serves.
const html = await fetch(page.link).then((r) => r.text());
assert(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html), 'zero font-CDN references in the served page');
assert(/uploads\/fonts\//.test(html), '@font-face serves from uploads/fonts');

// 7. the poison: strip the activation (families without fontFace) and verify again.
const stripped = { ...tokens, typography: { ...tokens.typography, families: families.map(({ source: _s, ...keep }) => keep) } };
const poisonApply = await toolchain.call('wp_tokens_apply', { ...stripped });
assert(poisonApply.ok, 'the activation-strip poison applied');
await toolchain.call('wp_disconnect', {});
const verify2 = await toolchain.call('wp_verify', { url: page.link, wait: 'domcontentloaded', nav_timeout_ms: 120000 });
assert(verify2.ok, 'wp_verify measured the poisoned page');
const failures = screenFontFamilies(verify2.data, promised);
assert(failures.length === 1 && /Playfair Display/.test(failures[0].message), `S9 fails the silent fallback naming the font (${failures[0]?.message ?? 'no failure'})`);

await toolchain.dispose();
console.log('TF-M5 DRIVER COMPLETE');
process.exit(0);
