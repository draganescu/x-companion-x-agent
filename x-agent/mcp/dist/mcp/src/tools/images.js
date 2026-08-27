/**
 * The asset pass — ONE conveyor, two lanes. A layout ships with wp_placeholder
 * pixels stretched by attributes (each carrying a one-sentence
 * `metadata.imageIntent`) and with `metadata.surfaceIntent` markers naming the
 * run's surface dictionary assets on groups and covers. These two tools turn
 * both kinds of brief into real assets:
 *
 *   wp_images_generate  parse the post, find typed refs (content placeholder+
 *                       intent pairs; surface markers), send each brief to a
 *                       Gemini image model — content one call per slot, surfaces
 *                       ONE call per unique dictionary asset however many bands
 *                       reference it — and write files + a typed manifest to a
 *                       local directory. Nothing on the site changes.
 *
 *   wp_images_apply     ONE transaction per post: upload the manifest's files,
 *                       swap url/id on content nodes (refusing drift), write
 *                       each surface's style.background / cover url (refusing
 *                       targets an admin has since claimed), recompile through
 *                       the harness and update the post once. The flat band
 *                       underneath every surface is the reservation and the
 *                       fallback — a refused surface ships today's design.
 *
 * The Gemini key comes from `gemini_api_key` in .x-agent.json (or
 * GEMINI_API_KEY); the model from `image_model`. Set X_AGENT_IMAGE_FIXTURES to
 * a directory of pre-generated files to replay instead of calling the model
 * (deterministic runs). Both tools are content-tier.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { XError, errInvalidInput } from '../errors.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';
import { GeminiImages, DEFAULT_IMAGE_MODEL, SURFACE_RETRY_SUFFIX, aspectForClass, buildImagePrompt, buildSurfacePrompt, fixturePathFor, } from '../images/gemini.js';
import { scanRefs, applyImage, applySurface, stripSurface } from '../images/scan.js';
import { MANIFEST_FILENAME, emptyManifest, loadManifest, loadManifestIfPresent, mergeManifest, planSurfaceCalls, saveManifest, } from '../images/manifest.js';
import { computeKeyHex, processAsset, textureBoundFor, veilFor } from '../images/process.js';
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
const SurfaceInputSchema = z.object({
    id: z.string().describe('Dictionary asset id — matches metadata.surfaceIntent markers on the post.'),
    class: z.enum(['field', 'pattern', 'frieze', 'spot', 'canvas']),
    prompt_seed: z.string(),
    intensity: z.enum(['whisper', 'present', 'loud']).optional(),
    hexes: z.array(z.string()).min(1).describe('The EXACT hexes of every band this asset touches. A surface prompt without its hexes is a bug.'),
    ground_baked: z.boolean().optional().describe('Spot only: bake the band hex into a JPEG instead of chroma-keying to alpha. Legal only on skin-less flat bands.'),
    position: z.string().optional().describe('backgroundPosition for frieze/spot application.'),
    size: z.string().optional().describe('backgroundSize for application, or an image_size override for generation.'),
});
const GenerateInput = z.object({
    ...ConnectionArgsShape,
    post_id: z.number().int().positive().optional().describe('The page/post whose refs get real assets. Optional with assets_only.'),
    rest_base: z.string().optional().describe("Core REST base of the post type: 'pages' (default) or 'posts' or a CPT's rest_base."),
    style: z
        .string()
        .optional()
        .describe('One art-direction line appended to every prompt so the assets share a look, e.g. "Belle Époque lithograph poster, deep reds and golds".'),
    surface_style: z
        .string()
        .optional()
        .describe('Material-safe style line for the SURFACE lane (the artistic style plus its texture cue). Scene-flavoured art direction leaks scenes into textures; when omitted, style is used for both lanes.'),
    surfaces: z.array(SurfaceInputSchema).optional().describe('The run’s surface dictionary: generation is keyed by id — one call per unique asset per run.'),
    assets_only: z.boolean().optional().describe('Generate dictionary assets without scanning a post (e.g. the page canvas).'),
    model: z.string().optional().describe('Gemini image model id; defaults to image_model from .x-agent.json.'),
    out_dir: z.string().optional().describe('Where files and the manifest are written; defaults to the data dir.'),
    dry_run: z.boolean().optional().describe('Scan and report typed refs WITHOUT calling the image model.'),
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
const GeneratedSurfaceSchema = z.object({
    asset_id: z.string(),
    class: z.string(),
    paths: z.array(z.string()).describe('Every target path in this post referencing the asset.'),
    file: z.string().optional(),
    bytes: z.number().optional(),
    ms: z.number().optional(),
    post_processing: z.string().optional(),
    lum_min: z.number().optional(),
    lum_max: z.number().optional(),
    attempts: z.number().optional().describe('>1 when the texture bound rejected the first birth and the hardened retry passed.'),
});
const GenerateOutput = z.object({
    post_id: z.number().optional(),
    found: z.number().describe('Content placeholder+intent pairs discovered in the post.'),
    found_surfaces: z.number().describe('Surface markers discovered in the post.'),
    generated: z.number().describe('Files written by this call, both lanes.'),
    cached: z.array(z.string()).describe('Dictionary asset ids replayed from the manifest instead of re-bought.'),
    cached_content: z.array(z.string()).describe('Content ref paths replayed from the manifest instead of re-bought.'),
    dry_run: z.boolean(),
    out_dir: z.string().optional(),
    manifest_path: z.string().optional().describe('Feed this to wp_images_apply.'),
    images: z.array(GeneratedImageSchema),
    surfaces: z.array(GeneratedSurfaceSchema),
    rejected: z
        .array(z.object({ asset_id: z.string(), reason: z.string() }))
        .describe('Assets that failed the texture bound after their one hardened retry — the flat band ships and the report carries the reason.'),
    scan_errors: z.array(z.string()).describe('Nodes refused by the scan (e.g. both intent kinds on one cover).'),
});
/** One image birth: fixture replay when X_AGENT_IMAGE_FIXTURES is set (byte
 *  determinism for fake runs), the Gemini client otherwise. */
