/**
 * ============================================================================
 * THE TOOL TABLE — 16 tools, two implementation tracks, one array.
 * ============================================================================
 *
 * WHY THIS FILE LOOKS LIKE THIS
 * -----------------------------
 * Six of the eighteen tools (wp_compile, wp_verify, wp_screenshot,
 * wp_block_scaffold, wp_block_build_test, wp_block_install) are implemented by a
 * SECOND agent in `src/tools/{compile,verify,screenshot,blockScaffold,
 * blockBuildTest,blockInstall}.ts`, on top of `src/{session,oracle,factory}.ts`.
 * Neither track may edit the other's files. So:
 *
 *   1. ALL SIXTEEN tools — names, titles, descriptions, input schemas and output
 *      schemas — are declared HERE, in `TOOLS`. `tools/list` therefore returns
 *      all eighteen with full schemas whether or not the other track's modules
 *      exist yet. A tool is never missing at LIST time.
 *
 *   2. The six externally-implemented entries start with a placeholder handler
 *      that throws `{code:'not_implemented'}`. That is a normal structured error
 *      at CALL time — again, never a missing tool at list time.
 *
 *   3. `loadExternalHandlers()` is a DYNAMIC, FAILURE-TOLERANT loader. For each
 *      external module basename it probes `src/tools/<base>.{ts,js,mjs}` on disk
 *      and imports it only if present. `ERR_MODULE_NOT_FOUND`, a syntax error,
 *      or a module that exports nothing useful all degrade to "keep the
 *      placeholder" and log a debug line — the server still boots. The import
 *      specifier is built at runtime from a path, so `tsc` never tries to
 *      resolve a file that does not exist yet.
 *
 * WHAT THE OTHER TRACK MUST EXPORT (either form works, both are scanned):
 *
 *      export const tools: ToolDef[] = [ ... ];          // preferred
 *      export const wpCompile: ToolDef = { ... };        // any named export
 *      export default { ... } as ToolDef;                // default export
 *
 * A `ToolDef` whose `name` matches a declared entry REPLACES that entry
 * wholesale — handler, and also title/description/inputSchema/outputSchema if it
 * supplies them. A ToolDef with an unknown `name` is APPENDED, so the other
 * track can add tools beyond the eighteen without touching this file.
 *
 * IMPORTANT FOR THE SESSION/FACTORY TRACK — `ToolDef.local`
 * ---------------------------------------------------------
 * `local: true` declares "this tool needs no connection config". The caller
 * (server.ts#callTool) then builds a Ctx whose `config`/`companion`/
 * `manifestCache` are accessor traps that throw the structured config error only
 * if the handler actually touches them. Without `local: true`, a tool call with
 * no resolvable connection fails with `{code:'invalid_input'}` BEFORE the
 * handler runs.
 *
 * So: `wp_block_scaffold` and `wp_block_build_test` are pure local work (copy a
 * template; npm build + Playground smoke test) and SHOULD set `local: true`.
 * `wp_compile`, `wp_verify`, `wp_screenshot` and `wp_block_install` all need the
 * instance and should leave it unset. Placeholders are treated as local
 * automatically so a missing module reports `not_implemented` rather than a
 * config error.
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { errNotImplemented } from './errors.js';
/* ------------------------------------------- locally implemented tool table */
import { tools as connectTools } from './tools/connect.js';
import { tools as manifestTools } from './tools/manifest.js';
import { tools as patternsTools } from './tools/patterns.js';
import { tools as validateTools } from './tools/validate.js';
import { tools as parseTools } from './tools/parse.js';
import { tools as renderTools } from './tools/render.js';
import { tools as specValidateTools } from './tools/specValidate.js';
import { tools as tokensTools } from './tools/tokens.js';
import { tools as snapshotTools } from './tools/snapshot.js';
import { tools as pixelPlaceholderTools } from './tools/placeholder.js';
import { tools as patternSaveTools } from './tools/patternSave.js';
import { tools as schemaScaffoldTools } from './tools/schemaScaffold.js';
import { tools as schemaBuildTestTools } from './tools/schemaBuildTest.js';
import { tools as schemaInstallTools } from './tools/schemaInstall.js';
import { tools as themeScaffoldTools } from './tools/themeScaffold.js';
import { tools as themeBuildTestTools } from './tools/themeBuildTest.js';
import { tools as themeInstallTools } from './tools/themeInstall.js';
import { tools as imagesTools } from './tools/images.js';
/* -------------------------- externally implemented (session/oracle/factory) */
const ConnArgs = {
    url: z.string().optional(),
    user: z.string().optional(),
    app_password: z.string().optional(),
};
const ViewportSchema = z.object({ width: z.number().gt(0), height: z.number().gt(0) });
const BoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
/** Declared here so `tools/list` is complete before the modules exist. */
const EXTERNAL_TOOLS = [
    {
        name: 'wp_compile',
        title: 'Compile a TreeIR to canonical block markup',
        description: 'Drives window.__compile on the instance GET /harness page in a warm headless browser, so markup comes from each block\'s real save() implementation. NEVER hand-write "<!-- wp:" markup; this tool is the only legitimate source of it. Returns {markup, all_valid, invalid[], registry_gaps, epoch}; all_valid must be true before you ship a layout. If a block in the tree is in the manifest but missing from the client-side registry the call fails with {code:"harness_gap", blocks:[...]}.',
        inputSchema: z.looseObject({
            ...ConnArgs,
            version: z.number().optional().describe('TreeIR version, the literal number 1.'),
            epoch: z.string().optional().describe('Manifest fingerprint the tree was generated against.'),
            blocks: z.array(z.unknown()).optional().describe('BlockNode[] — the tree to compile.'),
        }),
        outputSchema: z.object({
            markup: z.string(),
            all_valid: z.boolean(),
            invalid: z.array(z.object({ path: z.string(), name: z.string(), validation_issues: z.unknown() })),
            registry_gaps: z.array(z.string()),
            epoch: z.string(),
        }),
    },
    {
        name: 'wp_verify',
        title: 'Numerically verify a layout against a Design Spec IR',
        description: 'THE ORACLE. Renders markup (or navigates a url) in the warm browser, extracts per-element geometry and computed styles, builds an accessibility outline, and diffs numerically against DesignSpecIR regions. Tolerances default to 4px/2% position and size, one spacing step for gap, 1px for font size, and are overridable. Use this instead of comparing screenshots — screenshots are terminal evidence only.',
        inputSchema: z.looseObject({
            ...ConnArgs,
            markup: z.string().optional().describe('Compiled markup to render and measure. Mutually exclusive with url.'),
            url: z.string().optional().describe('Live URL to navigate and measure instead of rendering markup.'),
            nav_timeout_ms: z.number().int().min(1000).max(600000).optional().describe('Navigation timeout in ms (default 60000). Lower it for pages that never settle.'),
            wait: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe("waitUntil for the navigation (default 'load'). Use 'domcontentloaded' for frontends whose subresources crawl or never idle — e.g. WooCommerce on a single-worker sandbox."),
            spec: z.record(z.string(), z.unknown()).optional().describe('DesignSpecIR to diff against. Omit to get box_tree + a11y_outline only.'),
            spec_region_id: z.string().optional().describe('Restrict the diff to one region subtree.'),
            viewport: ViewportSchema.optional().describe('Measurement viewport, e.g. {width:1440,height:900}.'),
            tolerances: z
                .object({
                position_px: z.number().optional(),
                position_ratio: z.number().optional(),
                size_px: z.number().optional(),
                size_ratio: z.number().optional(),
                gap_steps: z.number().optional(),
                font_size_px: z.number().optional(),
            })
                .optional(),
        }),
        outputSchema: z.object({
            box_tree: z.array(z.object({
                selector_path: z.string(),
                block_name: z.string().optional(),
                box: BoxSchema,
                computed: z.object({
                    display: z.string(),
                    gap: z.string(),
                    fontSize: z.string(),
                    fontFamily: z.string(),
                    color: z.string(),
                    background: z.string(),
                }),
            })),
            a11y_outline: z.array(z.object({ role: z.string(), name: z.string(), level: z.number().optional() })),
            images: z.array(z.object({
                selector_path: z.string(),
                box: BoxSchema,
                natural_w: z.number(),
                natural_h: z.number(),
                loaded: z.boolean(),
                lazy: z.boolean(),
                src: z.string(),
            })),
            diffs: z.array(z.object({
                region_id: z.string(),
                kind: z.enum(['position', 'size', 'gap', 'font_size', 'color', 'missing', 'extra']),
                expected: z.unknown(),
                actual: z.unknown(),
                delta: z.unknown(),
                within_tolerance: z.boolean(),
            })),
            pass: z.boolean(),
        }),
    },
    {
        name: 'wp_screenshot',
        title: 'Take the final acceptance screenshot',
        description: 'ONE full-page PNG via the warm browser, for human acceptance at the END of a build. This is deliberately not a loop primitive: iterate with wp_verify\'s numbers, then take exactly one screenshot as evidence.',
        inputSchema: z.looseObject({
            ...ConnArgs,
            url: z.string().optional(),
            markup: z.string().optional(),
            viewport: ViewportSchema.optional(),
            nav_timeout_ms: z.number().int().min(1000).max(600000).optional().describe('Navigation timeout in ms (default 60000). Lower it for pages that never settle.'),
            wait: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe("waitUntil for the navigation (default 'load'). Use 'domcontentloaded' for frontends whose subresources crawl or never idle — e.g. WooCommerce on a single-worker sandbox."),
            out_path: z.string().optional().describe('Destination .png path; defaults to a temp file.'),
        }),
        outputSchema: z.object({ path_to_png: z.string(), viewport: ViewportSchema, bytes: z.number() }),
    },
    {
        name: 'wp_block_scaffold',
        title: 'Scaffold a new dynamic block',
        description: 'Step 3 of the vocabulary-gap ladder, and only after composition and block styles/patterns have been ruled out. Copies templates/dynamic-block and interpolates slug/title/attributes. ALWAYS dynamic — static blocks freeze save() output into content and are never generated. render_intent is embedded as a comment for you to implement render.php against. The generated editor UI previews render.php through ServerSideRender and keeps every setting in the inspector; description, labels and help are user-facing copy for site editors.',
        inputSchema: z.looseObject({
            slug: z.string().regex(/^[a-z0-9-]+$/).describe('Block slug; the block name becomes agent/{slug}.'),
            title: z.string(),
            description: z.string().optional().describe('User-facing description shown in the inserter. Write for site editors; defaults to the title.'),
            attributes: z
                .array(z.object({
                name: z.string(),
                type: z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object']),
                default: z.unknown().optional(),
                control: z.enum(['text', 'textarea', 'number', 'toggle', 'select', 'image']).optional(),
                options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
                label: z.string().optional().describe('User-facing control label; defaults to a title-cased version of name.'),
                help: z.string().optional().describe('User-facing help text under the control.'),
            }))
                .optional(),
            render_intent: z.string().describe('Natural-language description of what render.php must output.'),
            dir: z.string().optional().describe('Parent directory for the scaffold; defaults to a temp workspace.'),
        }),
        outputSchema: z.object({ dir: z.string(), name: z.string(), files: z.array(z.string()) }),
    },
    {
        name: 'wp_block_build_test',
        title: 'Build and smoke-test a scaffolded block',
        description: 'THE SAFETY GATE. Syntax-gates every shipped script (no build step — the block is vanilla no-build JS), boots @wp-playground/cli, registers the block, asserts it appears in /wp/v2/block-types and renders sample markup, then produces an install zip that satisfies the companion install policy. The companion deliberately does not lint PHP — nothing reaches an instance that has not passed here.',
        inputSchema: z.looseObject({
            dir: z.string().describe('Scaffold directory returned by wp_block_scaffold.'),
            sample_attributes: z.record(z.string(), z.unknown()).optional().describe('Attribute values used for the smoke render.'),
        }),
        outputSchema: z.object({
            built: z.boolean(),
            smoke: z.object({
                registered: z.boolean(),
                rendered_html: z.string(),
                php_error: z.string().optional(),
            }),
            zip_path: z.string().optional(),
            build_log: z.string().optional(),
        }),
    },
    {
        name: 'wp_block_install',
        title: 'Install a built block onto the instance',
        description: 'POST /blocks/install with the zip from wp_block_build_test, then refresh the manifest and reload the harness session onto the new epoch. The returned fingerprint is the epoch every subsequent tree must carry. EXTEND TIER: refused with {code:"posture_forbidden"} on production posture — snapshot to a sandbox and install there.',
        inputSchema: z.looseObject({ ...ConnArgs, zip_path: z.string().describe('Path to the zip produced by wp_block_build_test.') }),
        outputSchema: z.object({
            installed: z.object({ slug: z.string(), name: z.string(), version: z.string() }),
            fingerprint: z.string(),
            replaced_previous: z.boolean(),
        }),
    },
];
/** module basename in `src/tools/` -> the tool name it is expected to provide */
const EXTERNAL_MODULES = {
    compile: 'wp_compile',
    verify: 'wp_verify',
    screenshot: 'wp_screenshot',
    blockScaffold: 'wp_block_scaffold',
    blockBuildTest: 'wp_block_build_test',
    blockInstall: 'wp_block_install',
};
/* ------------------------------------------------------------- build TOOLS */
const PLACEHOLDERS = new Set(EXTERNAL_TOOLS.map((t) => t.name));
function placeholder(def) {
    return {
        ...def,
        handler: async () => {
            throw errNotImplemented(def.name);
        },
    };
}
/**
 * The tool table. Stable array identity: `loadExternalHandlers()` mutates
 * entries in place rather than rebuilding, so anything that captured `TOOLS`
 * before the load still sees the finished table afterwards.
 */
