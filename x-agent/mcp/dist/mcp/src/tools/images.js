/**
 * The image pass — the hand-off wp-blocks R5 promises. A layout ships with
 * wp_placeholder pixels stretched by attributes, each carrying a one-sentence
 * `metadata.imageIntent`. These two tools turn those briefs into real assets:
 *
 *   wp_images_generate  parse the post, find placeholder+intent pairs, send
 *                       each brief to a Gemini image model (Nano Banana), and
 *                       write the JPEGs + a manifest to a local directory.
 *                       Nothing on the site changes.
 *
 *   wp_images_apply     upload the manifest's files to the media library, swap
 *                       url/id on the exact nodes the briefs came from, then
 *                       recompile through the harness (markup only ever comes
 *                       from the instance's own save() functions) and update
 *                       the post.
 *
 * The Gemini key comes from `gemini_api_key` in .x-agent.json (or GEMINI_API_KEY
 * in the environment); the model from `image_model` (default Nano Banana 2
 * Lite). Both tools are content-tier: they read/write post content and media
 * through core REST, and work on any posture.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { XError, errInvalidInput } from '../errors.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';
import { GeminiImages, DEFAULT_IMAGE_MODEL, buildImagePrompt } from '../images/gemini.js';
import { findPlaceholders, applyImage } from '../images/scan.js';
const MANIFEST_FILENAME = 'images-manifest.json';
function defaultOutDir(postId) {
    const base = process.env.X_AGENT_DATA_DIR && process.env.X_AGENT_DATA_DIR.trim() !== ''
        ? process.env.X_AGENT_DATA_DIR
        : path.join(os.tmpdir(), 'x-agent');
    return path.join(base, 'images', `post-${postId}`);
}
function slugify(text, max = 40) {
    const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
    return s || 'image';
}
/* ------------------------------------------------------------------ generate */
const GenerateInput = z.object({
    ...ConnectionArgsShape,
    post_id: z.number().int().positive().describe('The page/post whose placeholders get real images.'),
    rest_base: z.string().optional().describe("Core REST base of the post type: 'pages' (default) or 'posts' or a CPT's rest_base."),
    style: z
        .string()
        .optional()
        .describe('One art-direction line appended to every prompt so the images share a look, e.g. "Belle Époque lithograph poster, deep reds and golds".'),
    model: z.string().optional().describe('Gemini image model id; defaults to image_model from .x-agent.json, then Nano Banana 2 Lite.'),
    out_dir: z.string().optional().describe('Where the JPEGs and the manifest are written; defaults to the data dir.'),
    dry_run: z.boolean().optional().describe('Scan and report the placeholder/intent pairs WITHOUT calling the image model.'),
});
const GeneratedImageSchema = z.object({
    path: z.string(),
    block_name: z.string(),
    intent: z.string(),
    aspect_ratio: z.string(),
    file: z.string().optional(),
    bytes: z.number().optional(),
    ms: z.number().optional(),
});
const GenerateOutput = z.object({
    post_id: z.number(),
    found: z.number().describe('Placeholder+intent pairs discovered in the post.'),
    generated: z.number(),
    dry_run: z.boolean(),
    out_dir: z.string().optional(),
    manifest_path: z.string().optional().describe('Feed this to wp_images_apply.'),
    images: z.array(GeneratedImageSchema),
});
export const wpImagesGenerate = defineTool({
    name: 'wp_images_generate',
    title: 'Generate real images for a post’s placeholders',
    description: 'The first half of the image pass. Reads the post’s raw content, parses it on the instance, finds every wp_placeholder pixel that carries a metadata.imageIntent brief, and generates one image per brief with a Gemini image model (Nano Banana family; key = gemini_api_key in .x-agent.json or GEMINI_API_KEY). Writes JPEGs plus a manifest to a local directory and changes NOTHING on the site — wp_images_apply does the swap. Use dry_run:true to see the briefs first; pass style to give every image one look.',
    inputSchema: GenerateInput,
    outputSchema: GenerateOutput,
    handler: async (input, ctx) => {
        const args = GenerateInput.parse(input ?? {});
        const live = ctx.runtime.ctx(connectionArgs(input));
        const restBase = args.rest_base ?? 'pages';
        // The editor's own parser (on the harness page) — PHP parse_blocks does
        // not extract sourced attributes like an image's url, so it cannot see
        // the placeholders, let alone survive a recompile.
        const { sessionFor } = await import('../session.js');
        const session = await sessionFor(live);
        const { content_raw } = await live.companion.corePostRaw(restBase, args.post_id);
        const { blocks: tree } = await session.parseMarkup(content_raw);
        const refs = findPlaceholders(tree);
        if (args.dry_run) {
            return { post_id: args.post_id, found: refs.length, generated: 0, dry_run: true, images: refs };
        }
        if (refs.length === 0) {
            return { post_id: args.post_id, found: 0, generated: 0, dry_run: false, images: [] };
        }
        const apiKey = live.config.gemini_api_key;
        if (!apiKey) {
            throw new XError('invalid_input', 'No Gemini API key configured, and generating images needs one.', 'Add "gemini_api_key" to .x-agent.json (or set GEMINI_API_KEY). Keys: https://aistudio.google.com/apikey');
        }
        const model = args.model ?? live.config.image_model ?? DEFAULT_IMAGE_MODEL;
        const gemini = new GeminiImages({ apiKey, model });
        const outDir = args.out_dir ?? defaultOutDir(args.post_id);
        fs.mkdirSync(outDir, { recursive: true });
        const images = [];
        const failures = [];
        const CONCURRENCY = 3;
        for (let i = 0; i < refs.length; i += CONCURRENCY) {
            const batch = refs.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(batch.map(async (ref, j) => {
                const prompt = buildImagePrompt(ref.intent, args.style);
                const result = await gemini.generate(prompt, ref.aspect_ratio);
                const file = path.join(outDir, `img-${i + j + 1}-${slugify(ref.intent)}.jpg`);
                fs.writeFileSync(file, result.data);
                return { ...ref, file, prompt, mime_type: result.mimeType, bytes: result.data.length, ms: result.ms };
            }));
            results.forEach((r, j) => {
                if (r.status === 'fulfilled')
                    images.push(r.value);
                else
                    failures.push(`${batch[j].path}: ${r.reason?.message ?? String(r.reason)}`);
            });
        }
        if (images.length === 0) {
            throw new XError('companion_error', `Every image call failed. First failure: ${failures[0]}`, 'Check the key, the model id, and the network.', {
                failures,
            });
        }
        const manifest = { post_id: args.post_id, rest_base: restBase, model, images };
        if (args.style)
            manifest.style = args.style;
        const manifestPath = path.join(outDir, MANIFEST_FILENAME);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        return {
            post_id: args.post_id,
            found: refs.length,
            generated: images.length,
            dry_run: false,
            out_dir: outDir,
            manifest_path: manifestPath,
            images: images.map(({ file, bytes, ms, ...ref }) => ({ ...ref, file, bytes, ms })),
            ...(failures.length ? { failures } : {}),
        };
    },
});
/* --------------------------------------------------------------------- apply */
const ApplyInput = z.object({
    ...ConnectionArgsShape,
    post_id: z.number().int().positive(),
    rest_base: z.string().optional().describe("Defaults to the manifest's rest_base."),
    manifest_path: z.string().optional().describe('The manifest wp_images_generate wrote; defaults to its default location for this post.'),
});
const ApplyOutput = z.object({
    post_id: z.number(),
    uploaded: z.array(z.object({ id: z.number(), source_url: z.string() })),
    swapped: z.number(),
    skipped: z.array(z.string()).describe('Manifest entries whose node no longer matches (page edited since the scan).'),
    all_valid: z.boolean(),
    link: z.string(),
});
export const wpImagesApply = defineTool({
    name: 'wp_images_apply',
    title: 'Swap generated images into the post',
    description: 'The second half of the image pass. Takes the manifest wp_images_generate wrote, uploads each file to the media library (alt text = the brief), swaps url/id on the exact nodes the briefs came from — refusing any node that changed since the scan — recompiles the tree through the instance’s own harness, and updates the post. The imageIntent stays on each node as provenance. Verify with wp_verify afterwards; its images[] now reports real natural sizes.',
    inputSchema: ApplyInput,
    outputSchema: ApplyOutput,
    handler: async (input, ctx) => {
        const args = ApplyInput.parse(input ?? {});
        const live = ctx.runtime.ctx(connectionArgs(input));
        const manifestPath = args.manifest_path ?? path.join(defaultOutDir(args.post_id), MANIFEST_FILENAME);
        if (!fs.existsSync(manifestPath)) {
            throw errInvalidInput(`No manifest at ${manifestPath}.`, 'Run wp_images_generate first, or pass manifest_path to the file it reported.');
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.post_id !== args.post_id) {
            throw errInvalidInput(`The manifest at ${manifestPath} is for post ${manifest.post_id}, not ${args.post_id}.`, 'Point manifest_path at the right run of wp_images_generate.');
        }
        const restBase = args.rest_base ?? manifest.rest_base ?? 'pages';
        const { sessionFor } = await import('../session.js');
        const session = await sessionFor(live);
        const { content_raw } = await live.companion.corePostRaw(restBase, args.post_id);
        const { blocks: tree } = await session.parseMarkup(content_raw);
        const uploaded = [];
        const skipped = [];
        let swapped = 0;
        for (const image of manifest.images) {
            if (!fs.existsSync(image.file)) {
                skipped.push(`${image.path}: file missing (${image.file})`);
                continue;
            }
            const bytes = fs.readFileSync(image.file);
            const media = await live.companion.coreMediaUpload(path.basename(image.file), bytes, image.mime_type || 'image/jpeg', image.intent);
            uploaded.push({ id: media.id, source_url: media.source_url });
            if (applyImage(tree, image, { id: media.id, url: media.source_url })) {
                swapped += 1;
            }
            else {
                skipped.push(`${image.path}: node changed since the scan — not overwritten`);
            }
        }
        if (swapped === 0) {
            throw new XError('invalid_input', 'Nothing to swap: no manifest entry still matches the post.', 'Re-run wp_images_generate against the current post.', {
                skipped,
            });
        }
        // Markup only ever comes from the instance's own save() functions.
        await live.manifestCache.get({ fingerprintMinIntervalMs: 0 });
        const result = await session.compile(tree);
        if (!result.all_valid) {
            throw new XError('companion_error', 'The updated tree did not compile all_valid; the post was NOT updated.', 'Inspect invalid[] — the swap only changed url/id attributes.', {
                invalid: result.invalid,
            });
        }
        const updated = await live.companion.corePostUpdate(restBase, args.post_id, result.markup);
        return {
            post_id: args.post_id,
            uploaded,
            swapped,
            skipped,
            all_valid: result.all_valid,
            link: updated.link,
        };
    },
});
export const tools = [wpImagesGenerate, wpImagesApply];
//# sourceMappingURL=images.js.map