async function birthImage(gemini, prompt, aspect) {
    const fixtureDir = process.env.X_AGENT_IMAGE_FIXTURES;
    if (fixtureDir && fixtureDir.trim() !== '') {
        const candidates = fixturePathFor(fixtureDir, prompt, aspect);
        for (const [file, mime] of [[candidates.jpg, 'image/jpeg'], [candidates.png, 'image/png']]) {
            if (fs.existsSync(file))
                return { data: fs.readFileSync(file), mimeType: mime, ms: 0 };
        }
        throw new XError('invalid_input', `No image fixture for this prompt (looked for ${path.basename(candidates.jpg)}).`, 'Capture fixtures with a real run first, or unset X_AGENT_IMAGE_FIXTURES.');
    }
    if (!gemini) {
        throw new XError('invalid_input', 'No Gemini API key configured, and generating images needs one.', 'Add "gemini_api_key" to .x-agent.json (or set GEMINI_API_KEY). Keys: https://aistudio.google.com/apikey');
    }
    const result = await gemini.generate(prompt, aspect);
    // Capture lane for deterministic replays: a real run can mint the fixture
    // set a fake run replays byte-for-byte (X_AGENT_IMAGE_FIXTURES_CAPTURE).
    const captureDir = process.env.X_AGENT_IMAGE_FIXTURES_CAPTURE;
    if (captureDir && captureDir.trim() !== '') {
        fs.mkdirSync(captureDir, { recursive: true });
        const target = fixturePathFor(captureDir, prompt, aspect);
        fs.writeFileSync(result.mimeType === 'image/png' ? target.png : target.jpg, result.data);
    }
    return result;
}
export const wpImagesGenerate = defineTool({
    name: 'wp_images_generate',
    title: 'Generate real assets for a post’s refs — content and surface lanes',
    description: 'The first half of the asset pass. Reads the post’s raw content, parses it on the instance, finds every typed ref — wp_placeholder pixels carrying metadata.imageIntent (content lane) and metadata.surfaceIntent markers on groups/covers (surface lane) — and generates one image per content brief plus ONE per unique surface dictionary asset (Gemini; key = gemini_api_key in .x-agent.json or GEMINI_API_KEY). Surface prompts carry the exact band hexes and the run’s style line; pattern/spot assets are deterministically post-processed (mirror-tile / chroma-key). Writes files plus a typed manifest and changes NOTHING on the site — wp_images_apply does the transaction. Use dry_run:true to see both lanes first.',
    inputSchema: GenerateInput,
    outputSchema: GenerateOutput,
    handler: async (input, ctx) => {
        const args = GenerateInput.parse(input ?? {});
        const live = ctx.runtime.ctx(connectionArgs(input));
        const restBase = args.rest_base ?? 'pages';
        if (!args.post_id && !args.assets_only) {
            throw errInvalidInput('post_id is required unless assets_only is set.', 'Pass the post to scan, or assets_only:true with a surfaces dictionary.');
        }
        const { sessionFor } = await import('../session.js');
        const session = await sessionFor(live);
        // The editor's own parser (on the harness page) — PHP parse_blocks does
        // not extract sourced attributes like an image's url, so it cannot see
        // the placeholders, let alone survive a recompile.
        let contentRefs = [];
        let surfaceRefs = [];
        let scanErrors = [];
        if (args.post_id) {
            const { content_raw } = await live.companion.corePostRaw(restBase, args.post_id);
            const { blocks: tree } = await session.parseMarkup(content_raw);
            const scanned = scanRefs(tree);
            contentRefs = scanned.content;
            surfaceRefs = scanned.surfaces;
            scanErrors = scanned.errors;
        }
        const dictionary = (args.surfaces ?? []).map((s) => ({ ...s }));
        const surfacePathsById = new Map();
        for (const ref of surfaceRefs) {
            const list = surfacePathsById.get(ref.asset_id) ?? [];
            list.push(ref.path);
            surfacePathsById.set(ref.asset_id, list);
        }
        const outDir = args.out_dir ?? defaultOutDir(args.post_id ?? 0);
        const manifestPath = path.join(outDir, MANIFEST_FILENAME);
        const existing = loadManifestIfPresent(manifestPath);
        const surfacePlan = planSurfaceCalls(dictionary, existing);
        const cachedContent = args.post_id
            ? contentRefs
                .filter((ref) => {
                const prior = existing?.content.find((c) => c.post_id === args.post_id && c.path === ref.path);
                return prior !== undefined && fs.existsSync(prior.file);
            })
                .map((r) => r.path)
            : [];
        if (args.dry_run) {
            return {
                post_id: args.post_id,
                found: contentRefs.length,
                found_surfaces: surfaceRefs.length,
                generated: 0,
                cached: surfacePlan.cached,
                cached_content: cachedContent,
                dry_run: true,
                images: contentRefs,
                surfaces: dictionary.map((d) => ({ asset_id: d.id, class: d.class, paths: surfacePathsById.get(d.id) ?? [] })),
                rejected: [],
                scan_errors: scanErrors,
            };
        }
        const freshContent = contentRefs.filter((r) => !cachedContent.includes(r.path));
        if (freshContent.length === 0 && surfacePlan.generate.length === 0) {
            return {
                post_id: args.post_id,
                found: contentRefs.length,
                found_surfaces: surfaceRefs.length,
                generated: 0,
                cached: surfacePlan.cached,
                cached_content: cachedContent,
                dry_run: false,
                out_dir: outDir,
                manifest_path: fs.existsSync(manifestPath) ? manifestPath : undefined,
                images: [],
                surfaces: [],
                rejected: [],
                scan_errors: scanErrors,
            };
        }
        const apiKey = live.config.gemini_api_key;
        const model = args.model ?? live.config.image_model ?? DEFAULT_IMAGE_MODEL;
        const gemini = apiKey ? new GeminiImages({ apiKey, model }) : null;
        fs.mkdirSync(outDir, { recursive: true });
        const incoming = emptyManifest(model, args.style);
        const failures = [];
        // Content lane — exactly today's contract, one call per surviving slot.
        const images = [];
        const CONCURRENCY = 3;
        for (let i = 0; i < freshContent.length; i += CONCURRENCY) {
            const batch = freshContent.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(batch.map(async (ref, j) => {
                const prompt = buildImagePrompt(ref.intent, args.style);
                const result = await birthImage(gemini, prompt, ref.aspect_ratio);
                const file = path.join(outDir, `img-${args.post_id}-${i + j + 1}-${slugify(ref.intent)}.jpg`);
                fs.writeFileSync(file, result.data);
                return {
                    ...ref,
                    post_id: args.post_id,
                    rest_base: restBase,
                    file,
                    prompt,
                    mime_type: result.mimeType,
                    bytes: result.data.length,
                    ms: result.ms,
                };
            }));
            results.forEach((r, j) => {
                if (r.status === 'fulfilled')
                    images.push(r.value);
                else
                    failures.push(`${batch[j].path}: ${r.reason?.message ?? String(r.reason)}`);
            });
        }
        incoming.content = images;
        // Surface lane — one birth per unique dictionary asset, then the
        // deterministic processing station (veil, mirror-tile, chroma-key,
        // recompress), then the TEXTURE BOUND: the station measures every asset's
        // luminance range at birth, and an asset whose range exceeds its class-
        // and-intensity bound is not a material (a "field" that came back as a
        // photograph of a room reads 0..1). One hardened retry, then the flat
        // band ships and the report screams.
        const surfacesOut = [];
        const rejected = [];
        const surfaceStyle = args.surface_style ?? args.style;
        for (const spec of surfacePlan.generate) {
            try {
                // A true-alpha spot is generated on a computed chroma key — the
                // candidate farthest from the site palette, recorded in the manifest.
                // A ground-baked spot bakes the band hex instead and skips the
                // knockout: it ships as a JPEG, legal only on skin-less flat bands.
                if (spec.class === 'spot' && !spec.ground_baked && !spec.key_hex) {
                    spec.key_hex = computeKeyHex(spec.hexes);
                }
                const prompt = buildSurfacePrompt(spec, surfaceStyle);
                const aspect = aspectForClass(spec.class);
                const processClass = spec.class === 'spot' && spec.ground_baked ? 'field' : spec.class;
                const veil = veilFor(spec.class, spec.intensity, spec.hexes[0]);
                const bound = textureBoundFor(spec.class, spec.intensity);
                let attempts = 0;
                let ms = 0;
                let processed = null;
                for (const attemptPrompt of [prompt, `${prompt} ${SURFACE_RETRY_SUFFIX}`]) {
                    attempts += 1;
                    const raw = await birthImage(gemini, attemptPrompt, aspect);
                    ms += raw.ms;
                    processed = await processAsset(session, raw.data, raw.mimeType, { class: processClass, key_hex: spec.key_hex, veil });
                    if (bound === null || processed.lum_max - processed.lum_min <= bound)
                        break;
                    // Keep the evidence: a rejected birth is saved for the post-mortem
                    // the report will provoke — was it a scene, or is the bound wrong?
                    const rejectDir = path.join(outDir, 'rejected');
                    fs.mkdirSync(rejectDir, { recursive: true });
                    const rejectExt = processed.mime_type === 'image/png' ? 'png' : 'jpg';
                    fs.writeFileSync(path.join(rejectDir, `asset-${spec.id}-attempt${attempts}.${rejectExt}`), processed.bytes);
                    processed = null;
                }
                if (!processed) {
                    rejected.push({
                        asset_id: spec.id,
                        reason: `texture bound: the measured luminance range exceeds ${bound} for a ${spec.intensity ?? 'present'} ${spec.class} after ${attempts} attempts — not a material, the flat band ships`,
                    });
                    continue;
                }
                const ext = processed.mime_type === 'image/png' ? 'png' : 'jpg';
                const file = path.join(outDir, `asset-${spec.id}.${ext}`);
                fs.writeFileSync(file, processed.bytes);
                const entry = {
                    kind: 'surface',
                    asset_id: spec.id,
                    class: spec.class,
                    file,
                    prompt,
                    mime_type: processed.mime_type,
                    bytes: processed.bytes.length,
                    ms,
                    post_processing: veil ? `${processed.post_processing}+veil(${veil.hex}@${veil.alpha})` : processed.post_processing,
                    lum_min: processed.lum_min,
                    lum_max: processed.lum_max,
                    targets: [],
                };
                if (attempts > 1)
                    entry.attempts = attempts;
                if (spec.key_hex)
                    entry.key_hex = spec.key_hex;
                if (spec.position)
                    entry.position = spec.position;
                if (spec.size)
                    entry.size = spec.size;
                if (spec.intensity)
                    entry.intensity = spec.intensity;
                surfacesOut.push(entry);
            }
            catch (e) {
                failures.push(`surface ${spec.id}: ${e?.message ?? String(e)}`);
            }
        }
        incoming.surfaces = surfacesOut;
        if (images.length === 0 && surfacesOut.length === 0 && failures.length > 0) {
            throw new XError('companion_error', `Every image call failed. First failure: ${failures[0]}`, 'Check the key, the model id, and the network.', {
                failures,
            });
        }
        // Every surface asset in the dictionary (fresh or cached) records this
        // post's targets, so apply knows the fan-out from one asset to many bands.
        const merged = mergeManifest(existing, incoming);
        if (args.post_id) {
            for (const ref of surfaceRefs) {
                const entry = merged.surfaces.find((s) => s.asset_id === ref.asset_id);
                if (!entry)
                    continue;
                if (!entry.targets.some((t) => t.post_id === args.post_id && t.path === ref.path)) {
                    entry.targets.push({
                        post_id: args.post_id,
                        rest_base: restBase,
                        path: ref.path,
                        block_name: ref.block_name,
                        mechanism: ref.mechanism,
                        reservation: ref.reservation,
                    });
                }
            }
        }
        saveManifest(manifestPath, merged);
        return {
            post_id: args.post_id,
            found: contentRefs.length,
            found_surfaces: surfaceRefs.length,
            generated: images.length + surfacesOut.length,
            cached: surfacePlan.cached,
            cached_content: cachedContent,
            dry_run: false,
            out_dir: outDir,
            manifest_path: manifestPath,
            images: images.map(({ kind: _k, post_id: _p, rest_base: _r, ...rest }) => rest),
            surfaces: surfacesOut.map((s) => ({
                asset_id: s.asset_id,
                class: s.class,
                paths: surfacePathsById.get(s.asset_id) ?? [],
                file: s.file,
                bytes: s.bytes,
                ms: s.ms,
                post_processing: s.post_processing,
                lum_min: s.lum_min,
                lum_max: s.lum_max,
                ...(s.attempts !== undefined ? { attempts: s.attempts } : {}),
            })),
            rejected,
            scan_errors: scanErrors,
            ...(failures.length ? { failures } : {}),
        };
    },
});
/* --------------------------------------------------------------------- apply */
const ApplyInput = z.object({
    ...ConnectionArgsShape,
    post_id: z.number().int().positive(),
    rest_base: z.string().optional().describe("Defaults to the manifest target's rest_base."),
    manifest_path: z.string().optional().describe('The manifest wp_images_generate wrote; defaults to its default location for this post.'),
    strip_surfaces: z
        .array(z.string())
        .optional()
        .describe('REVERSE mode: take these dictionary assets OFF the post instead of applying anything — the flat band underneath shows again. Only removes applications whose url matches our own upload; an admin’s background is never stripped. Same one-transaction contract (parse fresh, strip, recompile, update once).'),
});
const ApplyOutput = z.object({
    post_id: z.number(),
    uploaded: z.array(z.object({ id: z.number(), source_url: z.string() })),
    swapped: z.number().describe('Content nodes whose url/id were swapped.'),
    surfaces_applied: z.number().describe('Surface targets whose background was written.'),
    surfaces_stripped: z.number().optional().describe('Surface targets whose background was removed (strip_surfaces mode).'),
    skipped: z.array(z.string()).describe('Entries refused: drifted content nodes, or surface targets an admin has claimed.'),
    surfaces: z
        .array(z.object({ asset_id: z.string(), media_id: z.number().optional(), media_url: z.string().optional(), applied: z.number(), refused: z.number() }))
        .describe('Per-asset outcome, including target-less assets (the page canvas) uploaded for the tokens route.'),
    all_valid: z.boolean(),
    link: z.string(),
});
export const wpImagesApply = defineTool({
    name: 'wp_images_apply',
    title: 'Apply generated assets to the post — one transaction, both lanes',
    description: 'The second half of the asset pass, ONE transaction per post: takes the typed manifest, uploads each file to the media library (content alt = the brief; surfaces carry NO alt — a background is decorative by construction; each surface asset is uploaded once and reused across every target), swaps url/id on content nodes (refusing any node that changed since the scan), writes each surface’s style.background or cover url (refusing any target whose background an admin has since set — the flat band stays, it is the reservation and the fallback), recompiles the whole tree through the instance’s own harness, and updates the post once. Refusals are itemized in skipped[]; a partial apply still ships what matched.',
    inputSchema: ApplyInput,
    outputSchema: ApplyOutput,
    handler: async (input, ctx) => {
        const args = ApplyInput.parse(input ?? {});
        const live = ctx.runtime.ctx(connectionArgs(input));
        const manifestPath = args.manifest_path ?? path.join(defaultOutDir(args.post_id), MANIFEST_FILENAME);
        if (!fs.existsSync(manifestPath)) {
            throw errInvalidInput(`No manifest at ${manifestPath}.`, 'Run wp_images_generate first, or pass manifest_path to the file it reported.');
        }
        const manifest = loadManifest(manifestPath);
        const content = manifest.content.filter((c) => c.post_id === args.post_id);
        const surfaceWork = manifest.surfaces
            .map((s) => ({ entry: s, targets: s.targets.filter((t) => t.post_id === args.post_id) }))
            .filter((w) => w.targets.length > 0 || (w.entry.class === 'canvas' && w.entry.targets.length === 0));
        if (content.length === 0 && surfaceWork.length === 0) {
            throw errInvalidInput(`The manifest at ${manifestPath} has no entries for post ${args.post_id}.`, 'Run wp_images_generate against this post first.');
        }
        const restBase = args.rest_base ?? content[0]?.rest_base ?? surfaceWork[0]?.targets[0]?.rest_base ?? 'pages';
        const { sessionFor } = await import('../session.js');
        const session = await sessionFor(live);
        const { content_raw } = await live.companion.corePostRaw(restBase, args.post_id);
        const { blocks: tree } = await session.parseMarkup(content_raw);
        // REVERSE mode — the S9 rescue's instrument: take named assets OFF this
        // post. The flat band underneath was never touched, so removing our
        // application restores today's design exactly. Same transaction shape.
        if (args.strip_surfaces && args.strip_surfaces.length > 0) {
            const stripSkipped = [];
            let stripped = 0;
            for (const assetId of args.strip_surfaces) {
                const entry = manifest.surfaces.find((s) => s.asset_id === assetId);
                if (!entry?.media_url) {
                    stripSkipped.push(`surface ${assetId}: not in the manifest or never uploaded — nothing to strip`);
                    continue;
                }
                for (const target of entry.targets.filter((t) => t.post_id === args.post_id)) {
                    if (stripSurface(tree, target, entry.media_url))
                        stripped += 1;
                    else
                        stripSkipped.push(`${target.path}: does not carry our ${assetId} application — not touched`);
                }
            }
            if (stripped === 0) {
                throw new XError('invalid_input', 'Nothing to strip: no named surface application still matches the post.', 'Check strip_surfaces ids against the manifest.', {
                    skipped: stripSkipped,
                });
            }
            await live.manifestCache.get({ fingerprintMinIntervalMs: 0 });
            const compiled = await session.compile(tree);
            if (!compiled.all_valid) {
                throw new XError('companion_error', 'The stripped tree did not compile all_valid; the post was NOT updated.', '', { invalid: compiled.invalid });
            }
            const saved = await live.companion.corePostUpdate(restBase, args.post_id, compiled.markup);
            return {
                post_id: args.post_id,
                uploaded: [],
                swapped: 0,
                surfaces_applied: 0,
                surfaces_stripped: stripped,
                skipped: stripSkipped,
                surfaces: args.strip_surfaces.map((id) => ({ asset_id: id, applied: 0, refused: 0 })),
                all_valid: compiled.all_valid,
                link: saved.link,
            };
        }
        const uploaded = [];
        const skipped = [];
        let swapped = 0;
        let surfacesApplied = 0;
        let manifestDirty = false;
        for (const image of content) {
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
        const surfaceOutcomes = [];
        for (const { entry, targets } of surfaceWork) {
            const outcome = { asset_id: entry.asset_id, applied: 0, refused: 0 };
            surfaceOutcomes.push(outcome);
            if (!entry.media_id || !entry.media_url) {
                if (!fs.existsSync(entry.file)) {
                    skipped.push(`surface ${entry.asset_id}: file missing (${entry.file})`);
                    continue;
                }
                const bytes = fs.readFileSync(entry.file);
                // NO alt text: a background image is decorative by construction.
                const media = await live.companion.coreMediaUpload(path.basename(entry.file), bytes, entry.mime_type || 'image/jpeg');
                uploaded.push({ id: media.id, source_url: media.source_url });
                entry.media_id = media.id;
                entry.media_url = media.source_url;
                manifestDirty = true;
            }
            outcome.media_id = entry.media_id;
            outcome.media_url = entry.media_url;
            for (const target of targets) {
                const ok = applySurface(tree, target, { id: entry.media_id, url: entry.media_url }, {
                    class: entry.class,
                    position: entry.position,
                    size: entry.size,
                });
                if (ok) {
                    surfacesApplied += 1;
                    outcome.applied += 1;
                }
                else {
                    outcome.refused += 1;
                    skipped.push(`${target.path}: surface target no longer empty — an admin's background is never overwritten`);
                }
            }
        }
        if (manifestDirty)
            saveManifest(manifestPath, manifest);
        if (swapped === 0 && surfacesApplied === 0) {
            if (surfaceWork.some((w) => w.entry.class === 'canvas' && w.targets.length === 0) && surfaceOutcomes.some((o) => o.media_id)) {
                // A canvas-only apply legitimately touches no tree node: the asset is
                // uploaded for the tokens route and the post stays as it is.
                return {
                    post_id: args.post_id,
                    uploaded,
                    swapped: 0,
                    surfaces_applied: 0,
                    skipped,
                    surfaces: surfaceOutcomes,
                    all_valid: true,
                    link: '',
                };
            }
            throw new XError('invalid_input', 'Nothing to apply: no manifest entry still matches the post.', 'Re-run wp_images_generate against the current post.', {
                skipped,
            });
        }
        // Markup only ever comes from the instance's own save() functions.
        await live.manifestCache.get({ fingerprintMinIntervalMs: 0 });
        const result = await session.compile(tree);
        if (!result.all_valid) {
            throw new XError('companion_error', 'The updated tree did not compile all_valid; the post was NOT updated.', 'Inspect invalid[] — the apply only changed url/id and style.background attributes.', {
                invalid: result.invalid,
            });
        }
        const updated = await live.companion.corePostUpdate(restBase, args.post_id, result.markup);
        return {
            post_id: args.post_id,
            uploaded,
            swapped,
            surfaces_applied: surfacesApplied,
            skipped,
            surfaces: surfaceOutcomes,
            all_valid: result.all_valid,
            link: updated.link,
        };
    },
});
export const tools = [wpImagesGenerate, wpImagesApply];
//# sourceMappingURL=images.js.map