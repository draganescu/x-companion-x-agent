/**
 * `wp_theme_build_test` — THE safety gate between a scaffolded theme and any
 * instance (specs/theme-factory.spec.json build_gate). Boots a throwaway
 * Playground on its own port (9480-9489; blocks own 9440-9449), activates the
 * theme, asserts the full template roster resolves (page-no-title by name),
 * publishes a physics page and MEASURES the physics in real Chromium: root
 * block-gap seams zero, root padding as declared, content clamped to the
 * declared measure — the Layout Cascade verified at the source for once.
 * built:true + zip on pass, diagnostics otherwise. Nothing installs without it.
 */
import { z } from 'zod';
import { buildAndTestTheme } from '../themeFactory.js';
import { defineTool } from './_shared.js';
const InputSchema = z.looseObject({
    dir: z.string().describe('The scaffolded theme directory (a wp_theme_scaffold output).'),
    port: z.number().int().optional().describe('Fixed port for the throwaway sandbox; otherwise the first free port in 9480-9489 (X_AGENT_THEME_SMOKE_PORT_RANGE).'),
    timeout_ms: z.number().int().optional().describe('Overall sandbox budget; default 5 minutes.'),
});
const ProbeMeasured = z
    .object({
    root_gap_px: z.number(),
    padding_top_px: z.number(),
    padding_bottom_px: z.number(),
    padding_top_declared_px: z.number(),
    padding_bottom_declared_px: z.number(),
    content_var: z.string(),
    wide_var: z.string(),
    content_declared_px: z.number(),
    wide_declared_px: z.number(),
    measure_px: z.number(),
    content_box_px: z.number(),
    full_px: z.number(),
    wide_px: z.number(),
    rail_px: z.number(),
    rail_declared_px: z.number(),
    viewport_px: z.number(),
    body_text: z.string(),
})
    .partial();
const OutputSchema = z.object({
    built: z.boolean(),
    smoke: z.object({
        activated: z.boolean(),
        stylesheet: z.string(),
        theme_name: z.string(),
        templates_resolved: z.array(z.string()),
        templates_missing: z.array(z.string()),
        page_no_title_present: z.boolean(),
        parts_resolved: z.array(z.string()),
        rail_area_registered: z.boolean().optional(),
        php_error: z.string(),
    }),
    measured: ProbeMeasured.optional(),
    zip_path: z.string().optional(),
    build_log: z.string().optional(),
    failure: z
        .object({
        code: z.enum(['build_failed', 'smoke_failed']),
        message: z.string(),
        hint: z.string(),
    })
        .optional(),
    timings_ms: z.object({ boot: z.number().optional(), total: z.number() }).optional(),
});
export const wpThemeBuildTest = defineTool({
    name: 'wp_theme_build_test',
    title: 'Build-test a scaffolded theme in a throwaway sandbox, physics measured',
    description: 'The theme gate: boots a disposable Playground on its own port, activates the theme, asserts every roster template resolves (page-no-title asserted by name), renders a smoke page with no PHP notices, and MEASURES the physics in a real browser — zero root seams, declared root padding, content clamped to the declared measure. built:true + zip_path on pass; failure diagnostics otherwise. A theme that fails here repairs its ThemeSpec, never its files.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    local: true,
    handler: async (input, _ctx) => {
        const args = InputSchema.parse(input ?? {});
        const buildInput = { dir: args.dir };
        if (args.port !== undefined)
            buildInput.port = args.port;
        if (args.timeout_ms !== undefined)
            buildInput.timeout_ms = args.timeout_ms;
        return buildAndTestTheme(buildInput);
    },
});
export const tools = [wpThemeBuildTest];
export default wpThemeBuildTest;
//# sourceMappingURL=themeBuildTest.js.map