/**
 * ============================================================================
 * oracle.ts — THE NUMERIC LAYOUT ORACLE
 * ============================================================================
 *
 * This is the thing that replaces squinting at screenshots. It answers, in
 * numbers: where did every block wrapper actually land, what does it actually
 * compute to, and by how much does that differ from the Design Spec IR?
 *
 * Three parts:
 *
 *   1. THE PAGE UNDER TEST. `wp_verify` is given either a `url` (navigate it) or
 *      `markup`. There are no author routes in v1, so markup is never turned
 *      into a draft. Instead it goes through `POST /render` (real do_blocks(),
 *      real dynamic blocks) and the returned HTML is embedded in a LOCAL STATIC
 *      SHELL served from 127.0.0.1. The shell loads the instance's own
 *      stylesheets so the measurement is of the real design, not of unstyled
 *      HTML:
 *        - `/render.enqueued_styles` gives the block stylesheets, and
 *        - the site homepage is visited ONCE PER FINGERPRINT to harvest the
 *          theme's <link> stylesheets AND its inline <style> blocks.
 *      The inline half is not optional on a block theme: `wp_enqueue_global_styles`
 *      emits every `--wp--preset--*` custom property inline, so without it every
 *      colour, font size and spacing token measures as its unstyled default.
 *
 *   2. EXTRACTION. `getBoundingClientRect()` + `getComputedStyle()` for every
 *      block wrapper (identified by `.wp-block-*` classes, plus `data-block` /
 *      `data-type` when measuring an editor DOM), and a DOM-derived a11y outline.
 *      Block names come from the manifest, not from string surgery:
 *      `wp.blocks.getBlockDefaultClassName` is `wp-block-{name with / -> - and a
 *      leading core- stripped}`, so the manifest's own key set is inverted into a
 *      className -> block name map. That is why `wp-block-kadence-rowlayout`
 *      resolves to `kadence/rowlayout` and not to `kadence-rowlayout`.
 *
 *   3. THE DIFF. Regions are matched to measured elements by role heuristics +
 *      document order + accessible name + geometry, then diffed numerically.
 *      Unmatched region -> `missing`; unmatched top-level element -> `extra`.
 *
 * Tolerances (spec-pinned, all overridable): position/size 4px or 2%, gap one
 * spacing step, font size 1px.
 *
 * NO `fetch` here either — the only HTTP is `ctx.companion.render()` and page
 * navigations in the warm browser.
 */
import http from 'node:http';
import { XError } from './errors.js';
/** CONTRACT / spec-pinned defaults. */
export const DEFAULT_TOLERANCES = {
    position_px: 4,
    position_ratio: 0.02,
    size_px: 4,
    size_ratio: 0.02,
    gap_steps: 1,
    font_size_px: 1,
    color_channel: 8,
};
export function resolveTolerances(override) {
    const t = { ...DEFAULT_TOLERANCES };
    for (const [k, v] of Object.entries(override ?? {})) {
        if (typeof v === 'number' && Number.isFinite(v))
            t[k] = v;
    }
    return t;
}
/* ------------------------------------------------- manifest -> class lookup */
/**
 * Inverse of `wp.blocks.getBlockDefaultClassName`:
 *   core/paragraph      -> wp-block-paragraph
 *   kadence/rowlayout   -> wp-block-kadence-rowlayout
 *   agent/testimonial   -> wp-block-agent-testimonial
 */
export function defaultClassName(blockName) {
    return 'wp-block-' + blockName.replace('/', '-').replace(/^core-/, '');
}
export function classNameMap(blockNames) {
    const map = {};
    for (const name of blockNames) {
        const cls = defaultClassName(name);
        // A core block wins a collision: `core/x` and `other/core-x` would collide,
        // and core is the one whose class WordPress actually emits.
        if (!map[cls] || name.startsWith('core/'))
            map[cls] = name;
    }
    return map;
}
/** fingerprint -> harvested homepage styles. One homepage visit per epoch. */
const themeStyleCache = new Map();
export function clearThemeStyleCache() {
    themeStyleCache.clear();
}
export function cachedThemeStyles(fingerprint) {
    return themeStyleCache.get(fingerprint);
}
/**
 * Visit the site homepage once per fingerprint and take its stylesheet links,
 * its inline <style> blocks (where a block theme puts every design token) and
 * its body/html classes.
 */
