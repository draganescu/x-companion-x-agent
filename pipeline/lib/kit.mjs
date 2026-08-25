// The design kit: one master call, two artifacts.
//
// kit.json is a STRICT DesignSpecIR — contract/schemas/design-spec.schema.json,
// additionalProperties:false at its root — with source.kind "synthesized". It is
// gated by wp_spec_validate unmodified, exactly the call from-design mode makes.
// molecules.json is the reusable-arrangement inventory, which cannot live inside
// the spec for that same additionalProperties reason and is checked here.
//
// Everything below the kit instantiates; nothing below it designs.
import { readFileSync } from 'node:fs';
import { validateSchema } from './schema.mjs';
import { contrastRatio } from './tokens.mjs';

const contractUrl = (name) => new URL(`../../contract/schemas/${name}`, import.meta.url);

const designTokensSchema = JSON.parse(readFileSync(contractUrl('design-tokens.schema.json'), 'utf8'));
const rawSpecSchema = JSON.parse(readFileSync(contractUrl('design-spec.schema.json'), 'utf8'));
export const moleculesSchema = JSON.parse(readFileSync(new URL('../schemas/molecules.schema.json', import.meta.url), 'utf8'));

// The subset validator (house rule: no ajv) does not resolve $ref, and the spec
// contract carries five: four into design-tokens, one self-recursive Region.
// Inline the cross-schema four and cap the recursion at a depth real specs use;
// wp_spec_validate is the real gate, this is the pre-call screen.
function resolveRefs(node, depth = 0) {
    if (Array.isArray(node)) return node.map((n) => resolveRefs(n, depth));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string') {
        const m = node.$ref.match(/^x-contract\/design-tokens\.schema\.json#\/properties\/([a-z]+)$/);
        if (m) return resolveRefs(designTokensSchema.properties[m[1]], depth);
        if (node.$ref === '#/definitions/Region') {
            if (depth >= 4) return {}; // deep enough; the server gate walks the rest
            return resolveRefs(rawSpecSchema.definitions.Region, depth + 1);
        }
        return {};
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (k === 'definitions') continue;
        out[k] = resolveRefs(v, depth);
    }
    return out;
}

export const specSchema = resolveRefs(rawSpecSchema);

/** Every region in the tree, flattened, with its parent for containment checks. */
export function flattenRegions(regions, parent = null, out = []) {
    for (const r of regions ?? []) {
        out.push({ region: r, parent });
        flattenRegions(r.children, r, out);
    }
    return out;
}

const CONCRETE_POINTERS = (tc) => [
    ...(tc.palette ?? []).map((p) => p.color),
    ...((tc.spacing ?? {}).steps ?? []).map((s) => s.size),
    ...((tc.typography ?? {}).sizes ?? []).map((s) => s.size),
    (tc.layout ?? {}).contentSize,
    (tc.layout ?? {}).wideSize,
].filter((v) => typeof v === 'string' && v.length > 0);

/**
 * The pre-call screen for the kit envelope {spec, molecules}. It mirrors what
 * wp_spec_validate will say a moment later — schema, box containment, orphan
 * content, quantization — so a contract miss costs a metered schema-retry
 * rather than a round trip and a dead stage.
 */
