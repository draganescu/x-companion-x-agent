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

// wp_block_build_test reports gate failure as a SUCCESS result ({built:false,
// failure}) — and a thrown build_failed envelope is also a gate failure.
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

// The literal screen (S3b, S4). Below the design kit, an artifact carries slugs
// and copy — never a design value. A molecule that hardcodes #b8143c or 3rem
// defeats the token system it exists to express, and it does it silently: the
// page looks right on the day it is built and stops tracking the palette the
// moment anyone edits one.
//
// FAIL: a hex colour anywhere in a tree's attributes; an absolute length
//   (px/rem/em/pt) anywhere under a `style` subtree, where a preset always
//   exists to spend through.
// PASS: `%` (column widths are a layout mechanic with no preset), preset
//   references in either spelling (var:preset|… and var(--wp--preset--…)),
//   and anything outside `style` that merely contains digits.
const HEX_LITERAL = /#[0-9a-f]{3}(?:[0-9a-f]{3}(?:[0-9a-f]{2})?)?\b/i;
const ABS_LENGTH = /(?:^|[\s(,])-?\d*\.?\d+(px|rem|em|pt)\b/i;
const PRESET_REF = /var:preset\||var\(\s*--wp--preset--/;

export function screenTreeLiterals(tree) {
    const failures = [];
    const scan = (value, path, inStyle) => {
        if (typeof value === 'string') {
            if (PRESET_REF.test(value)) return;
            if (HEX_LITERAL.test(value)) {
                failures.push({ code: 'literal_value', path, message: `hex colour literal "${value}" — spend the palette slug instead` });
            } else if (inStyle && ABS_LENGTH.test(value)) {
                failures.push({ code: 'literal_value', path, message: `absolute length "${value}" under style — spend a preset (var:preset|spacing|NN, or the fontSize slug attribute)` });
            }
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((v, i) => scan(v, `${path}/${i}`, inStyle));
            return;
        }
        if (value && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) scan(v, `${path}/${k}`, inStyle || k === 'style');
        }
    };
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        if (node.attributes) scan(node.attributes, `${path}/attributes`, false);
        (node.innerBlocks ?? []).forEach((child, i) => walk(child, `${path}/innerBlocks/${i}`));
    };
    (tree?.blocks ?? []).forEach((node, i) => walk(node, `/blocks/${i}`));
    return failures;
}