export async function harvestThemeStyles(page, siteUrl, fingerprint) {
    const hit = themeStyleCache.get(fingerprint);
    if (hit)
        return hit;
    try {
        await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    catch (e) {
        const empty = { links: [], inline: [], body_class: '', html_class: '' };
        themeStyleCache.set(fingerprint, empty);
        return empty;
    }
    const harvested = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('link[rel~="stylesheet"]'))
            .map((l) => l.href)
            .filter(Boolean);
        const inline = Array.from(document.querySelectorAll('style'))
            .map((s) => s.textContent ?? '')
            .filter((s) => s.trim().length > 0);
        return {
            links,
            inline,
            body_class: document.body ? document.body.className : '',
            html_class: document.documentElement ? document.documentElement.className : '',
        };
    });
    themeStyleCache.set(fingerprint, harvested);
    return harvested;
}
/**
 * A front-end-shaped page. `.wp-site-blocks` is what a block theme's layout and
 * spacing CSS is written against, so the wrapper is not decoration — drop it and
 * every root-level margin measures wrong.
 */
export function buildShell(input) {
    const links = dedupe(input.styleUrls)
        .map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`)
        .join('\n');
    const inline = (input.inlineStyles ?? []).map((css) => `<style>${css}</style>`).join('\n');
    return [
        '<!doctype html>',
        `<html lang="en" class="${escapeAttr(input.htmlClass ?? '')}">`,
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<base href="${escapeAttr(input.baseHref)}">`,
        `<title>${escapeHtml(input.title ?? 'x-agent verify shell')}</title>`,
        links,
        inline,
        // The shell itself must contribute nothing measurable.
        '<style>html,body{margin:0;padding:0}</style>',
        '</head>',
        `<body class="${escapeAttr(input.bodyClass ?? '')}">`,
        '<div class="wp-site-blocks">',
        input.html,
        '</div>',
        '</body>',
        '</html>',
    ].join('\n');
}
/**
 * Serve the shell from 127.0.0.1 rather than a `data:` URL. A data: document has
 * an opaque origin, which breaks both the `<base>`-relative resolution and the
 * cross-origin stylesheet loads the shell depends on.
 */
export class ShellServer {
    server;
    body = '';
    _url = '';
    get url() {
        return this._url;
    }
    async start(html) {
        this.body = html;
        if (this.server)
            return this._url;
        this.server = http.createServer((req, res) => {
            const path = (req.url ?? '/').split('?')[0];
            if (path === '/' || path === '/index.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(this.body);
                return;
            }
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
        });
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => resolve());
        });
        const addr = this.server.address();
        this._url = `http://127.0.0.1:${addr.port}/`;
        return this._url;
    }
    /** Swap the served document without restarting the server. */
    setHtml(html) {
        this.body = html;
    }
    async close() {
        const s = this.server;
        this.server = undefined;
        this._url = '';
        if (!s)
            return;
        await new Promise((resolve) => s.close(() => resolve()));
    }
}
/**
 * Read the layout out of a loaded page. Runs entirely inside the page so there
 * is exactly one round trip.
 */
/**
 * Dev-runtime shim. `tsx`/esbuild transpile with `keepNames`, which rewrites
 * `const f = () => {}` into `__name(() => {}, "f")`. That helper lives in the
 * Node module scope, so the function body Playwright ships into the page throws
 * `ReferenceError: __name is not defined`. A compiled (tsc) build never hits it,
 * but every test run does. The argument is a STRING so esbuild does not touch it.
 */