export const TOOLS = [
    ...connectTools,
    ...manifestTools,
    ...patternsTools,
    ...validateTools,
    ...renderTools,
    ...parseTools,
    ...specValidateTools,
    ...tokensTools,
    ...snapshotTools,
    ...pixelPlaceholderTools,
    ...patternSaveTools,
    ...schemaScaffoldTools,
    ...schemaBuildTestTools,
    ...schemaInstallTools,
    ...themeScaffoldTools,
    ...themeBuildTestTools,
    ...themeInstallTools,
    ...imagesTools,
    ...EXTERNAL_TOOLS.map(placeholder),
];
export function findTool(name) {
    return TOOLS.find((t) => t.name === name);
}
/** Names that still have a placeholder handler. */
export function unimplementedToolNames() {
    return TOOLS.filter((t) => PLACEHOLDERS.has(t.name)).map((t) => t.name);
}
/** True while `name` still resolves to the not_implemented placeholder. */
export function isUnimplemented(name) {
    return PLACEHOLDERS.has(name);
}
/* -------------------------------------------- dynamic failure-tolerant load */
function looksLikeToolDef(v) {
    if (!v || typeof v !== 'object')
        return false;
    const t = v;
    return typeof t.name === 'string' && typeof t.handler === 'function' && Boolean(t.inputSchema);
}
function collectToolDefs(mod) {
    const out = [];
    for (const value of Object.values(mod)) {
        if (looksLikeToolDef(value))
            out.push(value);
        else if (Array.isArray(value))
            for (const v of value)
                if (looksLikeToolDef(v))
                    out.push(v);
    }
    return out;
}
let loaded = false;
/**
 * Import every present external tool module and splice its ToolDefs into TOOLS.
 * Safe to call repeatedly; the first successful pass wins unless `force`.
 */
