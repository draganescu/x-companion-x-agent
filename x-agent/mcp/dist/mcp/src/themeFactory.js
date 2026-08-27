/**
 * The theme factory — deterministic compilation of a ThemeSpec into a complete
 * block theme (specs/theme-factory.spec.json).
 *
 * The division of authorship is absolute: the model authors ONE parameter
 * object (the ThemeSpec, validated against contract/schemas/theme-spec.schema.json,
 * zod-mirrored here); every byte on disk is produced by this module's pure
 * templating. No model call ever writes a theme file, a template, or a line of
 * theme.json — a model-authored string can surface only where the ThemeSpec
 * legitimately carries it (style.css header, theme.json values), which the
 * poisoned-spec test asserts file by file.
 *
 * A sibling of factory.ts (blocks) and schemaFactory.ts (schema packages), not
 * an extension of either: the theme is a different artifact with a different
 * gate, and only the generic primitives (interpolate, zip binding) are shared.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { XError, errInvalidInput } from './errors.js';
import { interpolate, loadAdmZip } from './factory.js';
const here = path.dirname(fileURLToPath(import.meta.url));
/* ========================================================================== */
/* The contract, zod-mirrored                                                 */
/* ========================================================================== */
const SLUG_RE = /^[a-z][a-z0-9-]{1,48}$/;
const MEASURE_RE = /^[0-9]+(\.[0-9]+)?(px|ch|rem)$/;
const GAP_RE = /^[0-9]+(\.[0-9]+)?(px|rem|em)$/;
const PAD_RE = /^[0-9]+(\.[0-9]+)?(px|rem|em|vw|%)$/;
const PRESET_SLUG_RE = /^[a-z][a-z0-9-]*$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const PresetBase = { slug: z.string().regex(PRESET_SLUG_RE), name: z.string().min(1) };
export const ThemeSpecSchema = z
    .object({
    version: z.literal(1),
    identity: z
        .object({
        name: z.string().min(3),
        slug: z.string().regex(SLUG_RE),
        description: z.string().min(10),
    })
        .strict(),
    skeleton: z.enum(['stacked', 'split', 'rail']),
    measure: z
        .object({
        contentSize: z.string().regex(MEASURE_RE),
        wideSize: z.string().regex(MEASURE_RE),
    })
        .strict(),
    physics: z
        .object({
        blockGap: z.string().regex(GAP_RE),
        rootPadding: z
            .object({
            top: z.string().regex(PAD_RE),
            right: z.string().regex(PAD_RE),
            bottom: z.string().regex(PAD_RE),
            left: z.string().regex(PAD_RE),
        })
            .strict(),
    })
        .strict(),
    presets: z
        .object({
        shadows: z.array(z.object({ ...PresetBase, shadow: z.string().min(3) }).strict()).max(8),
        gradients: z.array(z.object({ ...PresetBase, gradient: z.string().min(10) }).strict()).max(8),
        duotones: z
            .array(z.object({ ...PresetBase, colors: z.array(z.string().regex(HEX_RE)).length(2) }).strict())
            .max(8),
        custom: z.record(z.string(), z.unknown()),
    })
        .strict(),
})
    .strict();
/**
 * The rail's declared width — a scaffolder constant, never the model's
 * (recorded decision: the ThemeSpec ships structure only; a width the section
 * lane must obey belongs to code). S9 audits the rendered rail against it.
 */
