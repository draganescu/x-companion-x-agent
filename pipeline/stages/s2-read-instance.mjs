import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { pickPattern, sliceManifest, toTreeIrBlocks } from '../lib/instance.mjs';

export const id = 'S2_read_instance';
export const kind = 'deterministic';

export async function run(ctx) {
    const connect = await ctx.call('wp_connect', {});
    if (!connect.ok) {
        throw new PipelineError(connect.data.code ?? 'companion_error', connect.data.message, connect.data.hint ?? '');
    }
    if (connect.data.posture !== 'toolchain') {
        throw new PipelineError('preflight_failed',
            `instance posture is "${connect.data.posture}" — the pipeline needs a toolchain instance`,
            'Boot a Playground via tools/playground/boot.mjs or point .x-agent.json at a staging site in toolchain posture.');
    }

    const manifest = await ctx.call('wp_manifest', {});
    if (!manifest.ok) {
        throw new PipelineError(manifest.data.code ?? 'companion_error', manifest.data.message, manifest.data.hint ?? '');
    }
    const patternsRes = await ctx.call('wp_patterns', {});
    if (!patternsRes.ok) {
        throw new PipelineError(patternsRes.data.code ?? 'companion_error', patternsRes.data.message, patternsRes.data.hint ?? '');
    }
    const patterns = Array.isArray(patternsRes.data) ? patternsRes.data : patternsRes.data.patterns ?? [];

    const instance = {
        site_url: connect.data.site_url,
        posture: connect.data.posture,
        fingerprint: connect.data.fingerprint,
        initial_fingerprint: connect.data.fingerprint,
        wp_version: connect.data.wp_version,
        theme_tokens: manifest.data.theme_tokens,
    };
    writeFileSync(join(ctx.runDir, 'instance.json'), JSON.stringify(instance, null, 2));
    ctx.state.instance = instance;
    ctx.state.fingerprint = connect.data.fingerprint;

    // Surface capability is PROBED, never assumed (x-surfaces): a site whose
    // core/group lacks the background support degrades every group-skin
    // surface to none — loudly, in the report, never as an error and never as
    // a CSS fallback. Absence of the features section reads as available on a
    // 'latest' Playground; the group support itself is the authority.
    const groupSupports = (manifest.data.blocks ?? {})['core/group']?.supports ?? {};
    const features = manifest.data.features ?? {};
    ctx.state.surface_support = {
        group_background: groupSupports.background?.backgroundImage === true,
        global_styles_background: features.global_styles_background?.available !== false,
    };
    if ((ctx.state.brief.surfaces ?? []).length > 0 && !ctx.state.surface_support.group_background) {
        ctx.log('this instance\'s core/group has no background-image support — every group-skin surface will ship as its flat band (recorded in the report)');
    }

    const sections = [];
    for (const page of ctx.state.brief.pages) {
        for (const section of page.sections) {
            const key = `${page.slug}--${section.id}`;
            const file = join('sections', `${key}.json`);
            const pattern = pickPattern(patterns, section.role);
            const entry = {
                page: { slug: page.slug, title: page.title },
                section,
                manifest_slice: sliceManifest(manifest.data.blocks ?? {}, section, ctx.state.brief),
                pattern: pattern ? { name: pattern.name, title: pattern.title, parsed_tree: toTreeIrBlocks(pattern.parsed_tree) } : null,
            };
            writeFileSync(join(ctx.runDir, file), JSON.stringify(entry, null, 2));
            sections.push({ key, page: page.slug, id: section.id, file });
        }
    }
    // The site furniture (header + footer template parts) gets its own slice:
    // identity and navigation blocks no section role carries.
    const FURNITURE_BLOCKS = ['core/group', 'core/columns', 'core/column', 'core/paragraph', 'core/heading',
        'core/site-title', 'core/site-tagline', 'core/navigation', 'core/navigation-link', 'core/buttons',
        'core/button', 'core/separator', 'core/social-links', 'core/social-link', 'core/spacer'];
    const furnitureSlice = {};
    for (const name of FURNITURE_BLOCKS) {
        const b = (manifest.data.blocks ?? {})[name];
        if (!b) continue;
        const { attributes, supports, parent, styles, variations } = b;
        furnitureSlice[name] = {
            ...(attributes !== undefined ? { attributes } : {}),
            ...(supports !== undefined ? { supports } : {}),
            ...(parent !== undefined ? { parent } : {}),
            ...(styles !== undefined ? { styles } : {}),
            ...(variations !== undefined ? { variations } : {}),
        };
    }
    writeFileSync(join(ctx.runDir, 'furniture-slice.json'), JSON.stringify(furnitureSlice, null, 2));

    ctx.state.sections = sections;
    ctx.log(`site read: ${connect.data.site_url} (WordPress ${connect.data.wp_version}) — ${sections.length} sections to write across ${ctx.state.brief.pages.length} page(s), fingerprint ${instance.fingerprint.slice(0, 8)}…`);
}
