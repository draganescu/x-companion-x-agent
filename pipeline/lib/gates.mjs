// Mechanical gate screening shared by S4/S5/S6/S7/S8. The gates themselves are
// the toolchain's (wp_validate, wp_block_build_test, wp_schema_build_test);
// this module only encodes the spec's mechanical review of their output —
// which warnings fail an artifact, which diagnostics may be deferred.

const WARNING_FAILS = new Set(['W_ATTR_UNKNOWN', 'W_STYLE_UNKNOWN']);

// E_UNKNOWN_BLOCK for a brief-declared agent/<slug> block is DEFERRED, not
// failed: the block is fabricated in S5 and installed in S8, and the deferral
// is re-checked at the final epoch with an empty allow-set.
export function screenTreeDiagnostics(result, { allowedUnknown = new Set() } = {}) {
    const failures = [];
    const deferred = [];
    for (const d of result.diagnostics ?? []) {
        if (d.severity === 'error') {
            if (d.code === 'E_UNKNOWN_BLOCK') {
                const name = (d.message.match(/[a-z0-9-]+\/[a-z0-9-]+/) ?? [])[0];
                if (name && allowedUnknown.has(name)) {
                    deferred.push(name);
                    continue;
                }
            }
            failures.push({ code: d.code, path: d.path, message: d.message });
        } else if (WARNING_FAILS.has(d.code)) {
            failures.push({ code: d.code, path: d.path, message: d.message });
        }
        // W_STATIC_NEEDS_HARNESS, W_HINT_ALLOWED_BLOCKS, W_HINT_TEMPLATE_LOCK pass.
    }
    return { status: failures.length === 0 ? 'pass' : 'fail', deferred, failures };
}

// Local pre-check for LLM tree output: catches shape violations on the
// schema-retry lane before a wp_validate round trip. R1: markup (innerHTML /
// innerContent) inside a tree is compiler output appearing in an input.
export function localTreeCheck(tree, { epoch }) {
    const issues = [];
    if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
        return [{ path: '', message: 'expected a TreeIR object {version, epoch, blocks}' }];
    }
    if (tree.version !== 1) issues.push({ path: '/version', message: 'version must be the literal number 1' });
    if (tree.epoch !== epoch) issues.push({ path: '/epoch', message: `epoch must be the current fingerprint "${epoch}"` });
    if (!Array.isArray(tree.blocks) || tree.blocks.length === 0) {
        issues.push({ path: '/blocks', message: 'blocks must be a non-empty array of BlockNode' });
        return issues;
    }
    const walk = (node, path) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            issues.push({ path, message: 'BlockNode must be an object' });
            return;
        }
        if (typeof node.name !== 'string' || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(node.name)) {
            issues.push({ path: `${path}/name`, message: 'name must match ^[a-z0-9-]+/[a-z0-9-]+$' });
        }
        for (const forbidden of ['innerHTML', 'innerContent']) {
            if (forbidden in node) {
                issues.push({ path: `${path}/${forbidden}`, message: `${forbidden} is compiler output and never appears in a tree (R1)` });
            }
        }
        for (const key of Object.keys(node)) {
            if (!['name', 'attributes', 'innerBlocks'].includes(key)) {
                issues.push({ path: `${path}/${key}`, message: 'a BlockNode is {name, attributes?, innerBlocks?} — nothing else' });
            }
        }
        (node.innerBlocks ?? []).forEach((child, i) => walk(child, `${path}/innerBlocks/${i}`));
    };
    tree.blocks.forEach((node, i) => walk(node, `/blocks/${i}`));
    return issues;
}

// S4/S7: the Layout Cascade, mechanized at the band root. WordPress clamps
// every child of a constrained layout to the theme's contentSize via
// `.is-layout-constrained > *:not(.alignwide):not(.alignfull)` — a selector no
// custom CSS outranks, so width lives in the tree's attributes, never in a
// stylesheet. The recurring failure is a band meant to span the viewport
// shipping clamped in the narrow content column (a real header once rendered
// at 645px of a 1440px viewport). The root contract is checkable: ONE
// core/group, align "full", and a declared inner layout — "constrained" for
// centered inner content, "default" for edge-to-edge.
export function screenBandRoot(tree) {
    const blocks = tree?.blocks ?? [];
    if (blocks.length !== 1) {
        return [{ code: 'band_root', path: '/blocks', message: `a band tree is exactly ONE root core/group (got ${blocks.length} roots)` }];
    }
    const failures = [];
    const root = blocks[0];
    if (root?.name !== 'core/group') {
        failures.push({ code: 'band_root', path: '/blocks/0/name', message: `the root band is a core/group (got ${root?.name ?? 'nothing'})` });
    }
    if (root?.attributes?.align !== 'full') {
        failures.push({ code: 'band_root', path: '/blocks/0/attributes/align', message: 'the root band carries align "full" — without it the constrained root layout clamps the band to contentSize and it ships as a narrow strip in the content column (width is fixed here, never in CSS)' });
    }
    const layoutType = root?.attributes?.layout?.type;
    if (layoutType !== 'constrained' && layoutType !== 'default') {
        failures.push({ code: 'band_root', path: '/blocks/0/attributes/layout', message: 'the root band declares its inner layout: {"type": "constrained"} for centered inner content, {"type": "default"} for edge-to-edge' });
    }
    return failures;
}

