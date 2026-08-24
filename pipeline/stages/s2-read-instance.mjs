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
    ctx.state.sections = sections;
    ctx.log(`S2: ${sections.length} section payloads at fingerprint ${instance.fingerprint.slice(0, 8)}…`);
}