export async function loadExternalHandlers(opts = {}) {
    const report = { loaded: [], missing: [], failed: [], added: [] };
    if (loaded && !opts.force)
        return report;
    loaded = true;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const toolsDir = path.join(here, 'tools');
    for (const [base, expectedName] of Object.entries(EXTERNAL_MODULES)) {
        let file;
        for (const ext of ['.ts', '.js', '.mjs', '.mts']) {
            const candidate = path.join(toolsDir, base + ext);
            if (fs.existsSync(candidate)) {
                file = candidate;
                break;
            }
        }
        if (!file) {
            report.missing.push(expectedName);
            continue;
        }
        let mod;
        try {
            // Runtime-built specifier: tsc must not try to resolve a file that the
            // other track has not written yet.
            mod = (await import(/* @vite-ignore */ pathToFileURL(file).href));
        }
        catch (e) {
            report.failed.push({ module: base, error: e.message });
            opts.logger?.warn(`tool module ${base} failed to load, keeping not_implemented placeholder: ${e.message}`);
            continue;
        }
        const defs = collectToolDefs(mod);
        if (defs.length === 0) {
            report.failed.push({ module: base, error: 'module exported no ToolDef' });
            continue;
        }
        for (const def of defs) {
            const idx = TOOLS.findIndex((t) => t.name === def.name);
            if (idx >= 0) {
                const existing = TOOLS[idx];
                TOOLS[idx] = {
                    ...existing,
                    ...def,
                    title: def.title ?? existing.title,
                    description: def.description ?? existing.description,
                    inputSchema: def.inputSchema ?? existing.inputSchema,
                    outputSchema: def.outputSchema ?? existing.outputSchema,
                };
                PLACEHOLDERS.delete(def.name);
                report.loaded.push(def.name);
            }
            else {
                TOOLS.push(def);
                report.added.push(def.name);
            }
        }
    }
    return report;
}
//# sourceMappingURL=registry.js.map