// S5's file-map contract: {"files": {name: content}} with names from the
// allowed set only — nothing escapes the scaffold directory. PHP contents get
// a mechanical screen for the one mistake that poisons a whole site: a
// file-level `use` of a non-compound (global) class name raises a PHP warning
// on EVERY request, and with display_errors on it prefixes every REST response.
const NON_COMPOUND_USE = /^[ \t]*use[ \t]+\\?[A-Za-z_][A-Za-z0-9_]*[ \t]*;/m;

export function screenFileMap(value, { allowed }) {
    const issues = [];
    if (!value || typeof value !== 'object' || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
        return [{ path: '', message: 'expected {"files": {"<name>": "<content>", ...}}' }];
    }
    const names = Object.keys(value.files);
    if (names.length === 0) issues.push({ path: '/files', message: 'files map is empty' });
    for (const name of names) {
        if (name.includes('/') || name.includes('..')) {
            issues.push({ path: `/files/${name}`, message: 'file names must be scaffold-root basenames' });
        } else if (!allowed.has(name)) {
            issues.push({ path: `/files/${name}`, message: `"${name}" is not one of the writable scaffold files (${[...allowed].join(', ')})` });
        }
        if (typeof value.files[name] !== 'string') {
            issues.push({ path: `/files/${name}`, message: 'file content must be a string' });
        } else if (name.endsWith('.php') && NON_COMPOUND_USE.test(value.files[name])) {
            issues.push({ path: `/files/${name}`, message: 'file-level `use` of a non-compound class name (e.g. `use WP_REST_Server;`) raises a PHP warning on every request — reference global classes directly (`\\WP_REST_Server` or just the bare name)' });
        }
    }
    return issues;
}

// S5/S7: the inheritance screen for block stylesheets. A block does not own a
// colour scheme: its text INHERITS the band's ink, which the placing markup
// already guaranteed readable, and a surface treatment belongs on the block
// instance's colour supports, set by the markup that places it. The one
// mechanically certain violation is the wholesale repaint — a bare root-class
// selector setting `color` or `background` in style.css. That single
// declaration is what shipped three blocks invisible on a dark-base site: the
// stylesheet chose slugs by NAME (ink, paper) on a palette whose "ink" shared
// its hex with the very band the blocks landed on. Element-level colour
// moments (a meter fill, a status dot) stay legal here — S9's measured ink
// audit is their judge.
export function screenBlockCss(value) {
    const issues = [];
    for (const [name, content] of Object.entries(value?.files ?? {})) {
        if (!name.endsWith('.css') || typeof content !== 'string') continue;
        const css = content.replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            const body = m[2];
            const paintsText = /(?<![-\w])color\s*:/.test(body);
            const paintsGround = /(?<![-\w])background(?:-color)?\s*:/.test(body);
            if (!paintsText && !paintsGround) continue;
            const root = m[1].split(',').map((s) => s.trim()).find((s) => /^\.[a-z0-9-]+$/.test(s));
            if (root) {
                issues.push({ path: `/files/${name}`, message: `"${root}" paints the block root (${paintsText ? 'color' : 'background'}) — a block does not own a colour scheme: text inherits the band's ink, and a surface belongs on the block instance's colour supports, set by the markup that places it. Delete the declaration; style.css owns structure.` });
            }
        }
    }
    return issues;
}

