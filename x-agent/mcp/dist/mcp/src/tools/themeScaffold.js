/**
 * `wp_theme_scaffold` — the deterministic half of the theme factory
 * (specs/theme-factory.spec.json). Takes a validated ThemeSpec (the ONE
 * artifact the model authors) and compiles a complete block theme directory:
 * theme.json, the fixed template roster (index, page, page-no-title, canvas),
 * and the parts the skeleton declares. Pure templating — same spec, same
 * bytes, every time.
 *
 * Fully local: no connection config required (`local: true`). The next step is
 * always wp_theme_build_test; nothing reaches an instance without that gate.
 */
import { z } from 'zod';
import { ThemeSpecSchema, scaffoldTheme } from '../themeFactory.js';
import { defineTool } from './_shared.js';
const InputSchema = z.looseObject({
    spec: ThemeSpecSchema.describe('The ThemeSpec — identity, skeleton (stacked|split|rail), measure, physics, presets. Validated against contract/schemas/theme-spec.schema.json.'),
    dir: z.string().optional().describe('Parent directory for the scaffold; defaults to a temp workspace.'),
    force: z.boolean().optional().describe('Overwrite an existing non-empty scaffold directory.'),
});
const OutputSchema = z.object({
    dir: z.string(),
    slug: z.string(),
    name: z.string(),
    files: z.array(z.string()),
    rail_width: z.string().optional().describe('Declared rail width (rail skeleton only) — S9 audits the rendered rail against it.'),
});
export const wpThemeScaffold = defineTool({
    name: 'wp_theme_scaffold',
    title: 'Scaffold a bespoke block theme from a ThemeSpec',
    description: 'Compiles a ThemeSpec into a complete, named block theme directory — deterministically. The model authors the spec; this tool owns every byte on disk. The theme ships structure only: no patterns, no block styles, no fonts. Next step is always wp_theme_build_test.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    local: true,
    handler: async (input, _ctx) => {
        const args = InputSchema.parse(input ?? {});
        const opts = {};
        if (args.dir)
            opts.dir = args.dir;
        if (args.force)
            opts.force = true;
        return scaffoldTheme(args.spec, opts);
    },
});
export const tools = [wpThemeScaffold];
export default wpThemeScaffold;
//# sourceMappingURL=themeScaffold.js.map