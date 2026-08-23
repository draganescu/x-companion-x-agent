/**
 * Zod mirrors of the vendored JSON Schemas in `x-agent/schemas/`.
 *
 * The JSON Schemas are the contract; these are the runtime/typing convenience
 * copy. `tests/schemas.test.ts` proves the two agree by running a matrix of
 * valid AND invalid documents through both a tiny inline JSON-Schema validator
 * and the zod schema below, and asserting identical accept/reject.
 *
 * Mirroring rules used throughout:
 *   - JSON Schema `additionalProperties: false`  -> `.strict()`
 *   - JSON Schema object with no additionalProperties clause -> plain z.object()
 *     (zod strips unknown keys but does not reject, which matches "accept")
 *   - `type: ["a","b"]`   -> z.union([...])
 *   - `const: 1`          -> z.literal(1)
 *   - `$ref` recursion    -> z.lazy()
 */
import { z } from 'zod';
export const BLOCK_NAME_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;
export const BlockNodeSchema = z.lazy(() => z
    .object({
    name: z.string().regex(BLOCK_NAME_RE),
    attributes: z.record(z.string(), z.unknown()).optional(),
    innerBlocks: z.array(BlockNodeSchema).optional(),
})
    .strict());
export const TreeIRSchema = z.object({
    version: z.literal(1),
    epoch: z.string(),
    blocks: z.array(BlockNodeSchema),
});
/* ------------------------------------------------------------- Diagnostics */
export const DIAGNOSTIC_CODES = [
    'E_TREE_SCHEMA',
    'E_UNKNOWN_BLOCK',
    'E_ATTR_TYPE',
    'E_ATTR_ENUM',
    'E_NEST_PARENT',
    'E_NEST_ANCESTOR',
    'E_EPOCH_MISMATCH',
    'E_BINDING_UNKNOWN',
    'E_BINDING_UNBINDABLE',
    'W_ATTR_UNKNOWN',
    'W_STATIC_NEEDS_HARNESS',
    'W_HINT_ALLOWED_BLOCKS',
    'W_HINT_TEMPLATE_LOCK',
    'W_STYLE_UNKNOWN',
];
export const DiagnosticSchema = z.object({
    code: z.enum(DIAGNOSTIC_CODES),
    severity: z.enum(['error', 'warning']),
    path: z.string(),
    message: z.string(),
    fix_hint: z.string().optional(),
});
export const DiagnosticsSchema = z.object({
    valid: z.boolean(),
    epoch_ok: z.boolean(),
    server_fingerprint: z.string().optional(),
    diagnostics: z.array(DiagnosticSchema),
});
/* ---------------------------------------------------------------- Manifest */
export const BlockStyleEntrySchema = z.object({
    name: z.string(),
    label: z.string(),
    source: z.enum(['theme', 'plugin', 'agent']),
});
export const BlockVariationEntrySchema = z.object({
    name: z.string(),
    title: z.string(),
    source: z.enum(['server', 'client']),
    description: z.string().optional(),
    scope: z.array(z.string()).optional(),
    isDefault: z.boolean().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    innerBlocks: z.array(z.unknown()).optional(),
});
export const ManifestBlockSchema = z.object({
    title: z.string(),
    category: z.union([z.string(), z.null()]),
    api_version: z.int(),
    attributes: z.record(z.string(), z.unknown()),
    supports: z.record(z.string(), z.unknown()).optional(),
    parent: z.union([z.array(z.string()), z.null()]).optional(),
    ancestor: z.union([z.array(z.string()), z.null()]).optional(),
    provides_context: z.record(z.string(), z.unknown()).optional(),
    uses_context: z.array(z.string()).optional(),
    is_dynamic: z.boolean(),
    variations_count: z.int().optional(),
    variations: z.array(BlockVariationEntrySchema).optional(),
    styles: z.array(BlockStyleEntrySchema).optional(),
    agent_hints: z
        .object({
        allowed_blocks: z.union([z.array(z.string()), z.null()]).optional(),
        template_lock: z.union([z.string(), z.boolean(), z.null()]).optional(),
        usage_notes: z.string().optional(),
        example_attributes: z.record(z.string(), z.unknown()).optional(),
    })
        .optional(),
});
export const ManifestPatternSchema = z.object({
    name: z.string(),
    title: z.string(),
    categories: z.array(z.string()),
    source: z.union([z.string(), z.null()]),
    has_content: z.boolean(),
});
export const ManifestSchema = z.object({
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    generated_at: z.string(),
    wp_version: z.string(),
    site_url: z.string(),
    posture: z.enum(['toolchain', 'production']),
    interfaces_version: z.string(),
    blocks: z.record(z.string(), ManifestBlockSchema),
    patterns: z.array(ManifestPatternSchema),
    theme_tokens: z.object({
        color: z.object({ palette: z.unknown().optional() }),
        spacing: z.object({ spacingSizes: z.unknown().optional(), spacingScale: z.unknown().optional() }),
        typography: z.object({ fontSizes: z.unknown().optional(), fontFamilies: z.unknown().optional() }),
        layout: z.object({ contentSize: z.unknown().optional(), wideSize: z.unknown().optional() }),
    }),
    suites: z.array(z.object({ slug: z.string(), version: z.string() })),
    /** interfaces v2 sections; absent on a v1 companion. */
    global_styles: z.record(z.string(), z.unknown()).optional(),
    bindings: z.record(z.string(), z.unknown()).optional(),
    data_model: z.record(z.string(), z.unknown()).optional(),
    features: z.record(z.string(), z.unknown()).optional(),
    counts: z.object({
        blocks: z.int(),
        dynamic_blocks: z.int(),
        static_blocks: z.int(),
        patterns: z.int(),
    }),
});
export const MANIFEST_SECTIONS = ['styles', 'variations', 'global_styles', 'bindings', 'data_model', 'features'];
/* ------------------------------------------------------------ DesignTokens */
const SLUG = /^[a-z0-9-]+$/;
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
export const PaletteEntrySchema = z
    .object({
    slug: z.string().regex(SLUG),
    name: z.string(),
    color: z.string().regex(HEX),
    role: z
        .enum(['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'muted', 'border', 'other'])
        .optional(),
})
    .strict();
export const PaletteSchema = z.array(PaletteEntrySchema);
export const SpacingSchema = z
    .object({
    scale_unit: z.enum(['px', 'rem', 'em', '%', 'vw', 'vh']),
    steps: z.array(z.object({ slug: z.string().regex(SLUG), size: z.string() }).strict()),
})
    .strict();
export const TypographySchema = z
    .object({
    families: z.array(z.object({ slug: z.string().regex(SLUG), name: z.string(), fontFamily: z.string() }).strict()),
    sizes: z.array(z
        .object({
        slug: z.string().regex(SLUG),
        size: z.string(),
        fluid: z
            .union([z.boolean(), z.object({ min: z.string().optional(), max: z.string().optional() }).strict()])
            .optional(),
    })
        .strict()),
})
    .strict();
export const LayoutTokensSchema = z.object({ contentSize: z.string(), wideSize: z.string() }).strict();
export const CssTokensSchema = z
    .object({
    global: z.string().optional(),
    blocks: z.record(z.string(), z.string()).optional(),
})
    .strict();
export const DesignTokensSchema = z
    .object({
    palette: PaletteSchema,
    spacing: SpacingSchema,
    typography: TypographySchema,
    layout: LayoutTokensSchema,
    /** interfaces v2, rung 5: custom css into global styles. Requires the cited failure of rungs 1-4. */
    css: CssTokensSchema.optional(),
})
    .strict();
export const REGION_ROLES = [
    'header',
    'hero',
    'features',
    'gallery',
    'testimonial',
    'cta',
    'footer',
    'section',
    'column',
    'item',
];
export const RegionSchema = z.lazy(() => z
    .object({
    id: z.string(),
    role: z.enum(REGION_ROLES),
    box: z
        .object({
        x: z.number(),
        y: z.number(),
        w: z.number().min(0),
        h: z.number().min(0),
    })
        .strict(),
    layout: z
        .object({
        direction: z.enum(['row', 'column', 'grid']).optional(),
        gap_px: z.number().min(0).optional(),
        align: z.string().optional(),
        justify: z.string().optional(),
        columns: z.int().min(1).optional(),
    })
        .strict()
        .optional(),
    style_refs: z
        .object({
        palette_slug: z.string().optional(),
        background_palette_slug: z.string().optional(),
        font_size_slug: z.string().optional(),
        spacing_slugs: z.array(z.string()).optional(),
    })
        .strict()
        .optional(),
    children: z.array(RegionSchema).optional(),
    responsive_assumptions: z
        .array(z
        .object({
        breakpoint: z.string(),
        change: z.string(),
        confidence: z.enum(['observed', 'synthesized']),
    })
        .strict())
        .optional(),
})
    .strict());
export const QuantizationEntrySchema = z
    .object({
    observed: z.union([z.string(), z.number()]),
    snapped_to: z.string(),
    delta: z.union([z.string(), z.number()]),
    note: z.string().optional(),
})
    .strict();
export const TokensCandidatesSchema = z
    .object({
    palette: PaletteSchema,
    spacing: SpacingSchema,
    typography: TypographySchema,
    layout: LayoutTokensSchema,
    quantization_log: z.array(QuantizationEntrySchema),
})
    .strict();
export const DesignSpecIRSchema = z
    .object({
    version: z.literal(1),
    source: z
        .object({
        kind: z.enum(['image', 'figma', 'synthesized']),
        files: z.array(z.string()),
        viewport: z
            .object({
            width: z.number().gt(0),
            height: z.number().gt(0),
        })
            .strict(),
    })
        .strict(),
    tokens_candidates: TokensCandidatesSchema,
    content: z.array(z
        .object({
        id: z.string(),
        kind: z.enum(['heading', 'paragraph', 'image', 'button', 'list', 'other']),
        text: z.string().optional(),
        image_ref: z.string().optional(),
        region_id: z.string(),
    })
        .strict()),
    regions: z.array(RegionSchema),
})
    .strict();
/* ------------------------------------------------------------------ helpers */
/** RFC 6901 pointer from a zod issue path, rooted at the validated document. */
export function pointerFromPath(path) {
    if (!path.length)
        return '/';
    return ('/' +
        path
            .map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1'))
            .join('/'));
}
/** Run a zod schema and return RFC-6901-shaped issues instead of throwing. */
export function checkWithZod(schema, value) {
    const res = schema.safeParse(value);
    if (res.success)
        return [];
    return res.error.issues.map((i) => ({ path: pointerFromPath(i.path), message: i.message }));
}
//# sourceMappingURL=schemas.js.map