// wp_block_build_test reports gate failure as a SUCCESS result ({built:false,
// failure}) — and a thrown build_failed envelope is also a gate failure.
//
// Button anatomy, for when a factory stylesheet ever styles buttons: the
// button block renders TWO nested elements, and core puts the padding,
// background, border, and radius on the INNER `.wp-element-button`
// (`.wp-block-button__link`) — while a custom className lands on the OUTER
// `.wp-block-button` wrapper. A rule on the wrapper therefore stacks a second
// padded box on core's (the button doubles in size), and a wrapper :hover adds
// a second, conflicting hover. Style `.your-class .wp-element-button`, with
// exactly one hover rule, on the inner element.
export function blockGate(callResult) {
    const failures = [];
    if (!callResult.ok) {
        return { status: 'fail', failures: [{ code: callResult.data.code ?? 'build_failed', message: callResult.data.message, hint: callResult.data.hint ?? '' }] };
    }
    const data = callResult.data;
    if (data.built !== true || data.failure || !data.zip_path) {
        failures.push({ code: data.failure?.code ?? 'build_failed', message: data.failure?.message ?? 'built:false or no zip produced', hint: data.failure?.hint ?? '' });
    }
    const front = data.smoke?.front;
    if (front) {
        if ((front.console_errors ?? []).length > 0) {
            failures.push({ code: 'smoke_failed', message: `front smoke console errors: ${front.console_errors.join(' | ')}` });
        }
        if (front.block_present === false) {
            failures.push({ code: 'smoke_failed', message: 'front smoke: block not present on the rendered page' });
        }
    }
    const warnings = [];
    for (const w of data.style_warnings ?? []) {
        // R11 is hard only where a preset actually exists to spend through. A
        // literal the token system cannot express is a layout mechanic, and
        // failing it makes the gate unsatisfiable — see styleLiteralSeverity.
        const entry = { code: 'style_literal', message: `style.css line ${w.line}: literal ${w.literal} (${w.text})` };
        if (styleLiteralSeverity(w) === 'fail') {
            failures.push({ ...entry, message: `${entry.message} — spend it via var(--wp--preset--*)` });
        } else {
            warnings.push(entry);
        }
    }
    return { status: failures.length === 0 ? 'pass' : 'fail', failures, warnings };
}

// Which style literals the token system can actually express.
//
// FAIL: hex colours, and px/rem on font-size or spacing — presets exist for all
//   three (--wp--preset--color--*, --font-size--*, --spacing--*), so a literal
//   there is a real bypass of the design system.
// WARN: everything else. Not laxness — these have no preset to spend through:
//   letter-spacing, border-radius, hairline borders, outline offsets, sr-only
//   sizes. And a media query condition cannot contain var() at all; CSS forbids
//   it, so failing one makes any responsive block impossible to ship.
//   `em` is always advisory: it is relative to its own context, which is a
//   mechanic, where every preset is an absolute step on a scale.
export function styleLiteralSeverity(w) {
    const text = String(w.text ?? '');
    const literal = String(w.literal ?? '');
    if (literal.startsWith('#')) return 'fail';
    if (/^\s*@media/.test(text)) return 'warn';
    if (/(?<!r)em$/.test(literal)) return 'warn'; // em, but never rem
    const prop = (text.split(':')[0] ?? '').trim().toLowerCase();
    if (prop === 'font-size') return 'fail';
    if (/^(margin|padding)(-|$)/.test(prop) || /^(row-|column-)?gap$/.test(prop)) return 'fail';
    return 'warn';
}

// wp_schema_build_test THROWS on gate failure (arrives as an isError envelope);
// the success path still requires built + uninstall_clean + zip.
export function schemaGate(callResult) {
    if (!callResult.ok) {
        const d = callResult.data;
        return { status: 'fail', failures: [{ code: d.code ?? 'smoke_failed', message: d.message, hint: d.hint ?? '', smoke: d.smoke, build_log: d.build_log }] };
    }
    const data = callResult.data;
    const failures = [];
    if (data.built !== true || !data.zip_path) failures.push({ code: 'build_failed', message: 'built:false or no zip produced' });
    if (data.smoke?.uninstall_clean !== true) failures.push({ code: 'smoke_failed', message: 'uninstall left registrations behind (uninstall_clean !== true)' });
    return { status: failures.length === 0 ? 'pass' : 'fail', failures };
}

// S9: the sane-heading-outline screen — exactly one h1, no level jumps.
export function screenOutline(outline) {
    const failures = [];
    const headings = (outline ?? []).filter((n) => n.role === 'heading' && typeof n.level === 'number');
    const h1s = headings.filter((h) => h.level === 1);
    if (h1s.length !== 1) {
        failures.push({ code: 'outline', message: `expected exactly one h1, got ${h1s.length} (${h1s.map((h) => h.name).join(' | ')})` });
    }
    let prev = 0;
    for (const h of headings) {
        if (h.level > prev + 1) {
            failures.push({ code: 'outline', message: `heading level jump: h${prev || 1} -> h${h.level} at "${h.name}"` });
        }
        prev = h.level;
    }
    return failures;
}

