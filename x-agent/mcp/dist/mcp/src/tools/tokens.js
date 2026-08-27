import { z } from 'zod';
import { DesignTokensSchema } from '../schemas.js';
import { errPostureForbidden } from '../errors.js';
import { emitThemeJsonSettings, diffAgainstThemeTokens } from '../../../templates/theme-json/emitter.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';
const InputSchema = z.object({
    ...ConnectionArgsShape,
    palette: DesignTokensSchema.shape.palette,
    spacing: DesignTokensSchema.shape.spacing,
    typography: DesignTokensSchema.shape.typography,
    layout: DesignTokensSchema.shape.layout,
    css: DesignTokensSchema.shape.css.describe('Rung 5 of the expression ladder: custom css into global styles ({global?, blocks?: {block name: css}}). Only after supports, tokens, block styles and variations have failed — cite the failure. Rejected entries come back itemized in css_rejected.'),
    styles: DesignTokensSchema.shape.styles.describe('x-surfaces: {background: {backgroundImage: {url, id?}, backgroundSize?, backgroundRepeat?, backgroundPosition?, backgroundAttachment?}} — the page canvas, shipped through global styles (WP >= 6.6; probe manifest features.global_styles_background first). Admin-undoable in the Styles UI. Rejections come back itemized in background_rejected.'),
    dry_run: z
        .boolean()
        .optional()
        .describe('Emit the theme.json settings object and its diff against the instance manifest.theme_tokens WITHOUT writing anything.'),
});
const OutputSchema = z.object({
    applied: z.boolean(),
    dry_run: z.boolean(),
    adapters_applied: z.array(z.string()),
    fingerprint: z.string(),
    theme_json_written: z.boolean().optional(),
    theme_json_preview: z.unknown().describe('The theme.json settings object this token set compiles to (local mirror of the server-side compiler).'),
    diff_against_instance: z.array(z.unknown()).describe('Per-token differences between the preview and the instance theme_tokens at the current epoch.'),
    css_written: z.boolean().optional(),
    css_rejected: z
        .array(z.object({ target: z.string(), reason: z.string() }))
        .optional()
        .describe('Itemized css rejections (markup in css, unknown block). Never silently dropped.'),
    background_written: z.boolean().optional(),
    background_rejected: z
        .array(z.object({ target: z.string(), reason: z.string() }))
        .optional()
        .describe('Itemized page-canvas rejections (bad url, no styles.background support on this WordPress). Never silently dropped.'),
});
export const wpTokensApply = defineTool({
    name: 'wp_tokens_apply',
    title: 'Apply a DesignTokens set to the instance',
    description: 'POST /theme/tokens — writes the design system into the instance (user-origin global styles, plus any suite adapters). EXTEND TIER: refused with {code:"posture_forbidden"} on a production-posture instance; snapshot to a sandbox and apply there instead. Always returns the local theme.json settings preview and a diff against the instance tokens, so dry_run:true is a free rehearsal.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    handler: async (input, ctx) => {
        const args = InputSchema.parse(input ?? {});
        const tokens = DesignTokensSchema.parse({
            palette: args.palette,
            spacing: args.spacing,
            typography: args.typography,
            layout: args.layout,
            ...(args.css !== undefined ? { css: args.css } : {}),
            ...(args.styles !== undefined ? { styles: args.styles } : {}),
        });
        const preview = emitThemeJsonSettings(tokens);
        const live = ctx.runtime.ctx(connectionArgs(input));
        const manifest = await live.manifestCache.get();
        const diff = diffAgainstThemeTokens(preview, manifest.theme_tokens);
        if (args.dry_run) {
            return {
                applied: false,
                dry_run: true,
                adapters_applied: [],
                fingerprint: manifest.fingerprint,
                theme_json_preview: preview,
                diff_against_instance: diff,
            };
        }
        if (manifest.posture === 'production')
            throw errPostureForbidden('/theme/tokens');
        const res = await live.companion.themeTokens(tokens);
        // Writing tokens changes the site's CSS but NOT the block registry, so the
        // fingerprint usually does not move. The layout oracle caches the site's
        // harvested stylesheets per fingerprint, which would therefore keep serving
        // pre-token styles and make wp_verify's computed colours silently stale —
        // and only when a verify happened to run before the token write, which makes
        // it an ordering-dependent bug rather than an obvious one. Drop that cache.
        // Imported lazily: this tool must stay usable without playwright installed.
        try {
            const oracle = await import('../oracle.js');
            oracle.clearThemeStyleCache?.();
        }
        catch {
            /* oracle not present in this build; nothing to invalidate */
        }
        return {
            applied: true,
            dry_run: false,
            adapters_applied: res.adapters_applied ?? [],
            fingerprint: res.fingerprint,
            theme_json_written: res.theme_json_written,
            theme_json_preview: preview,
            diff_against_instance: diff,
            ...(res.css_written !== undefined ? { css_written: Boolean(res.css_written) } : {}),
            ...(Array.isArray(res.css_rejected) ? { css_rejected: res.css_rejected } : {}),
            ...(res.background_written !== undefined ? { background_written: Boolean(res.background_written) } : {}),
            ...(Array.isArray(res.background_rejected) ? { background_rejected: res.background_rejected } : {}),
        };
    },
});
export const tools = [wpTokensApply];
//# sourceMappingURL=tokens.js.map