export const THEME_RAIL_WIDTH = '20rem';
/** Bespoke themes never shadow core's bundled namespace or the toolchain. */
const RESERVED_THEME_SLUG_RE = /^(twenty|x-companion$)/;
/* ========================================================================== */
/* Template resolution                                                        */
/* ========================================================================== */
/** `x-agent/templates/block-theme`, resolved like factory.ts templateDir(). */
export function themeTemplateDir() {
    const override = process.env.X_AGENT_THEME_TEMPLATE_DIR;
    if (override) {
        if (!fs.existsSync(path.join(override, 'style.css'))) {
            throw errInvalidInput(`X_AGENT_THEME_TEMPLATE_DIR=${override} does not contain a style.css.`, 'Point it at x-agent/templates/block-theme, or unset it.');
        }
        return override;
    }
    let dir = here;
    for (let i = 0; i < 8; i += 1) {
        const candidate = path.join(dir, 'templates', 'block-theme');
        if (fs.existsSync(path.join(candidate, 'style.css')))
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    throw new XError('internal', 'Could not locate templates/block-theme relative to the installed x-agent package.', 'Set X_AGENT_THEME_TEMPLATE_DIR to the absolute path of x-agent/templates/block-theme.');
}
/** Where theme scaffolds land when the caller does not name a directory. */
export function defaultThemeWorkspace() {
    return process.env.X_AGENT_THEME_WORKSPACE || path.join(os.tmpdir(), 'x-agent-themes');
}
/* ========================================================================== */
/* theme.json compilation                                                     */
/* ========================================================================== */
/**
 * ThemeSpec -> theme.json v3 (verified key paths; see the plan's decision 11).
 * Scaffolder constants — appearanceTools, useRootPaddingAwareAlignments and
 * fluid typography — are always on; the spec carries only what varies. Empty
 * preset groups are omitted entirely: an empty array in theme.json reads as a
 * deliberate declaration, and the theme declares nothing it does not mean.
 */
export function buildThemeJson(spec) {
    const settings = {
        appearanceTools: true,
        useRootPaddingAwareAlignments: true,
        layout: { contentSize: spec.measure.contentSize, wideSize: spec.measure.wideSize },
        spacing: { blockGap: true },
        typography: { fluid: true },
    };
    const color = {};
    if (spec.presets.gradients.length > 0) {
        color.gradients = spec.presets.gradients.map((g) => ({ slug: g.slug, name: g.name, gradient: g.gradient }));
    }
    if (spec.presets.duotones.length > 0) {
        color.duotone = spec.presets.duotones.map((d) => ({ slug: d.slug, name: d.name, colors: [...d.colors] }));
    }
    if (Object.keys(color).length > 0)
        settings.color = color;
    if (spec.presets.shadows.length > 0) {
        settings.shadow = { presets: spec.presets.shadows.map((s) => ({ slug: s.slug, name: s.name, shadow: s.shadow })) };
    }
    const custom = { ...spec.presets.custom };
    if (spec.skeleton === 'rail')
        custom.railWidth = THEME_RAIL_WIDTH;
    if (Object.keys(custom).length > 0)
        settings.custom = custom;
    const templateParts = [
        { name: 'header', title: 'Header', area: 'header' },
        { name: 'footer', title: 'Footer', area: 'footer' },
    ];
    if (spec.skeleton === 'rail')
        templateParts.push({ name: 'rail', title: 'Rail', area: 'rail' });
    return {
        $schema: 'https://schemas.wp.org/trunk/theme.json',
        version: 3,
        settings,
        styles: {
            spacing: {
                blockGap: spec.physics.blockGap,
                padding: { ...spec.physics.rootPadding },
            },
        },
        customTemplates: [
            { name: 'page-no-title', title: 'Page (No Title)', postTypes: ['page'] },
            { name: 'canvas', title: 'Canvas', postTypes: ['page'] },
        ],
        templateParts,
    };
}
const ROSTER_TEMPLATES = ['index.html', 'page.html', 'page-no-title.html', 'canvas.html'];
export function scaffoldTheme(input, opts = {}) {
    const spec = ThemeSpecSchema.parse(input);
    if (RESERVED_THEME_SLUG_RE.test(spec.identity.slug)) {
        throw errInvalidInput(`Theme slug "${spec.identity.slug}" is reserved.`, "Bespoke themes never shadow core's twenty* namespace or the companion.");
    }
    const src = themeTemplateDir();
    const target = path.join(path.resolve(opts.dir ?? defaultThemeWorkspace()), spec.identity.slug);
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0 && opts.force !== true) {
        throw errInvalidInput(`Target directory ${target} exists and is not empty.`, 'Pass force: true to overwrite it.');
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.join(target, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(target, 'parts'), { recursive: true });
    const written = [];
    const write = (rel, content) => {
        fs.writeFileSync(path.join(target, rel), content);
        written.push(rel);
    };
    const copyStatic = (fromRel, toRel) => {
        write(toRel, fs.readFileSync(path.join(src, fromRel), 'utf8'));
    };
    write('style.css', interpolate(fs.readFileSync(path.join(src, 'style.css'), 'utf8'), {
        name: spec.identity.name,
        slug: spec.identity.slug,
        description: spec.identity.description,
    }));
    write('theme.json', `${JSON.stringify(buildThemeJson(spec), null, '\t')}\n`);
    // Templates are STATIC per skeleton: rail swaps in its two-column variants,
    // stacked and split share the plain set (split's panes are assembled in
    // content by S8 — the template is not where a pane lives).
    for (const name of ROSTER_TEMPLATES) {
        const railVariant = path.join('templates', 'rail', name);
        const useRail = spec.skeleton === 'rail' && fs.existsSync(path.join(src, railVariant));
        copyStatic(useRail ? railVariant : path.join('templates', name), path.join('templates', name));
    }
    copyStatic(path.join('parts', 'header.html'), path.join('parts', 'header.html'));
    copyStatic(path.join('parts', 'footer.html'), path.join('parts', 'footer.html'));
    if (spec.skeleton === 'rail') {
        copyStatic(path.join('parts', 'rail.html'), path.join('parts', 'rail.html'));
        write('functions.php', interpolate(fs.readFileSync(path.join(src, 'functions-rail.php'), 'utf8'), {
            textdomain: spec.identity.slug,
        }));
    }
    const result = {
        dir: target,
        slug: spec.identity.slug,
        name: spec.identity.name,
        files: written.sort(),
    };
    if (spec.skeleton === 'rail')
        result.rail_width = THEME_RAIL_WIDTH;
    return result;
}
/* ========================================================================== */
/* Packaging + inspection (the install policy, asserted locally before the    */
/* wire — the companion re-checks server-side)                                */
/* ========================================================================== */
export const MAX_THEME_PACKAGE_BYTES = 5 * 1024 * 1024;
/** Deterministic zip: sorted walk, one top-level directory named after the slug. */
export function packageTheme(themeDir, zipPath) {
    const root = path.basename(themeDir);
    const Zip = loadAdmZip();
    const zip = new Zip();
    const files = [];
    const walk = (rel) => {
        for (const entry of fs.readdirSync(path.join(themeDir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory())
                walk(relPath);
            else
                files.push(relPath);
        }
    };
    walk('');
    for (const rel of files) {
        zip.addFile(`${root}/${rel}`, fs.readFileSync(path.join(themeDir, rel)));
    }
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    zip.writeZip(zipPath);
    return zipPath;
}
export function inspectThemePackage(zipPath) {
    const reasons = [];
    const stat = fs.statSync(zipPath);
    if (stat.size > MAX_THEME_PACKAGE_BYTES) {
        reasons.push(`package is ${stat.size} bytes; the cap is ${MAX_THEME_PACKAGE_BYTES}`);
    }
    const Zip = loadAdmZip();
    const zip = new Zip(zipPath);
    const entries = zip.getEntries();
    const roots = new Set();
    for (const entry of entries) {
        const name = entry.entryName;
        if (name.includes('..') || name.startsWith('/') || name.includes('\\') || name.includes(' ')) {
            reasons.push(`unsafe entry path: ${name}`);
            continue;
        }
        roots.add(name.split('/')[0] ?? '');
    }
    if (roots.size !== 1) {
        reasons.push(`expected exactly one top-level directory, found ${roots.size === 0 ? 'none' : [...roots].join(', ')}`);
        return { ok: false, reasons };
    }
    const root = [...roots][0] ?? '';
    if (!SLUG_RE.test(root))
        reasons.push(`top-level directory "${root}" is not a valid theme slug`);
    const has = (rel) => entries.some((e) => e.entryName === `${root}/${rel}` && !e.isDirectory);
    if (!has('style.css')) {
        reasons.push('style.css missing');
    }
    else {
        const css = zip.getEntries().find((e) => e.entryName === `${root}/style.css`)?.getData().toString('utf8') ?? '';
        if (!/^\s*Theme Name\s*:\s*\S/m.test(css))
            reasons.push('style.css carries no Theme Name header');
    }
    if (!has('templates/index.html'))
        reasons.push('templates/index.html missing — not an installable block theme');
    if (has('theme.json')) {
        const raw = zip.getEntries().find((e) => e.entryName === `${root}/theme.json`)?.getData().toString('utf8') ?? '';
        try {
            JSON.parse(raw);
        }
        catch (e) {
            reasons.push(`theme.json does not parse: ${e.message}`);
        }
    }
    const report = { ok: reasons.length === 0, reasons };
    if (reasons.length === 0)
        report.slug = root;
    return report;
}
//# sourceMappingURL=themeFactory.js.map