// S9: the measured width audit — the Layout Cascade checked in the rendered
// DOM, where S4's markup-level screen cannot see. Whatever the trees declared,
// a band that ships clamped to contentSize MEASURES narrow, so band roots are
// found structurally — both template parts, plus every direct child group of
// post-content — and each must span the viewport (the slack covers scrollbar
// and rounding). The two parts must also agree with each other: a 645px header
// over a full-bleed footer is the exact field bug this audit exists to catch.
// (The vertical seams between these same nodes are different territory: core
// injects a default --wp--style--block-gap margin between the template's
// top-level children even when no theme declares it — that rhythm belongs to
// the bands' own padding and is not audited here.)
const CLAMP_SLACK = 48;

// The page's top-level structures, found in the measured box tree: both
// template parts, plus every direct child group of post-content (the band
// roots). Shared by the width and seam audits.
function bandStructures(boxTree) {
    const nodes = boxTree ?? [];
    const last = (n) => n.selector_path.split(' > ').pop() ?? '';
    const parts = nodes.filter((n) => n.block_name === 'core/template-part' || last(n).includes('.wp-block-template-part'));
    const postContent = nodes.find((n) => n.block_name === 'core/post-content' || last(n).includes('.wp-block-post-content'));
    const bands = postContent
        ? nodes.filter((n) => {
            if (!(n.block_name === 'core/group' || last(n).includes('.wp-block-group'))) return false;
            const prefix = `${postContent.selector_path} > `;
            return n.selector_path.startsWith(prefix) && !n.selector_path.slice(prefix.length).includes(' > ');
        })
        : [];
    return { parts, bands, last };
}

export function screenBandWidths(boxTree, { viewportWidth } = {}) {
    const { parts, bands, last } = bandStructures(boxTree);
    const failures = [];
    if (typeof viewportWidth === 'number' && viewportWidth > 0) {
        for (const n of [...parts, ...bands]) {
            if (n.box.w < viewportWidth - CLAMP_SLACK) {
                failures.push({ code: 'band_width', message: `band clamped to the content column: ${n.selector_path} spans ${Math.round(n.box.w)}px of a ${viewportWidth}px viewport — the root band is missing align "full" (or fighting the constrained-layout clamp with CSS, which loses)` });
            }
        }
    }
    if (parts.length >= 2) {
        const widths = parts.map((n) => n.box.w);
        if (Math.max(...widths) - Math.min(...widths) > 8) {
            failures.push({ code: 'band_width', message: `the template parts disagree on width (${parts.map((n) => `${last(n)}=${Math.round(n.box.w)}px`).join(', ')}) — header and footer bookend the same design and must span the same row` });
        }
    }
    return failures;
}

// S9: the seam audit — bands butt flush. Core injects a default
// --wp--style--block-gap margin between top-level blocks even on a theme that
// declares no blockGap (measured: 19px of page background between every band
// of a real build); S3 resets it in one deliberate stroke, and this audit
// keeps it dead. Any daylight between consecutive bands, or between a band
// and a template part, is the page background leaking through — deliberate
// space between bands is the bands' own padding, which is inside the band and
// leaves no seam. Skipped when no band was measured: template parts alone are
// not adjacent to each other.
const SEAM_TOLERANCE = 4;

export function screenBandSeams(boxTree) {
    const { parts, bands } = bandStructures(boxTree);
    if (bands.length === 0) return [];
    const rows = [...parts, ...bands].sort((a, b) => a.box.y - b.box.y);
    const failures = [];
    for (let i = 1; i < rows.length; i += 1) {
        const prev = rows[i - 1];
        const next = rows[i];
        const gap = next.box.y - (prev.box.y + prev.box.h);
        if (gap > SEAM_TOLERANCE) {
            failures.push({ code: 'band_seam', message: `${Math.round(gap)}px of page background between bands (${prev.selector_path} -> ${next.selector_path}) — the block-gap seam is back; bands butt flush and carry their spacing as their own padding` });
        }
    }
    return failures;
}

// S9: the measured ink audit. The oracle rates every element carrying its own
// text against the nearest painted ancestor ground and reports pairs under
// 4.5:1; this screen fails the unreadable class — under 3:1, below even the
// large-text floor — and S9 logs the 3–4.5 band as advisory. This is the one
// place invisible text is ALWAYS caught regardless of which layer produced it
// (block stylesheet, tree attribute, theme wiring), because the block
// factory's own gate smokes on a throwaway default theme where the site
// palette does not even exist.
const INK_FLOOR = 3;