export async function installEvalShims(page) {
    await page
        .evaluate('globalThis.__name = globalThis.__name || function (f) { return f; };')
        .catch(() => { });
}
export async function extractLayout(page, nameByClass) {
    await installEvalShims(page);
    // Let webfonts settle before measuring: a @font-face still in flight would
    // report status 'loading' and measure the fallback's metrics. Bounded, so a
    // page with a broken face cannot stall the oracle.
    await page.evaluate(() => {
        const d = document;
        return d.fonts?.ready ? Promise.race([d.fonts.ready, new Promise((r) => setTimeout(r, 3000))]) : null;
    });
    return page.evaluate((lookup) => {
        /* ---------------------------------------------------------- utilities */
        const parsePx = (v) => {
            const n = Number.parseFloat(v);
            return Number.isFinite(n) ? n : 0;
        };
        const parseRgb = (v) => {
            const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)/i.exec(v || '');
            if (!m)
                return null;
            let a = 1;
            if (m[4] !== undefined)
                a = m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4]);
            return [Number(m[1]), Number(m[2]), Number(m[3]), Number.isFinite(a) ? a : 1];
        };
        const selectorPath = (el) => {
            const parts = [];
            let cur = el;
            while (cur && cur !== document.documentElement) {
                const parent = cur.parentElement;
                let idx = 1;
                if (parent) {
                    let n = 0;
                    for (const sib of Array.from(parent.children)) {
                        n += 1;
                        if (sib === cur) {
                            idx = n;
                            break;
                        }
                    }
                }
                const wpClass = Array.from(cur.classList).find((c) => /^wp-block-[a-z0-9-]+$/.test(c));
                parts.unshift(`${cur.tagName.toLowerCase()}${wpClass ? '.' + wpClass : ''}:nth-child(${idx})`);
                cur = parent;
            }
            return parts.join(' > ');
        };
        const textOf = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        const ariaName = (el) => {
            const label = el.getAttribute('aria-label');
            if (label)
                return label.trim();
            const by = el.getAttribute('aria-labelledby');
            if (by) {
                const ref = document.getElementById(by.split(/\s+/)[0] ?? '');
                if (ref)
                    return textOf(ref);
            }
            const alt = el.getAttribute('alt');
            if (alt)
                return alt.trim();
            const title = el.getAttribute('title');
            if (title)
                return title.trim();
            return '';
        };
        /* -------------------------------------------------- the box tree */
        const nodes = [];
        let candidates = 0;
        let named = 0;
        const all = Array.from(document.querySelectorAll('*'));
        let index = 0;
        for (const el of all) {
            const classes = Array.from(el.classList);
            const wpish = classes.filter((c) => c.indexOf('wp-block-') === 0);
            const dataType = el.getAttribute('data-type');
            const dataBlock = el.getAttribute('data-block');
            if (wpish.length === 0 && !dataType && !dataBlock)
                continue;
            candidates += 1;
            let blockName;
            if (dataType && dataType.indexOf('/') > 0)
                blockName = dataType;
            if (!blockName) {
                for (const c of wpish) {
                    if (Object.prototype.hasOwnProperty.call(lookup, c)) {
                        blockName = lookup[c];
                        break;
                    }
                }
            }
            if (blockName)
                named += 1;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            // Largest font size anywhere in the subtree: the region's headline size.
            let maxFont = parsePx(cs.fontSize);
            const desc = el.querySelectorAll('*');
            for (const d of Array.from(desc)) {
                if (!(d.textContent ?? '').trim())
                    continue;
                const f = parsePx(getComputedStyle(d).fontSize);
                if (f > maxFont)
                    maxFont = f;
            }
            // Real vertical rhythm between element children. WordPress implements
            // blockGap as a margin on children for flow/constrained layouts, so the
            // computed `gap` is `normal` there and only this measurement is truthful.
            let childGap = null;
            const kids = Array.from(el.children).filter((k) => {
                const kr = k.getBoundingClientRect();
                return kr.width > 0 && kr.height > 0;
            });
            if (kids.length >= 2) {
                const gaps = [];
                for (let i = 1; i < kids.length; i += 1) {
                    const a = kids[i - 1].getBoundingClientRect();
                    const b = kids[i].getBoundingClientRect();
                    const vertical = b.top >= a.bottom - 1;
                    gaps.push(Math.max(0, vertical ? b.top - a.bottom : b.left - a.right));
                }
                gaps.sort((p, q) => p - q);
                childGap = gaps[Math.floor(gaps.length / 2)] ?? null;
            }
            const bg = parseRgb(cs.backgroundColor);
            const bgIsTransparent = !bg || bg[3] === 0;
            nodes.push({
                selector_path: selectorPath(el),
                block_name: blockName,
                box: {
                    x: r.x + window.scrollX,
                    y: r.y + window.scrollY,
                    w: r.width,
                    h: r.height,
                },
                computed: {
                    display: cs.display,
                    gap: cs.gap && cs.gap !== 'normal' ? cs.gap : cs.rowGap || 'normal',
                    fontSize: cs.fontSize,
                    fontFamily: cs.fontFamily,
                    color: cs.color,
                    background: bgIsTransparent && cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor,
                },
                tag: el.tagName.toLowerCase(),
                text: textOf(el).slice(0, 240),
                aria_name: ariaName(el),
                depth: selectorPath(el).split(' > ').length,
                index: index++,
                max_font_px: maxFont,
                row_gap_px: cs.rowGap && cs.rowGap !== 'normal' ? parsePx(cs.rowGap) : null,
                child_gap_px: childGap,
                bg_rgba: bg,
                fg_rgba: parseRgb(cs.color),
            });
        }
        /* ------------------------------------------------- the a11y outline */
        const outline = [];
        const landmark = {
            header: 'banner',
            footer: 'contentinfo',
            main: 'main',
            nav: 'navigation',
            aside: 'complementary',
            form: 'form',
            section: 'region',
            article: 'article',
        };
        const walk = (el) => {
            const tag = el.tagName.toLowerCase();
            const explicit = el.getAttribute('role');
            let role = '';
            let level;
            let name = ariaName(el);
            if (explicit) {
                role = explicit;
            }
            else if (/^h[1-6]$/.test(tag)) {
                role = 'heading';
                level = Number(tag.slice(1));
            }
            else if (tag === 'a' && el.hasAttribute('href')) {
                role = 'link';
            }
            else if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type))) {
                role = 'button';
            }
            else if (tag === 'img') {
                const alt = el.getAttribute('alt');
                if (alt !== '')
                    role = 'img';
            }
            else if (tag === 'ul' || tag === 'ol') {
                role = 'list';
            }
            else if (tag === 'li') {
                role = 'listitem';
            }
            else if (tag === 'table') {
                role = 'table';
            }
            else if (tag === 'input' || tag === 'textarea') {
                role = 'textbox';
            }
            else if (tag === 'select') {
                role = 'combobox';
            }
            else if (landmark[tag]) {
                // A bare <section> is only a landmark when it is named.
                if (tag !== 'section' || name)
                    role = landmark[tag];
            }
            if (role) {
                if (!name && (role === 'heading' || role === 'link' || role === 'button' || role === 'listitem')) {
                    name = textOf(el).slice(0, 120);
                }
                const entry = { role, name };
                if (level !== undefined)
                    entry.level = level;
                outline.push(entry);
            }
            for (const child of Array.from(el.children))
                walk(child);
        };
        if (document.body)
            for (const child of Array.from(document.body.children))
                walk(child);
        /* ---------------------------------------- ink vs ground, every text leaf */
        // Every element carrying its OWN text, rated against the nearest painted
        // ancestor background. This is measured here — not inferred from markup —
        // because the two authoring lanes can each produce readable-looking inputs
        // that render unreadable together (a block stylesheet spending a palette
        // slug that equals the band it lands on). Pairs under 4.5:1 are reported;
        // policy (what fails a run) belongs to the caller. Text over images is
        // skipped: there is no single ground to rate against.
        const lumOf = (c) => {
            const f = (v) => {
                const s = v / 255;
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
        };
        const contrastOf = (a, b) => {
            const la = lumOf(a);
            const lb = lumOf(b);
            const hi = Math.max(la, lb);
            const lo = Math.min(la, lb);
            return (hi + 0.05) / (lo + 0.05);
        };
        const textContrast = [];
        for (const el of Array.from(document.querySelectorAll('body *'))) {
            if (textContrast.length >= 100)
                break;
            const own = Array.from(el.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent ?? '')
                .join('')
                .trim();
            if (!own)
                continue;
            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || Number.parseFloat(cs.opacity) < 0.05)
                continue;
            const ink = parseRgb(cs.color);
            if (!ink || ink[3] === 0)
                continue;
            let cur = el;
            let ground = null;
            let overImage = false;
            while (cur && cur !== document.documentElement) {
                const cc = getComputedStyle(cur);
                if (cc.backgroundImage && cc.backgroundImage !== 'none') {
                    overImage = true;
                    break;
                }
                const b = parseRgb(cc.backgroundColor);
                if (b && b[3] > 0.1) {
                    ground = b;
                    break;
                }
                cur = cur.parentElement;
            }
            if (overImage || !ground)
                continue;
            const ratio = contrastOf(ink, ground);
            if (ratio < 4.5) {
                textContrast.push({
                    selector_path: selectorPath(el),
                    ratio: Math.round(ratio * 100) / 100,
                    color: cs.color,
                    background: `rgb(${ground[0]}, ${ground[1]}, ${ground[2]})`,
                    sample: own.slice(0, 80),
                });
            }
        }
        const fonts = [];
        const fontSet = document.fonts;
        if (fontSet && typeof fontSet.forEach === 'function') {
            fontSet.forEach((f) => {
                fonts.push({ family: String(f.family).replace(/^['"]|['"]$/g, ''), style: f.style, weight: f.weight, status: f.status });
            });
        }
        return {
            nodes,
            a11y_outline: outline,
            stats: { candidates, named, named_ratio: candidates === 0 ? 1 : named / candidates },
            text_contrast: textContrast,
            fonts,
        };
    }, nameByClass);
}
/** Project the internal measurement onto the declared tool output shape. */
export function toBoxTree(nodes) {
    return nodes.map((n) => {
        const out = {
            selector_path: n.selector_path,
            box: { x: round2(n.box.x), y: round2(n.box.y), w: round2(n.box.w), h: round2(n.box.h) },
            computed: n.computed,
        };
        if (n.block_name)
            out.block_name = n.block_name;
        return out;
    });
}
/* -------------------------------------------------------------- token maths */
const ROOT_FONT_PX = 16;
/** `1.5rem` / `24px` / `1.2em` -> px. Returns null for anything non-numeric. */
export function cssLengthToPx(value, rootPx = ROOT_FONT_PX) {
    if (typeof value !== 'string')
        return null;
    const v = value.trim();
    const m = /^(-?[\d.]+)\s*(px|rem|em|pt|%)?$/.exec(v);
    if (!m) {
        // clamp()/min()/max(): take the largest literal length as the settled value
        // at a wide viewport, which is where this oracle measures.
        const lens = [...v.matchAll(/(-?[\d.]+)\s*(px|rem|em|pt)/g)].map((g) => unit(Number(g[1]), g[2] ?? 'px', rootPx));
        return lens.length ? Math.max(...lens) : null;
    }
    return unit(Number(m[1]), m[2] ?? 'px', rootPx);
}
function unit(n, u, rootPx) {
    switch (u) {
        case 'rem':
        case 'em':
            return n * rootPx;
        case 'pt':
            return (n * 96) / 72;
        case '%':
            return n;
        default:
            return n;
    }
}
export function hexToRgb(hex) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
    if (!m)
        return null;
    let h = m[1];
    if (h.length === 3)
        h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
/**
 * "One spacing step" as a px tolerance: snap the expected value onto the token
 * scale and take the distance to its nearest neighbour on that scale. A design
 * that is off by less than the smallest distinguishable step on its own scale
 * has not made a token decision differently — it has rounded.
 */
export function oneSpacingStepPx(spec, expectedPx) {
    const steps = (spec.tokens_candidates?.spacing?.steps ?? [])
        .map((s) => cssLengthToPx(s.size))
        .filter((n) => n !== null && n > 0)
        .sort((a, b) => a - b);
    if (steps.length < 2)
        return 8;
    let nearest = 0;
    let best = Infinity;
    steps.forEach((s, i) => {
        const d = Math.abs(s - expectedPx);
        if (d < best) {
            best = d;
            nearest = i;
        }
    });
    const prev = nearest > 0 ? steps[nearest] - steps[nearest - 1] : Infinity;
    const next = nearest < steps.length - 1 ? steps[nearest + 1] - steps[nearest] : Infinity;
    const step = Math.min(prev, next);
    return Number.isFinite(step) && step > 0 ? step : 8;
}
export function fontSizePxForSlug(spec, slug) {
    const entry = (spec.tokens_candidates?.typography?.sizes ?? []).find((s) => s.slug === slug);
    if (!entry)
        return null;
    return cssLengthToPx(entry.size);
}
export function paletteHexForSlug(spec, slug) {
    const entry = (spec.tokens_candidates?.palette ?? []).find((p) => p.slug === slug);
    return entry ? entry.color : null;
}
export function flattenRegions(regions) {
    const out = [];
    let order = 0;
    const walk = (list, depth, parentId) => {
        for (const r of list) {
            const entry = { region: r, depth, order: order++ };
            if (parentId !== undefined)
                entry.parentId = parentId;
            out.push(entry);
            if (r.children && r.children.length)
                walk(r.children, depth + 1, r.id);
        }
    };
    walk(regions, 0);
    return out;
}
export function findRegion(regions, id) {
    for (const r of regions) {
        if (r.id === id)
            return r;
        if (r.children) {
            const hit = findRegion(r.children, id);
            if (hit)
                return hit;
        }
    }
    return undefined;
}
/** Blocks/tags a role plausibly maps onto. A bonus, never a hard filter. */
const ROLE_AFFINITY = {
    header: { blocks: ['core/group', 'core/template-part', 'core/site-header', 'core/cover'], tags: ['header'] },
    hero: { blocks: ['core/cover', 'core/group', 'core/media-text', 'core/columns'], tags: ['section', 'header', 'div'] },
    features: { blocks: ['core/columns', 'core/group', 'core/query', 'core/gallery'], tags: ['section', 'div'] },
    gallery: { blocks: ['core/gallery', 'core/columns', 'core/group'], tags: ['section', 'div', 'figure'] },
    testimonial: { blocks: ['core/quote', 'core/pullquote', 'core/group', 'core/columns'], tags: ['section', 'blockquote', 'div'] },
    cta: { blocks: ['core/group', 'core/cover', 'core/buttons'], tags: ['section', 'div'] },
    footer: { blocks: ['core/group', 'core/template-part'], tags: ['footer'] },
    section: { blocks: ['core/group', 'core/columns', 'core/cover'], tags: ['section', 'div'] },
    column: { blocks: ['core/column'], tags: ['div'] },
    item: { blocks: [], tags: [] },
};
function normalise(s) {
    return s.toLowerCase().replace(/[\s‘’“”'"]+/g, ' ').replace(/\s+/g, ' ').trim();
}
export function diffAgainstSpec(opts) {
    const { spec, nodes, viewport, tolerances } = opts;
    const roots = opts.regionId
        ? (() => {
            const r = findRegion(spec.regions, opts.regionId);
            if (!r) {
                throw new XError('invalid_input', `spec_region_id "${opts.regionId}" is not a region in this spec.`, `Known region ids: ${flattenRegions(spec.regions).map((f) => f.region.id).join(', ')}`);
            }
            return [r];
        })()
        : spec.regions;
    const srcW = spec.source?.viewport?.width || viewport.width;
    const scale = srcW > 0 ? viewport.width / srcW : 1;
    const flat = flattenRegions(roots);
    const contentByRegion = new Map();
    for (const c of spec.content ?? []) {
        if (!c.text)
            continue;
        const list = contentByRegion.get(c.region_id) ?? [];
        list.push(normalise(c.text));
        contentByRegion.set(c.region_id, list);
    }
    const diffs = [];
    const matches = [];
    const matched = new Map();
    const usedIdx = new Set();
    const diag = Math.hypot(viewport.width, viewport.height) || 1;
    for (const entry of flat) {
        const r = entry.region;
        const expected = {
            x: r.box.x * scale,
            y: r.box.y * scale,
            w: r.box.w * scale,
            h: r.box.h * scale,
        };
        const parentNode = entry.parentId ? matched.get(entry.parentId) : undefined;
        const affinity = ROLE_AFFINITY[r.role] ?? { blocks: [], tags: [] };
        const wanted = contentByRegion.get(r.id) ?? [];
        let best;
        let bestScore = 0;
        for (const n of nodes) {
            if (usedIdx.has(n.index))
                continue;
            if (n.box.w <= 0 || n.box.h <= 0)
                continue;
            // A child region must live inside its matched parent's element.
            if (parentNode && !n.selector_path.startsWith(parentNode.selector_path))
                continue;
            if (parentNode && n.selector_path === parentNode.selector_path)
                continue;
            const dist = Math.abs(n.box.x - expected.x) +
                Math.abs(n.box.y - expected.y) +
                Math.abs(n.box.w - expected.w) +
                Math.abs(n.box.h - expected.h);
            let score = Math.max(0, 1 - dist / diag);
            if (n.block_name && affinity.blocks.includes(n.block_name))
                score += 0.25;
            else if (affinity.tags.includes(n.tag))
                score += 0.1;
            if (wanted.length) {
                const hay = normalise(n.text);
                const hits = wanted.filter((w) => w.length > 3 && hay.includes(w)).length;
                if (hits)
                    score += 0.3 * Math.min(1, hits / wanted.length);
            }
            if (score > bestScore) {
                bestScore = score;
                best = n;
            }
        }
        if (!best || bestScore < 0.35) {
            diffs.push({
                region_id: r.id,
                kind: 'missing',
                expected: { role: r.role, box: roundBox(expected) },
                actual: null,
                delta: null,
                within_tolerance: false,
            });
            continue;
        }
        matched.set(r.id, best);
        usedIdx.add(best.index);
        matches.push({ region_id: r.id, selector_path: best.selector_path, score: round3(bestScore) });
        /* ------------------------------------------------------------ position */
        const dx = best.box.x - expected.x;
        const dy = best.box.y - expected.y;
        const tolX = Math.max(tolerances.position_px, tolerances.position_ratio * viewport.width);
        const tolY = Math.max(tolerances.position_px, tolerances.position_ratio * viewport.height);
        diffs.push({
            region_id: r.id,
            kind: 'position',
            expected: { x: round2(expected.x), y: round2(expected.y) },
            actual: { x: round2(best.box.x), y: round2(best.box.y) },
            delta: { dx: round2(dx), dy: round2(dy), tolerance_px: { x: round2(tolX), y: round2(tolY) } },
            within_tolerance: Math.abs(dx) <= tolX && Math.abs(dy) <= tolY,
        });
        /* ---------------------------------------------------------------- size */
        const dw = best.box.w - expected.w;
        const dh = best.box.h - expected.h;
        const tolW = Math.max(tolerances.size_px, tolerances.size_ratio * Math.abs(expected.w));
        const tolH = Math.max(tolerances.size_px, tolerances.size_ratio * Math.abs(expected.h));
        diffs.push({
            region_id: r.id,
            kind: 'size',
            expected: { w: round2(expected.w), h: round2(expected.h) },
            actual: { w: round2(best.box.w), h: round2(best.box.h) },
            delta: { dw: round2(dw), dh: round2(dh), tolerance_px: { w: round2(tolW), h: round2(tolH) } },
            within_tolerance: Math.abs(dw) <= tolW && Math.abs(dh) <= tolH,
        });
        /* ----------------------------------------------------------------- gap */
        if (r.layout && typeof r.layout.gap_px === 'number') {
            const expectedGap = r.layout.gap_px * scale;
            const actualGap = best.row_gap_px ?? best.child_gap_px;
            const tol = tolerances.gap_steps * oneSpacingStepPx(spec, expectedGap);
            if (actualGap === null || actualGap === undefined) {
                diffs.push({
                    region_id: r.id,
                    kind: 'gap',
                    expected: round2(expectedGap),
                    actual: null,
                    delta: null,
                    within_tolerance: false,
                });
            }
            else {
                const d = actualGap - expectedGap;
                diffs.push({
                    region_id: r.id,
                    kind: 'gap',
                    expected: round2(expectedGap),
                    actual: round2(actualGap),
                    delta: { d: round2(d), tolerance_px: round2(tol), source: best.row_gap_px !== null ? 'computed-row-gap' : 'measured-child-spacing' },
                    within_tolerance: Math.abs(d) <= tol,
                });
            }
        }
        /* ----------------------------------------------------------- font size */
        const fsSlug = r.style_refs?.font_size_slug;
        if (fsSlug) {
            const expectedPx = fontSizePxForSlug(spec, fsSlug);
            if (expectedPx === null) {
                diffs.push({
                    region_id: r.id,
                    kind: 'font_size',
                    expected: { slug: fsSlug },
                    actual: round2(best.max_font_px),
                    delta: null,
                    within_tolerance: false,
                });
            }
            else {
                const d = best.max_font_px - expectedPx;
                diffs.push({
                    region_id: r.id,
                    kind: 'font_size',
                    expected: { slug: fsSlug, px: round2(expectedPx) },
                    actual: round2(best.max_font_px),
                    delta: { d: round2(d), tolerance_px: tolerances.font_size_px },
                    within_tolerance: Math.abs(d) <= tolerances.font_size_px,
                });
            }
        }
        /* --------------------------------------------------------------- colour */
        for (const [key, slug, actualRgba] of [
            ['text', r.style_refs?.palette_slug, best.fg_rgba],
            ['background', r.style_refs?.background_palette_slug, best.bg_rgba],
        ]) {
            if (!slug)
                continue;
            const hex = paletteHexForSlug(spec, slug);
            const want = hex ? hexToRgb(hex) : null;
            if (!want || !actualRgba) {
                diffs.push({
                    region_id: r.id,
                    kind: 'color',
                    expected: { channel: key, slug, hex },
                    actual: actualRgba ? rgbaString(actualRgba) : null,
                    delta: null,
                    within_tolerance: false,
                });
                continue;
            }
            const channelDelta = Math.max(Math.abs(actualRgba[0] - want[0]), Math.abs(actualRgba[1] - want[1]), Math.abs(actualRgba[2] - want[2]));
            diffs.push({
                region_id: r.id,
                kind: 'color',
                expected: { channel: key, slug, hex },
                actual: rgbaString(actualRgba),
                delta: { max_channel: round2(channelDelta), tolerance: tolerances.color_channel },
                within_tolerance: channelDelta <= tolerances.color_channel && actualRgba[3] > 0,
            });
        }
    }
    /* ------------------------------------------------------------------ extra */
    // Only top-level structural elements count as "extra"; every nested wrapper
    // would otherwise flood the report with noise that no spec ever describes.
    const named = nodes.filter((n) => n.block_name && n.box.w > 0 && n.box.h > 0);
    const minDepth = named.reduce((m, n) => Math.min(m, n.depth), Number.POSITIVE_INFINITY);
    for (const n of named) {
        if (n.depth !== minDepth)
            continue;
        if (usedIdx.has(n.index))
            continue;
        diffs.push({
            region_id: `(unspecified)${n.selector_path}`,
            kind: 'extra',
            expected: null,
            actual: { selector_path: n.selector_path, block_name: n.block_name, box: roundBox(n.box) },
            delta: null,
            within_tolerance: false,
        });
    }
    return { diffs, pass: diffs.every((d) => d.within_tolerance), matches };
}
/* ------------------------------------------------------------------ helpers */
function rgbaString(c) {
    return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]})`;
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
function round3(n) {
    return Math.round(n * 1000) / 1000;
}
function roundBox(b) {
    return { x: round2(b.x), y: round2(b.y), w: round2(b.w), h: round2(b.h) };
}
function dedupe(list) {
    return [...new Set(list.filter((s) => typeof s === 'string' && s.length > 0))];
}
function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
import { sessionFor } from './session.js';
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
/**
 * Resolve `{markup} | {url}` into a loaded page in the warm browser.
 *
 * markup -> POST /render -> local shell (see the header comment).
 * url    -> straight navigation, credentials already on the context.
 */
export async function prepareTarget(ctx, input) {
    const hasMarkup = typeof input.markup === 'string' && input.markup.length > 0;
    const hasUrl = typeof input.url === 'string' && input.url.length > 0;
    if (hasMarkup === hasUrl) {
        throw new XError('invalid_input', 'Pass exactly one of `markup` or `url`.', 'markup is rendered through POST /render into a local shell that loads the instance stylesheets; url is navigated directly.');
    }
    const viewport = input.viewport ?? DEFAULT_VIEWPORT;
    const navTimeout = typeof input.nav_timeout_ms === 'number' && input.nav_timeout_ms > 0 ? input.nav_timeout_ms : 60_000;
    const waitUntil = input.wait ?? 'load';
    const session = await sessionFor(ctx);
    const page = await session.page({ viewport });
    if (hasUrl) {
        const res = await page.goto(input.url, { waitUntil, timeout: navTimeout }).catch((e) => {
            throw new XError('companion_unreachable', `Could not navigate to ${input.url}: ${e.message}`, 'Check the URL is reachable from this machine.');
        });
        if (!res || res.status() >= 400) {
            throw new XError('companion_error', `${input.url} returned HTTP ${res ? res.status() : 'nothing'}.`, 'Verify the page exists and the connected user may read it.', { status: res ? res.status() : 0 });
        }
        await settle(page, navTimeout);
        return {
            page,
            session,
            loaded_url: page.url(),
            source: 'url',
            viewport,
            enqueued_styles: [],
            theme_styles: { links: 0, inline: 0, harvested: false },
            release: async () => { },
        };
    }
    const rendered = await ctx.companion.render(input.markup);
    const manifest = await ctx.manifestCache.get();
    const fingerprint = manifest.fingerprint;
    // Harvest once per epoch. Done on the same warm page so no extra context is
    // created, and before the shell is served so the shell load is the last nav.
    const theme = await harvestThemeStyles(page, ctx.companion.siteUrl, fingerprint);
    const shellHtml = buildShell({
        html: rendered.html,
        styleUrls: [...theme.links, ...rendered.enqueued_styles],
        inlineStyles: theme.inline,
        bodyClass: theme.body_class,
        htmlClass: theme.html_class,
        baseHref: ctx.companion.siteUrl.replace(/\/?$/, '/'),
        title: 'x-agent verify shell',
    });
    const server = new ShellServer();
    const url = await server.start(shellHtml);
    const res = await page.goto(url, { waitUntil, timeout: navTimeout }).catch(async (e) => {
        await server.close();
        throw new XError('internal', `Could not load the local render shell: ${e.message}`, 'This is an agent-side failure; re-run with X_AGENT_DEBUG=1.');
    });
    if (!res || !res.ok()) {
        await server.close();
        throw new XError('internal', 'The local render shell did not serve.', 'This is an agent-side failure; re-run with X_AGENT_DEBUG=1.');
    }
    await settle(page);
    return {
        page,
        session,
        loaded_url: url,
        source: 'render-shell',
        viewport,
        enqueued_styles: rendered.enqueued_styles,
        theme_styles: { links: theme.links.length, inline: theme.inline.length, harvested: theme.links.length + theme.inline.length > 0 },
        release: async () => {
            await server.close();
        },
    };
}
/**
 * Every <img> on the page, wherever it hides.
 *
 * The box tree walks block-classed elements, which misses images nested in
 * composite blocks (media-text's figure) and cannot notice an image that is
 * broken, still lazy-pending, or intrinsically 1×1 (a placeholder used where
 * sized media was needed). This list is the oracle's dedicated image check:
 * `loaded:false` or a 1×1 natural size on a large rendered box are findings.
 */
export async function collectImages(page) {
    return page.evaluate(() => {
        const pathOf = (el) => {
            const parts = [];
            let cur = el;
            while (cur && cur.tagName !== 'HTML' && parts.length < 6) {
                const tag = cur.tagName.toLowerCase();
                const parent = cur.parentElement;
                let nth = 1;
                if (parent) {
                    const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
                    nth = same.indexOf(cur) + 1;
                }
                parts.unshift(`${tag}:nth-of-type(${nth})`);
                cur = parent;
            }
            return parts.join(' > ');
        };
        return Array.from(document.images).map((img) => {
            const r = img.getBoundingClientRect();
            return {
                selector_path: pathOf(img),
                box: {
                    x: Math.round(r.x * 100) / 100,
                    y: Math.round(r.y * 100) / 100,
                    w: Math.round(r.width * 100) / 100,
                    h: Math.round(r.height * 100) / 100,
                },
                natural_w: img.naturalWidth,
                natural_h: img.naturalHeight,
                loaded: img.complete && img.naturalWidth > 0,
                lazy: img.loading === 'lazy',
                src: img.currentSrc || img.src,
            };
        });
    });
}
/**
 * Force every image on the page to load before capture.
 *
 * WordPress adds loading="lazy" below the fold, and a full-page screenshot's
 * virtual scroll can outrun the lazy loader — the capture then shows empty
 * slots that a human viewing the page never sees. Flip lazy images to eager,
 * walk the scroll positions to nudge scroll-keyed loaders, and wait (bounded)
 * for every image to report complete.
 */
export async function eagerLoadImages(page, timeoutMs = 10_000) {
    await page
        .evaluate(async () => {
        document.querySelectorAll('img[loading="lazy"]').forEach((el) => {
            el.loading = 'eager';
        });
        const step = Math.max(200, window.innerHeight);
        for (let y = 0; y <= document.body.scrollHeight; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 30));
        }
        window.scrollTo(0, 0);
    })
        .catch(() => { });
    await page
        .waitForFunction(() => Array.from(document.images).every((i) => i.complete), undefined, { timeout: timeoutMs })
        .catch(() => { });
}
/** Fonts and web-font-driven reflow settle before anything is measured. */
async function settle(page, navTimeout = 60_000) {
    await page.evaluate(() => document.fonts?.ready ?? null).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: Math.min(15_000, navTimeout) }).catch(() => { });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}
//# sourceMappingURL=oracle.js.map