export function kitChecks(value, { briefPalette = [], sectionRoles = [] } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return [{ path: '', message: 'expected {"spec": DesignSpecIR, "molecules": [...]}' }];
    }
    const issues = [];
    const spec = value.spec;
    if (!spec || typeof spec !== 'object') {
        return [{ path: '/spec', message: 'spec must be a DesignSpecIR object' }];
    }
    for (const key of Object.keys(value)) {
        if (!['spec', 'molecules'].includes(key)) {
            issues.push({ path: `/${key}`, message: 'the envelope is {spec, molecules} — nothing else' });
        }
    }
    issues.push(...validateSchema(specSchema, spec, '/spec'));
    issues.push(...validateSchema(moleculesSchema, { molecules: value.molecules }, '').map((i) => ({
        ...i, path: i.path.replace(/^\/molecules/, '/molecules'),
    })));
    if (issues.length > 0) return issues; // shape first; the checks below assume it

    if (spec.source?.kind !== 'synthesized') {
        issues.push({ path: '/spec/source/kind', message: 'a kit is inferred, not measured: kind must be "synthesized"' });
    }

    // E_BOX_OVERLAP, locally: a child box must sit inside its parent's, 2% slack.
    for (const { region, parent } of flattenRegions(spec.regions)) {
        if (!parent) continue;
        const slackX = parent.box.w * 0.02;
        const slackY = parent.box.h * 0.02;
        const outside = region.box.x < parent.box.x - slackX
            || region.box.y < parent.box.y - slackY
            || region.box.x + region.box.w > parent.box.x + parent.box.w + slackX
            || region.box.y + region.box.h > parent.box.y + parent.box.h + slackY;
        if (outside) {
            issues.push({
                path: `/spec/regions (${region.id})`,
                message: `box ${JSON.stringify(region.box)} escapes parent "${parent.id}" ${JSON.stringify(parent.box)} — a child region lives inside its parent`,
            });
        }
    }

    // E_ORPHAN_CONTENT, locally.
    const regionIds = new Set(flattenRegions(spec.regions).map((f) => f.region.id));
    for (const c of spec.content ?? []) {
        if (!regionIds.has(c.region_id)) {
            issues.push({ path: `/spec/content (${c.id})`, message: `region_id "${c.region_id}" is not a region in this spec` });
        }
    }
    if ((spec.content ?? []).filter((c) => typeof c.text === 'string' && c.text.trim().length > 3).length === 0) {
        issues.push({
            path: '/spec/content',
            message: 'the kit must carry real copy: the verifier matches regions on text as well as geometry, and a contentless kit can only be matched by its guessed boxes',
        });
    }

    // W_UNQUANTIZED, promoted to a failure: in a synthesized kit an unlogged
    // value is a value nobody decided.
    const logged = new Set((spec.tokens_candidates?.quantization_log ?? []).map((q) => q.snapped_to));
    for (const v of CONCRETE_POINTERS(spec.tokens_candidates ?? {})) {
        if (!logged.has(v)) {
            issues.push({
                path: '/spec/tokens_candidates/quantization_log',
                message: `no entry whose snapped_to is exactly "${v}" — every concrete value needs one, with a note saying why that value and not its neighbour`,
            });
        }
    }

    // W_NO_RESPONSIVE, promoted: a kit that says nothing about narrow screens
    // has silently decided something about them.
    for (const r of spec.regions ?? []) {
        if ((r.responsive_assumptions ?? []).length === 0) {
            issues.push({
                path: `/spec/regions (${r.id})`,
                message: 'a top-level region needs at least one responsive_assumption with confidence "synthesized"',
            });
        }
    }

    // The brief's palette is the client's, not the designer's to drop.
    const declared = (spec.tokens_candidates?.palette ?? []).map((p) => String(p.color).toLowerCase());
    for (const p of briefPalette) {
        if (!declared.includes(String(p.color).toLowerCase())) {
            issues.push({ path: '/spec/tokens_candidates/palette', message: `the brief's ${p.name} ${p.color} is missing from the palette` });
        }
    }

    // The theme wires body text straight to `contrast` on `base` (field bug:
    // a dark brief once aliased contrast to a near-black "high-contrast dark"
    // on a near-black ground and the header vanished at 1.06:1). base is the
    // ground, contrast is the INK — the pair must exist and must read.
    const bySlug = Object.fromEntries((spec.tokens_candidates?.palette ?? []).map((p) => [p.slug, String(p.color)]));
    for (const slug of ['base', 'contrast']) {
        if (!bySlug[slug]) {
            issues.push({ path: '/spec/tokens_candidates/palette', message: `the theme's reserved "${slug}" slug is missing — the theme's own template parts resolve base (the ground) and contrast (the ink)` });
        }
    }
    if (bySlug.base && bySlug.contrast) {
        const ratio = contrastRatio(bySlug.base, bySlug.contrast);
        if (ratio < 4.5) {
            issues.push({
                path: '/spec/tokens_candidates/palette',
                message: `contrast ${bySlug.contrast} on base ${bySlug.base} reads at ${ratio.toFixed(2)}:1 — body text needs at least 4.5:1. "contrast" means the ink colour against the ground, not a high-contrast-looking dark; on a dark base it must be LIGHT`,
            });
        }
    }

    // Every section the brief will build needs vocabulary to build it from.
    const covered = new Set((value.molecules ?? []).map((m) => m.role));
    for (const role of new Set(sectionRoles)) {
        if (!covered.has(role)) {
            issues.push({ path: '/molecules', message: `no molecule for the "${role}" sections the brief declares — every role the brief uses needs at least one arrangement` });
        }
    }

    // Slugs below the kit resolve to slugs the kit declares.
    const slugs = {
        palette: new Set((spec.tokens_candidates?.palette ?? []).map((p) => p.slug)),
        spacing: new Set(((spec.tokens_candidates?.spacing ?? {}).steps ?? []).map((s) => s.slug)),
        font: new Set(((spec.tokens_candidates?.typography ?? {}).sizes ?? []).map((s) => s.slug)),
    };
    const seen = new Set();
    for (const m of value.molecules ?? []) {
        if (seen.has(m.id)) issues.push({ path: `/molecules (${m.id})`, message: 'duplicate molecule id' });
        seen.add(m.id);
        const refs = m.style_refs ?? {};
        for (const [field, set, kind] of [
            ['palette_slug', slugs.palette, 'palette'],
            ['background_palette_slug', slugs.palette, 'palette'],
            ['font_size_slug', slugs.font, 'font size'],
        ]) {
            if (refs[field] !== undefined && !set.has(refs[field])) {
                issues.push({ path: `/molecules (${m.id})/style_refs/${field}`, message: `"${refs[field]}" is not a ${kind} slug this kit declares` });
            }
        }
        for (const s of refs.spacing_slugs ?? []) {
            if (!slugs.spacing.has(s)) {
                issues.push({ path: `/molecules (${m.id})/style_refs/spacing_slugs`, message: `"${s}" is not a spacing slug this kit declares` });
            }
        }
    }
    return issues;
}

/**
 * tokens_candidates IS a DesignTokens document — the contract $refs the same
 * four properties — so the tokens gate that shipped in M2 runs unchanged on it.
 */
export function tokensFromKit(spec) {
    const { palette, spacing, typography, layout } = spec.tokens_candidates ?? {};
    return { palette, spacing, typography, layout };
}

/** agent/<kit_id>-<molecule_id>, inside the companion's 64-char slug window. */
export function kitId(brief) {
    const raw = String(brief?.identity?.site_title ?? 'kit')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return (raw || 'kit').slice(0, 20).replace(/-$/, '');
}

export function patternSlug(kit_id, moleculeId) {
    return `agent/${kit_id}-${moleculeId}`.slice(0, 64).replace(/-$/, '');
}