export function screenTextContrast(findings) {
    return (findings ?? [])
        .filter((f) => f.ratio < INK_FLOOR)
        .map((f) => ({ code: 'ink_contrast', message: `unreadable text (${f.ratio}:1, ${f.color} on ${f.background}): "${f.sample}" at ${f.selector_path}` }));
}

// S4/S7: image-intent geometry. The placeholder minted for an intent is a 1×1
// pixel; sizeSlug does nothing for an attachment with no real sizes, so an
// image node that brings no geometry of its own renders at literally one
// pixel. Geometry is the tree's job — width plus aspectRatio make the slot
// hold while the pixels stay provisional.
export function screenImageGeometry(tree) {
    const failures = [];
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        if (node.name === 'core/image' && node.attributes?.metadata?.imageIntent) {
            for (const attr of ['width', 'aspectRatio']) {
                if (!node.attributes[attr]) {
                    failures.push({ code: 'image_geometry', path: `${path}/attributes/${attr}`, message: `image-intent node missing ${attr} — the placeholder behind it is a 1×1 pixel, so the node must carry its own geometry (width, usually "100%", plus an aspectRatio)` });
                }
            }
        }
        (node.innerBlocks ?? []).forEach((child, i) => walk(child, `${path}/innerBlocks/${i}`));
    };
    (tree?.blocks ?? []).forEach((node, i) => walk(node, `/blocks/${i}`));
    return failures;
}

// The literal screen (S4, S7). Below the token system, an artifact carries slugs
// and copy — never a design value. A molecule that hardcodes #b8143c or 3rem
// defeats the token system it exists to express, and it does it silently: the
// page looks right on the day it is built and stops tracking the palette the
// moment anyone edits one.
//
// Calibrated like styleLiteralSeverity above: hard ONLY where a preset exists
// to spend through.
// FAIL: a hex colour anywhere in a tree's attributes; an absolute length under
//   style.spacing (padding/margin/blockGap — spacing presets exist) or as a
//   fontSize under style (fontSize presets exist).
// PASS: every other property under `style`. Not laxness — letterSpacing,
//   border widths and radii, line heights have NO preset category to spend
//   through, and the tree prompt's own editorial details (letterspaced
//   kickers, hairline borders) are only expressible as literals. `em` never
//   fails: it is relative to its own context — a mechanic, where every preset
//   is an absolute step on a scale. `%` passes (layout mechanic, no preset),
//   as do preset references in either spelling (var:preset|… and
//   var(--wp--preset--…)) and anything outside `style` that carries digits.
const HEX_LITERAL = /#[0-9a-f]{3}(?:[0-9a-f]{3}(?:[0-9a-f]{2})?)?\b/i;
const ABS_LENGTH = /(?:^|[\s(,])-?\d*\.?\d+(px|rem|em|pt)\b/i;
const PRESET_REF = /var:preset\||var\(\s*--wp--preset--/;

export function screenTreeLiterals(tree) {
    const failures = [];
    const scan = (value, path, key, inStyle, inSpacing) => {
        if (typeof value === 'string') {
            if (PRESET_REF.test(value)) return;
            if (HEX_LITERAL.test(value)) {
                failures.push({ code: 'literal_value', path, message: `hex colour literal "${value}" — spend the palette slug instead` });
                return;
            }
            const m = inStyle ? value.match(ABS_LENGTH) : null;
            if (!m) return;
            if (m[1].toLowerCase() === 'em') return; // relative to its own context — a mechanic, not a design value
            if (inSpacing) {
                failures.push({ code: 'literal_value', path, message: `absolute length "${value}" under style.spacing — spend a spacing preset (var:preset|spacing|NN)` });
            } else if (key === 'fontSize') {
                failures.push({ code: 'literal_value', path, message: `absolute length "${value}" as a font size — use the fontSize slug attribute or a font-size preset` });
            }
            // Anything else under style (letterSpacing, border widths, radii…)
            // has no preset to spend through — allowed.
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((v, i) => scan(v, `${path}/${i}`, key, inStyle, inSpacing));
            return;
        }
        if (value && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) {
                scan(v, `${path}/${k}`, k, inStyle || k === 'style', inSpacing || (inStyle && k === 'spacing'));
            }
        }
    };
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        if (node.attributes) scan(node.attributes, `${path}/attributes`, null, false, false);
        (node.innerBlocks ?? []).forEach((child, i) => walk(child, `${path}/innerBlocks/${i}`));
    };
    (tree?.blocks ?? []).forEach((node, i) => walk(node, `/blocks/${i}`));
    return failures;
}
