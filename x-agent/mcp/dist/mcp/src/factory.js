/**
 * ============================================================================
 * THE BLOCK FACTORY — scaffold, syntax-gate, smoke-test, package, install.
 * ============================================================================
 *
 * Step 3 of the vocabulary-gap ladder. Everything here exists to answer one
 * question honestly: *is this PHP safe to put on a WordPress instance?*
 *
 * WHY THIS FILE IS THE SAFETY GATE
 * --------------------------------
 * `POST /blocks/install` (CONTRACT.md §5) does **structural** validation only —
 * "No `php -l`, no `exec`". The companion will happily accept a package whose
 * `render.php` is a parse error waiting to fatal the front page. The contract
 * puts the real gate here, on the agent side:
 *
 *     syntax-gate every shipped script -> stage the exact bytes that will
 *     ship -> boot a throwaway WordPress -> register the block -> assert it
 *     in /wp/v2/block-types -> render it -> only then zip.
 *
 * There is NO build step (decision 2026-08-26): the scaffold is vanilla JS
 * against the wp.* globals, so the bytes the gate checks are the bytes that
 * ship — no npm, no wp-scripts, no dependency cache to rot.
 *
 * A failure at any step returns structured detail and **no zip**, so there is
 * nothing for `wp_block_install` to send. `wp_block_build_test` is the only
 * producer of `zip_path` and `wp_block_install` is the only consumer.
 *
 * ALWAYS DYNAMIC
 * --------------
 * The spec's non-goals say "No static block generation under any
 * circumstances." There is no code path in this file that emits a `save()`
 * returning markup: the scaffolded `edit.js` hard-codes `save: () => null`
 * and `block.json` always carries a `render` entry. A static block freezes its
 * output into every post that uses it, which makes the markup un-fixable after
 * the fact and makes `wp_verify` lie.
 *
 * PROCESS ISOLATION
 * -----------------
 * stdout of this process is the MCP stdio transport. `@wp-playground/cli` boots
 * worker threads and an Express server and is under no obligation to keep quiet,
 * and a PHP-wasm fatal is a real crash. So the Playground smoke test runs in a
 * **child `node` process** whose stdout/stderr are piped into a log string and
 * whose result comes back through a JSON file. Nothing it prints can corrupt the
 * MCP wire, and nothing it crashes can take the server down.
 *
 * NO `fetch` HERE
 * ---------------
 * Per the seam contract (context.ts note 3) `companion.ts` is the only HTTP
 * surface. The smoke test never speaks HTTP at all: it dispatches
 * `/wp/v2/block-types` and the block renderer through `rest_do_request()` inside
 * the sandbox, which is both faster and immune to auth plumbing.
 * ============================================================================
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerFactoryProvider } from './context.js';
import { XError, errInvalidInput } from './errors.js';
/* ========================================================================== */
/* Constants + environment knobs                                              */
/* ========================================================================== */
/** CONTRACT.md §5: `name` must match `^agent/[a-z0-9-]+$`. */
export const BLOCK_NAMESPACE = 'agent';
export const SLUG_RE = /^[a-z0-9-]+$/;
export const BLOCK_NAME_RE = /^agent\/[a-z0-9-]+$/;
/** CONTRACT.md §5: "total size ≤ 5 MB". */
export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_SYNTAX_TIMEOUT_MS = 30_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 5 * 60_000;
/** Ports the smoke sandbox may bind. Overridable so parallel agents do not collide. */
const DEFAULT_PORT_RANGE = [9440, 9449];
const BUILD_DIRNAME = '.x-agent-build';
/** Canonical plugin directory prefix: a block package installs as wp-content/plugins/agent-block-{slug}/. */
export const BLOCK_PLUGIN_PREFIX = 'agent-block-';
const here = path.dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(import.meta.url);
function envInt(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function portRange() {
    const raw = process.env.X_AGENT_SMOKE_PORT_RANGE;
    if (raw) {
        const m = /^(\d+)\s*-\s*(\d+)$/.exec(raw.trim());
        if (m)
            return [Number(m[1]), Number(m[2])];
    }
    return DEFAULT_PORT_RANGE;
}
/** Where scaffolds land when the caller does not name a directory. */
export function defaultWorkspace() {
    return process.env.X_AGENT_BLOCK_WORKSPACE || path.join(os.tmpdir(), 'x-agent-blocks');
}
/** `adm-zip` ships no `.d.ts`; this is the only place that knows that. */
export function loadAdmZip() {
    return localRequire('adm-zip');
}
/* ========================================================================== */
/* Template resolution                                                        */
/* ========================================================================== */
/**
 * `x-agent/templates/dynamic-block`. Resolved by walking up from this module so
 * it works from `src/` (tsx/vitest) and from a compiled `dist/` tree alike.
 */
export function templateDir() {
    const override = process.env.X_AGENT_BLOCK_TEMPLATE_DIR;
    if (override) {
        if (!fs.existsSync(path.join(override, 'block.json'))) {
            throw errInvalidInput(`X_AGENT_BLOCK_TEMPLATE_DIR=${override} does not contain a block.json.`, 'Point it at x-agent/templates/dynamic-block, or unset it.');
        }
        return override;
    }
    let dir = here;
    for (let i = 0; i < 8; i += 1) {
        const candidate = path.join(dir, 'templates', 'dynamic-block');
        if (fs.existsSync(path.join(candidate, 'block.json')))
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    throw new XError('internal', 'Could not locate templates/dynamic-block relative to the installed x-agent package.', 'Set X_AGENT_BLOCK_TEMPLATE_DIR to the absolute path of x-agent/templates/dynamic-block.');
}
/* ========================================================================== */
/* Interpolation                                                              */
/* ========================================================================== */
const PLACEHOLDER_RE = /\{\{([a-z0-9_]+)\}\}/g;
/**
 * Single-pass `{{key}}` substitution. Single pass on purpose: an attribute
 * default that happens to contain `{{...}}` must never be re-expanded.
 */
export function interpolate(template, vars) {
    const missing = new Set();
    const out = template.replace(PLACEHOLDER_RE, (whole, key) => {
        if (!(key in vars)) {
            missing.add(key);
            return whole;
        }
        return vars[key] ?? '';
    });
    if (missing.size) {
        throw new XError('internal', `Template placeholder(s) with no value: ${[...missing].join(', ')}.`, 'The template and the scaffolder disagree; this is an agent-side bug.');
    }
    return out;
}
/* ========================================================================== */
/* Validation                                                                 */
/* ========================================================================== */
const RESERVED_SLUGS = new Set(['build', 'src', 'node_modules', 'core', 'agent']);
export function assertSlug(slug) {
    if (typeof slug !== 'string' || slug.length === 0) {
        throw errInvalidInput('slug is required and must be a string.', 'Pass a lowercase slug like "pricing-card".');
    }
    // Traversal, separators and uppercase are all caught by the regex, but say so
    // explicitly: this is the check that keeps a scaffold inside its workspace.
    if (slug.includes('..') || slug.includes('/') || slug.includes('\\') || path.isAbsolute(slug)) {
        throw errInvalidInput(`slug "${slug}" contains a path separator or a traversal segment.`, 'The slug is a single path segment matching ^[a-z0-9-]+$ — it becomes the block directory name and the block name agent/{slug}.', { slug });
    }
    if (!SLUG_RE.test(slug)) {
        throw errInvalidInput(`slug "${slug}" does not match ^[a-z0-9-]+$.`, 'Use lowercase letters, digits and hyphens only — no uppercase, no underscores, no dots, no spaces.', { slug });
    }
    if (slug.startsWith('-') || slug.endsWith('-')) {
        throw errInvalidInput(`slug "${slug}" may not start or end with a hyphen.`, 'Use e.g. "pricing-card".', { slug });
    }
    if (RESERVED_SLUGS.has(slug)) {
        throw errInvalidInput(`slug "${slug}" is reserved.`, 'Pick a slug that names the block, e.g. "pricing-card".', { slug });
    }
    return slug;
}
const JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export function assertAttributes(input) {
    if (input === undefined || input === null)
        return [];
    if (!Array.isArray(input)) {
        throw errInvalidInput('attributes must be an array.', 'Pass [{name,type,control,default?,options?}, ...].');
    }
    const seen = new Set();
    return input.map((raw, i) => {
        const a = raw;
        if (!a || typeof a.name !== 'string' || !JS_IDENT_RE.test(a.name)) {
            throw errInvalidInput(`attributes[${i}].name must be a JavaScript identifier (it becomes a block.json attribute key).`, 'Use camelCase, e.g. "planName".');
        }
        if (seen.has(a.name))
            throw errInvalidInput(`attributes[${i}].name "${a.name}" is declared twice.`, 'Attribute names must be unique.');
        seen.add(a.name);
        const type = a.type ?? 'string';
        if (!['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(type)) {
            throw errInvalidInput(`attributes[${i}].type "${String(type)}" is not a block attribute type.`, 'Use string|number|integer|boolean|array|object.');
        }
        const control = a.control;
        if (control !== undefined && !['text', 'textarea', 'number', 'toggle', 'select', 'image'].includes(control)) {
            throw errInvalidInput(`attributes[${i}].control "${String(control)}" is unknown.`, 'Use text|textarea|number|toggle|select|image, or omit it to infer from type.');
        }
        if (control === 'image' && type !== 'string') {
            throw errInvalidInput(`attributes[${i}] uses control "image" but type "${String(type)}".`, 'An image attribute stores its URL: declare it type string.');
        }
        if (control === 'select' && (!Array.isArray(a.options) || a.options.length === 0)) {
            throw errInvalidInput(`attributes[${i}] uses control "select" but declares no options.`, 'Pass options: [{label, value}, ...].');
        }
        if (a.label !== undefined && typeof a.label !== 'string') {
            throw errInvalidInput(`attributes[${i}].label must be a string.`, 'It is the user-facing control label.');
        }
        if (a.help !== undefined && typeof a.help !== 'string') {
            throw errInvalidInput(`attributes[${i}].help must be a string.`, 'It is the user-facing help text under the control.');
        }
        const out = { name: a.name, type: type };
        if (control !== undefined)
            out.control = control;
        if (a.default !== undefined)
            out.default = a.default;
        if (a.options)
            out.options = a.options;
        if (a.label !== undefined)
            out.label = a.label;
        if (a.help !== undefined)
            out.help = a.help;
        return out;
    });
}
/* ========================================================================== */
/* Code generation helpers                                                    */
/* ========================================================================== */
export function kebab(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .toLowerCase()
        .replace(/^-+|-+$/g, '');
}
export function snake(name) {
    return kebab(name).replace(/-/g, '_');
}
function jsString(v) {
    return JSON.stringify(v);
}
/** A PHP literal for a JSON-ish default value. */
export function phpLiteral(value) {
    if (value === undefined || value === null)
        return 'null';
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'number')
        return Number.isFinite(value) ? String(value) : '0';
    if (typeof value === 'string')
        return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (Array.isArray(value))
        return `array( ${value.map(phpLiteral).join(', ')} )`;
    if (typeof value === 'object') {
        const parts = Object.entries(value).map(([k, v]) => `${phpLiteral(k)} => ${phpLiteral(v)}`);
        return `array( ${parts.join(', ')} )`;
    }
    return 'null';
}
function fallbackDefault(a) {
    if (a.default !== undefined)
        return a.default;
    switch (a.type) {
        case 'boolean':
            return false;
        case 'number':
        case 'integer':
            return 0;
        case 'array':
            return [];
        case 'object':
            return {};
        default:
            return '';
    }
}
/** block.json `attributes` object. Always an object, `{}` when none declared. */
export function attributesJson(attrs) {
    const out = {};
    for (const a of attrs) {
        const entry = { type: a.type };
        if (a.default !== undefined)
            entry.default = a.default;
        if (a.control === 'select' && a.options)
            entry.enum = a.options.map((o) => o.value);
        out[a.name] = entry;
    }
    return out;
}
/** Unique `$snake_case` PHP local per attribute. */
function phpLocals(attrs) {
    const used = new Set(['attributes', 'content', 'block', 'wrapper_attributes', 'is_editor_preview']);
    const map = new Map();
    for (const a of attrs) {
        let name = snake(a.name) || 'attr';
        if (used.has(name)) {
            let i = 2;
            while (used.has(`${name}_${i}`))
                i += 1;
            name = `${name}_${i}`;
        }
        used.add(name);
        map.set(a.name, name);
    }
    return map;
}
/**
 * The render intent, verbatim, as a PHPDoc comment body. `*\u200b/` is neutralised so
 * an intent that mentions a comment terminator cannot close the docblock early
 * and turn the scaffold into a parse error.
 */
function renderIntentComment(intent) {
    return String(intent)
        .replace(/\*\//g, '* /')
        .split(/\r?\n/)
        .map((line) => (line.trim() ? ` * ${line.replace(/\s+$/, '')}` : ' *'))
        .join('\n');
}
export function renderAttributeLocals(attrs) {
    if (attrs.length === 0)
        return '// This block declares no attributes.';
    const locals = phpLocals(attrs);
    return attrs
        .map((a) => {
        const v = locals.get(a.name);
        return `$${v} = isset( $attributes[${phpLiteral(a.name)}] ) ? $attributes[${phpLiteral(a.name)}] : ${phpLiteral(fallbackDefault(a))};`;
    })
        .join('\n');
}
export function renderAttributeOutput(attrs, cssClass, textdomain = 'agent') {
    if (attrs.length === 0) {
        return `\t<?php echo esc_html( $content ); ?>`;
    }
    const locals = phpLocals(attrs);
    return attrs
        .map((a) => {
        const v = `$${locals.get(a.name)}`;
        const cls = `${cssClass}__${kebab(a.name)}`;
        if (a.control === 'toggle' || a.type === 'boolean') {
            return `\t<?php if ( ${v} ) : ?><span class="${cls}"><?php echo esc_html__( ${phpLiteral(labelFor(a.name))}, ${phpLiteral(textdomain)} ); ?></span><?php endif; ?>`;
        }
        if (a.type === 'array' || a.type === 'object') {
            return `\t<div class="${cls}"><?php echo esc_html( (string) wp_json_encode( ${v} ) ); ?></div>`;
        }
        if (a.control === 'image') {
            return `\t<?php if ( '' !== (string) ${v} ) : ?><img class="${cls}" src="<?php echo esc_url( (string) ${v} ); ?>" alt="" /><?php endif; ?>`;
        }
        if (a.control === 'textarea') {
            return `\t<div class="${cls}"><?php echo wp_kses_post( wpautop( (string) ${v} ) ); ?></div>`;
        }
        return `\t<div class="${cls}"><?php echo esc_html( (string) ${v} ); ?></div>`;
    })
        .join('\n');
}
const CTRL_INDENT = '\t\t\t\t';
/** Image attributes (control `image`, string URL) get a media picker in the inspector. */
export function isImageAttribute(a) {
    return a.type === 'string' && a.control === 'image';
}
/**
 * The editor contract: the canvas previews render.php through
 * ServerSideRender, and EVERY setting lives in the inspector with a
 * user-facing label and help text. Structured attributes (arrays/objects
 * with no better control) get a JSON fallback the agent must replace with a
 * purpose-built control before install.
 */
export function controlKind(a) {
    if (a.control === 'image')
        return 'image';
    if (a.control === 'toggle' || a.type === 'boolean')
        return 'toggle';
    if (a.control === 'select')
        return 'select';
    if (a.type === 'array' && a.control === 'textarea')
        return 'lines';
    if (a.type === 'array' || a.type === 'object')
        return 'structured';
    if (a.control === 'number' || a.type === 'number' || a.type === 'integer')
        return 'number';
    if (a.control === 'textarea')
        return 'textarea';
    return 'text';
}
export function renderInspectorControls(attrs, textdomain) {
    const td = jsString(textdomain);
    if (attrs.length === 0) {
        return `${CTRL_INDENT}el( 'p', null, __( 'This block has no settings.', ${td} ) )`;
    }
    const P = `${CTRL_INDENT}\t`; // one level inside the control's props object
    return attrs
        .map((a) => {
        const label = jsString(a.label ?? labelFor(a.name));
        const set = (expr) => `setAttributes( { ${a.name}: ${expr} } )`;
        const helpLine = (fallback) => {
            const text = a.help ?? fallback;
            return text ? [`${P}help: __( ${jsString(text)}, ${td} ),`] : [];
        };
        switch (controlKind(a)) {
            case 'toggle':
                return [
                    `${CTRL_INDENT}el( ToggleControl, {`,
                    `${P}label: __( ${label}, ${td} ),`,
                    ...helpLine(),
                    `${P}checked: !! attributes.${a.name},`,
                    `${P}onChange: ( value ) => ${set('value')},`,
                    `${CTRL_INDENT}} )`,
                ].join('\n');
            case 'select': {
                const options = (a.options ?? []).map((o) => `{ label: __( ${jsString(o.label)}, ${td} ), value: ${jsString(o.value)} }`).join(', ');
                return [
                    `${CTRL_INDENT}el( SelectControl, {`,
                    `${P}label: __( ${label}, ${td} ),`,
                    ...helpLine(),
                    `${P}value: attributes.${a.name},`,
                    `${P}options: [ ${options} ],`,
                    `${P}onChange: ( value ) => ${set('value')},`,
                    `${CTRL_INDENT}} )`,
                ].join('\n');
            }
            case 'lines':
                return [
                    `${CTRL_INDENT}el( TextareaControl, {`,
                    `${P}label: __( ${label}, ${td} ),`,
                    ...helpLine('One item per line.'),
                    `${P}value: ( attributes.${a.name} ?? [] ).join( '\\n' ),`,
                    `${P}onChange: ( value ) => ${set("value.split( '\\n' )")},`,
                    `${CTRL_INDENT}} )`,
                ].join('\n');
            case 'structured':
                // The fallback a site editor should never meet: replace with a
                // purpose-built control (a row per item, add/remove) before install.
                return [
                    `${CTRL_INDENT}el( StructuredFallbackControl, {`,
                    `${P}label: __( ${label}, ${td} ),`,
                    ...(a.help ? [`${P}help: __( ${jsString(a.help)}, ${td} ),`] : []),
                    `${P}value: attributes.${a.name},`,
                    `${P}onChange: ( value ) => ${set('value')},`,
                    `${CTRL_INDENT}} )`,
                ].join('\n');
            case 'image':
                // The canvas already shows the image (it is in the server render);
                // the inspector only needs pick / replace / remove.
                return [
                    `${CTRL_INDENT}el( MediaUploadCheck, null, el( MediaUpload, {`,
                    `${P}allowedTypes: [ 'image' ],`,
                    `${P}onSelect: ( media ) => ${set('media.url')},`,
                    `${P}render: ( { open } ) => el(`,
                    `${P}\t'div',`,
                    `${P}\tnull,`,
                    `${P}\tel(`,
                    `${P}\t\tButton,`,
                    `${P}\t\t{ variant: 'secondary', onClick: open },`,
                    `${P}\t\tattributes.${a.name} ? __( ${jsString(`Replace: ${a.label ?? labelFor(a.name)}`)}, ${td} ) : __( ${jsString(`Select: ${a.label ?? labelFor(a.name)}`)}, ${td} )`,
                    `${P}\t),`,
                    `${P}\t!! attributes.${a.name} && el(`,
                    `${P}\t\tButton,`,
                    `${P}\t\t{ variant: 'link', isDestructive: true, onClick: () => ${set("''")} },`,
                    `${P}\t\t__( 'Remove', ${td} )`,
                    `${P}\t)`,
                    `${P}),`,
                    `${CTRL_INDENT}} ) )`,
                ].join('\n');
            case 'number': {
                const cast = a.type === 'integer' ? 'parseInt( value, 10 )' : 'Number( value )';
                return [
                    `${CTRL_INDENT}el( TextControl, {`,
                    `${P}type: 'number',`,
                    `${P}label: __( ${label}, ${td} ),`,
                    ...helpLine(),
                    `${P}value: attributes.${a.name},`,
                    `${P}onChange: ( value ) => ${set(`value === '' ? undefined : ${cast}`)},`,
                    `${CTRL_INDENT}} )`,
                ].join('\n');
            }
            case 'textarea':
                return [
                    `${CTRL_INDENT}el( TextareaControl, {`,
                    `${P}label: __( ${label}, ${td} ),`,
                    ...helpLine(),
                    `${P}value: attributes.${a.name},`,
                    `${P}onChange: ( value ) => ${set('value')},`,
                    `${CTRL_INDENT}} )`,
                ].join('\n');
            default:
                return [
                    `${CTRL_INDENT}el( TextControl, {`,
                    `${P}label: __( ${label}, ${td} ),`,
                    ...helpLine(),
                    `${P}value: attributes.${a.name},`,
                    `${P}onChange: ( value ) => ${set('value')},`,
                    `${CTRL_INDENT}} )`,
                ].join('\n');
        }
    })
        .join(',\n');
}
/** wp.* destructures for edit.js — exactly the components the generated controls use. */
export function renderEditorGlobals(attrs) {
    const kinds = new Set(attrs.map(controlKind));
    const blockEditor = ['useBlockProps', 'InspectorControls'];
    if (kinds.has('image'))
        blockEditor.push('MediaUpload', 'MediaUploadCheck');
    const components = ['PanelBody'];
    if (kinds.has('text') || kinds.has('number'))
        components.push('TextControl');
    if (kinds.has('textarea') || kinds.has('lines') || kinds.has('structured'))
        components.push('TextareaControl');
    if (kinds.has('toggle'))
        components.push('ToggleControl');
    if (kinds.has('select'))
        components.push('SelectControl');
    if (kinds.has('image'))
        components.push('Button');
    const lines = [
        `\tconst { ${blockEditor.join(', ')} } = wp.blockEditor;`,
        `\tconst { ${components.join(', ')} } = wp.components;`,
    ];
    if (kinds.has('structured'))
        lines.push(`\tconst { useState } = wp.element;`);
    return lines.join('\n');
}
/** Helper components for edit.js, emitted only when a control needs them. */
export function renderEditorHelpers(attrs, textdomain) {
    if (!attrs.some((a) => controlKind(a) === 'structured'))
        return '';
    const td = jsString(textdomain);
    return `
	/**
	 * FALLBACK for a structured attribute — a site editor should never meet raw
	 * JSON. Replace its usage below with a purpose-built control (one field per
	 * property, add/remove rows) before this block is installed.
	 */
	function StructuredFallbackControl( { label, help, value, onChange } ) {
		const [ text, setText ] = useState( () => JSON.stringify( value ?? null, null, 2 ) );
		const [ invalid, setInvalid ] = useState( false );
		return el( TextareaControl, {
			label: label,
			help: invalid ? __( 'Not applied yet — the value is not valid.', ${td} ) : help,
			value: text,
			onChange: ( next ) => {
				setText( next );
				try {
					onChange( JSON.parse( next ) );
					setInvalid( false );
				} catch ( e ) {
					setInvalid( true );
				}
			},
		} );
	}
`;
}
function labelFor(name) {
    const words = kebab(name).split('-').filter(Boolean);
    if (words.length === 0)
        return name;
    const first = words[0] ?? '';
    return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}
/* ========================================================================== */
/* Scaffold                                                                   */
/* ========================================================================== */
export const SCAFFOLD_FILES = ['block.json', 'render.php', 'edit.js', 'edit.asset.php'];
export function scaffold(input) {
    const slug = assertSlug(input.slug);
    const attrs = assertAttributes(input.attributes);
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : labelFor(slug);
    const renderIntent = typeof input.render_intent === 'string' ? input.render_intent : '';
    if (!renderIntent.trim()) {
        throw errInvalidInput('render_intent is required.', 'Describe in plain language what render.php must output; it is embedded in the file as the comment you then implement against.');
    }
    const parent = path.resolve(input.dir ?? defaultWorkspace());
    const dir = path.join(parent, slug);
    if (path.relative(parent, dir).startsWith('..')) {
        throw errInvalidInput(`Refusing to scaffold outside ${parent}.`, 'Check the slug and dir arguments.');
    }
    if (fs.existsSync(dir)) {
        const notEmpty = fs.readdirSync(dir).length > 0;
        if (notEmpty && !input.force) {
            throw errInvalidInput(`${dir} already exists and is not empty.`, 'Pass force:true to overwrite it, or scaffold into a different dir.', { dir });
        }
        if (notEmpty)
            fs.rmSync(dir, { recursive: true, force: true });
    }
    const textdomain = `${BLOCK_NAMESPACE}-${slug}`;
    const cssClass = `${BLOCK_NAMESPACE}-${slug}`;
    const version = input.version ?? '0.1.0';
    // User-facing inserter copy: never toolchain vocabulary. The caller should
    // supply real copy; the title is the honest fallback.
    const description = input.description ?? title;
    const vars = {
        slug,
        title,
        description,
        version,
        textdomain,
        css_class: cssClass,
        attributes_json: indentJson(attributesJson(attrs), '\t'),
        render_intent_comment: renderIntentComment(renderIntent),
        attribute_locals: renderAttributeLocals(attrs),
        attribute_output: renderAttributeOutput(attrs, cssClass, textdomain),
        inspector_controls: renderInspectorControls(attrs, textdomain),
        editor_globals: renderEditorGlobals(attrs),
        editor_helpers: renderEditorHelpers(attrs, textdomain),
    };
    const tpl = templateDir();
    const written = [];
    fs.mkdirSync(dir, { recursive: true });
    for (const rel of SCAFFOLD_FILES) {
        const src = path.join(tpl, rel);
        if (!fs.existsSync(src)) {
            throw new XError('internal', `Template file missing: ${rel}`, 'The x-agent templates/dynamic-block directory is incomplete.');
        }
        const out = interpolate(fs.readFileSync(src, 'utf8'), vars);
        const dest = path.join(dir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, out, 'utf8');
        written.push(rel);
    }
    // Interactivity + stylesheet rungs: generated files referenced from
    // block.json as UNBUILT roots — a viewScript IIFE and a viewScriptModule
    // ES module need no bundling (WordPress's import map resolves
    // @wordpress/interactivity at runtime), so the build pipeline is untouched.
    const mode = input.interactivity ?? 'none';
    {
        const blockJsonPath0 = path.join(dir, 'block.json');
        const blockJson = JSON.parse(fs.readFileSync(blockJsonPath0, 'utf8'));
        if (input.stylesheet) {
            fs.writeFileSync(path.join(dir, 'style.css'), stylesheetSource(cssClass, slug), 'utf8');
            blockJson.style = 'file:./style.css';
            written.push('style.css');
        }
        if (mode === 'view-script') {
            fs.writeFileSync(path.join(dir, 'view.js'), viewScriptSource(slug), 'utf8');
            blockJson.viewScript = 'file:./view.js';
            written.push('view.js');
        }
        else if (mode === 'interactivity-api') {
            fs.writeFileSync(path.join(dir, 'view.js'), interactivityViewSource(slug), 'utf8');
            blockJson.viewScriptModule = 'file:./view.js';
            const supports = (blockJson.supports ?? {});
            supports.interactivity = true;
            blockJson.supports = supports;
        }
        if (input.stylesheet || mode !== 'none') {
            fs.writeFileSync(blockJsonPath0, JSON.stringify(blockJson, null, '\t') + '\n', 'utf8');
        }
    }
    // Fail loudly rather than ship a block.json that WordPress will reject.
    const blockJsonPath = path.join(dir, 'block.json');
    let parsedBlockJson;
    try {
        parsedBlockJson = JSON.parse(fs.readFileSync(blockJsonPath, 'utf8'));
    }
    catch (e) {
        throw new XError('internal', `The scaffolded block.json is not valid JSON: ${e.message}`, 'This is an agent-side template bug.');
    }
    if (parsedBlockJson.name !== `${BLOCK_NAMESPACE}/${slug}` || parsedBlockJson.apiVersion !== 3 || typeof parsedBlockJson.render !== 'string') {
        throw new XError('internal', 'The scaffolded block.json is missing apiVersion 3, the agent/ name, or the render entry.', 'This is an agent-side template bug.');
    }
    return { dir, name: `${BLOCK_NAMESPACE}/${slug}`, files: written.sort() };
}
function indentJson(value, indent) {
    return JSON.stringify(value, null, '\t')
        .split('\n')
        .map((line, i) => (i === 0 ? line : indent + line))
        .join('\n');
}
const FILE_REF_KEYS = ['render', 'editorScript', 'script', 'viewScript', 'viewScriptModule', 'editorStyle', 'style', 'viewStyle'];
/* ========================================================================== */
/* Interactivity + stylesheet generation (M6)                                 */
/* ========================================================================== */
/**
 * Vanilla viewScript template. Progressive enhancement only: it finds every
 * front-end instance of the block, stamps a readiness marker the build-test
 * front smoke asserts, and leaves a single place to hang behavior.
 */
export function viewScriptSource(slug) {
    return `/**
 * Front-end behavior for agent/${slug} — the 'view-script' rung.
 *
 * Vanilla JS, no build, no framework. Enhance progressively: everything the
 * block DOES must work without this file; everything here is polish
 * (submit-over-fetch, toggles, purely client-side state). State that must
 * flow server->client is the 'interactivity-api' rung instead.
 */
( function () {
	'use strict';

	function enhance( el ) {
		// Marker asserted by wp_block_build_test's front smoke. Keep it.
		el.dataset.xAgentView = 'ready';

		// Implement the block's front-end behavior here.
	}

	function boot() {
		document.querySelectorAll( '.wp-block-agent-${slug}' ).forEach( enhance );
	}

	if ( 'loading' === document.readyState ) {
		document.addEventListener( 'DOMContentLoaded', boot );
	} else {
		boot();
	}
} )();
`;
}
/**
 * Interactivity API store template. A plain ES module: WordPress registers
 * viewScriptModule entries in its import map, so the bare
 * @wordpress/interactivity import resolves at runtime with no bundling.
 * render.php must carry data-wp-interactive="agent/${'{slug}'}" and the
 * directives that consume this store.
 */
export function interactivityViewSource(slug) {
    return `/**
 * Interactivity API store for agent/${slug} — the 'interactivity-api' rung.
 *
 * Use this rung only when state flows server->client (hydration via
 * wp_interactivity_state in render.php, context shared across blocks).
 * Purely client-side polish belongs on the cheaper 'view-script' rung.
 */
import { store, getContext } from '@wordpress/interactivity';

store( 'agent/${slug}', {
	state: {
		// Server-hydrated via wp_interactivity_state( 'agent/${slug}', [ ... ] ) in render.php.
	},
	actions: {
		// data-wp-on--click="actions.example" in render.php reaches here.
		example() {
			const context = getContext();
			context.open = ! context.open;
		},
	},
} );
`;
}
/**
 * Block-owned stylesheet template — the LAST rung of the expression ladder.
 * Token custom properties only (R11): a literal that a token can express is
 * flagged by the build test.
 */
export function stylesheetSource(cssClass, slug) {
    return `/**
 * Block-owned styles for agent/${slug} — rung 6 of the expression ladder.
 *
 * R11: build EXCLUSIVELY on the instance's token custom properties
 * (var(--wp--preset--color--*), --wp--preset--spacing--*, --wp--preset--font-size--*).
 * A hardcoded color or size that a token can express is a defect the build
 * test warns about. Layout mechanics (display, grid, gap wiring) are fine.
 */
.wp-block-agent-${slug} {
	/* Example, spending tokens only:
	display: grid;
	gap: var( --wp--preset--spacing--30 );
	*/
}
`;
}
/**
 * R11 lint: hardcoded color/size literals in style.css that are not spent
 * through a token custom property. Warnings, not failures — layout mechanics
 * legitimately use small px values; the agent reviews each one.
 */
export function styleLintWarnings(dir) {
    const p = path.join(dir, 'style.css');
    if (!fs.existsSync(p))
        return [];
    const warnings = [];
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    lines.forEach((text, i) => {
        const trimmed = text.trim();
        // WordPress CSS style puts spaces inside the parens — `var( --wp--preset--… )` —
        // and the scaffold generator emits exactly that. A substring test for the
        // unspaced form flagged every correctly-tokenized line in the file.
        if (trimmed.startsWith('*') || trimmed.startsWith('/*') || /var\(\s*--wp--preset/.test(trimmed))
            return;
        const hex = /#[0-9a-fA-F]{3,8}\b/.exec(text);
        const size = /(?<![\w-])\d+(?:\.\d+)?(?:px|rem|em)\b/.exec(text);
        const hit = hex?.[0] ?? size?.[0];
        if (hit)
            warnings.push({ line: i + 1, literal: hit, text: trimmed.slice(0, 120) });
    });
    return warnings;
}
export function readBlockMetadata(dir) {
    const p = path.join(dir, 'block.json');
    if (!fs.existsSync(p)) {
        throw errInvalidInput(`${dir} has no block.json.`, 'Pass the directory returned by wp_block_scaffold.', { dir });
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch (e) {
        throw errInvalidInput(`${p} is not valid JSON: ${e.message}`, 'Fix block.json and run wp_block_build_test again.');
    }
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (!BLOCK_NAME_RE.test(name)) {
        throw errInvalidInput(`block.json name "${name}" does not match ^agent/[a-z0-9-]+$.`, 'The companion install policy pins the agent/ namespace; re-scaffold rather than renaming by hand.');
    }
    const render = typeof raw.render === 'string' ? raw.render : '';
    if (!render) {
        throw errInvalidInput('block.json has no "render" entry.', 'This factory only produces DYNAMIC blocks. A block without render is a static block, and static blocks are never generated.');
    }
    const fileRefs = [];
    for (const key of FILE_REF_KEYS) {
        const v = raw[key];
        const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
        for (const item of list) {
            if (typeof item === 'string' && item.startsWith('file:')) {
                fileRefs.push(item.slice('file:'.length).replace(/^\.\//, ''));
            }
        }
    }
    return { name, version: typeof raw.version === 'string' ? raw.version : '0.1.0', render, fileRefs, raw };
}
/** Files that belong in the shipped package, relative to the block root. */
export function packageFileList(dir, meta) {
    const files = new Set(['block.json']);
    for (const ref of meta.fileRefs)
        files.add(ref);
    // `index.asset.php` is not referenced by block.json but WordPress reads it
    // next to every `file:` script to learn its dependencies and version.
    for (const ref of meta.fileRefs) {
        if (ref.endsWith('.js')) {
            const asset = ref.replace(/\.js$/, '.asset.php');
            if (fs.existsSync(path.join(dir, asset)))
                files.add(asset);
        }
    }
    for (const extra of ['readme.txt', 'style.css']) {
        if (fs.existsSync(path.join(dir, extra)))
            files.add(extra);
    }
    return [...files].sort();
}
/**
 * Copy exactly the bytes that will ship into `<dir>/.x-agent-build/plugin/<slug>`,
 * alongside the package's plugin main file. The staged directory IS the plugin
 * that ships: the smoke test mounts it under wp-content/plugins and the zip is
 * built from it, so the sandbox exercises byte-for-byte what gets installed.
 */
export function stagePackage(dir) {
    const meta = readBlockMetadata(dir);
    const slug = meta.name.slice(`${BLOCK_NAMESPACE}/`.length);
    const pluginDirName = `${BLOCK_PLUGIN_PREFIX}${slug}`;
    const stageDir = path.join(dir, BUILD_DIRNAME, 'plugin');
    const blockDir = path.join(stageDir, slug);
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(blockDir, { recursive: true });
    const files = packageFileList(dir, meta);
    const missing = [];
    for (const rel of files) {
        const src = path.join(dir, rel);
        if (!fs.existsSync(src)) {
            missing.push(rel);
            continue;
        }
        const dest = path.join(blockDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    }
    fs.writeFileSync(path.join(stageDir, `${pluginDirName}.php`), pluginMainSource(slug, meta), 'utf8');
    return { stageDir, blockDir, slug, pluginDirName, meta, files, missing };
}
/**
 * The package's plugin main file. A standard WordPress plugin header plus one
 * `register_block_type()` on `init` — the package installs, activates,
 * deactivates and deletes exactly like any other plugin, and shows up in
 * plugins.php under its own name.
 */
export function pluginMainSource(slug, meta) {
    const title = typeof meta.raw.title === 'string' && meta.raw.title ? meta.raw.title : meta.name;
    const version = meta.version || '0.1.0';
    return `<?php
/**
 * Plugin Name:       Agent block: ${title.replace(/\*\//g, '')}
 * Description:       Dynamic block ${meta.name}, fabricated and gated by the x-agent block factory (wp_block_build_test) and installed as a standard WordPress plugin.
 * Version:           ${version}
 * Requires at least: 6.5
 * Requires PHP:      8.1
 * License:           GPL-2.0-or-later
 */

defined( 'ABSPATH' ) || exit;

add_action( 'init', static function () { register_block_type( __DIR__ . '/${slug}' ); } );
`;
}
/**
 * Read a zip back and check it against every structural rule the companion
 * enforces in `POST /blocks/install` (CONTRACT.md §5). Run on our own output so
 * a 422 `block_policy` can never be the first time we hear about a problem.
 */
export function inspectPackage(zipPath) {
    const Zip = loadAdmZip();
    const zip = new Zip(zipPath);
    const rawEntries = zip.getEntries();
    const reasons = [];
    const entries = [];
    let uncompressed = 0;
    for (const e of rawEntries) {
        if (e.isDirectory)
            continue;
        entries.push({ name: e.entryName, bytes: e.header.size });
        uncompressed += e.header.size;
    }
    for (const e of entries) {
        const n = e.name;
        if (n.startsWith('/') || /^[A-Za-z]:[\\/]/.test(n) || n.startsWith('\\'))
            reasons.push(`absolute path in zip entry: ${n}`);
        if (n.split(/[\\/]/).includes('..'))
            reasons.push(`traversal segment in zip entry: ${n}`);
    }
    const zipBytes = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
    if (zipBytes > MAX_PACKAGE_BYTES)
        reasons.push(`package is ${zipBytes} bytes, over the 5 MB install limit`);
    if (uncompressed > MAX_PACKAGE_BYTES)
        reasons.push(`package expands to ${uncompressed} bytes, over the 5 MB install limit`);
    // Canonical plugin zip: exactly one top-level dir named agent-block-{slug},
    // holding the plugin main file and the block directory.
    const tops = new Set(entries.map((e) => (e.name.includes('/') ? e.name.split('/')[0] : '')));
    let root = null;
    if (tops.size === 1 && [...tops][0] !== '') {
        root = [...tops][0];
    }
    else {
        reasons.push(`zip has ${tops.size} top-level entries (${[...tops].map((t) => t || '(flat)').join(', ')}); a package is exactly one plugin directory`);
    }
    let blockJson = null;
    if (root !== null) {
        if (!root.startsWith(BLOCK_PLUGIN_PREFIX)) {
            reasons.push(`zip root "${root}" does not start with "${BLOCK_PLUGIN_PREFIX}"; a block package is a standard plugin directory agent-block-{slug}/`);
        }
        const slug = root.slice(BLOCK_PLUGIN_PREFIX.length);
        const prefix = `${root}/`;
        const mainEntry = rawEntries.find((e) => e.entryName === `${prefix}${root}.php`);
        if (!mainEntry) {
            reasons.push(`${prefix}${root}.php (the plugin main file) is not in the zip`);
        }
        else if (!/^\s*\*?\s*Plugin Name\s*:/m.test(mainEntry.getData().toString('utf8'))) {
            reasons.push(`${prefix}${root}.php has no "Plugin Name:" header; the package must be an installable WordPress plugin`);
        }
        const blockPrefix = `${prefix}${slug}/`;
        const blockJsonEntry = entries.find((e) => e.name === `${blockPrefix}block.json`);
        if (!blockJsonEntry) {
            reasons.push(`block.json is not at ${blockPrefix} inside the zip`);
        }
        else {
            const data = rawEntries.find((e) => e.entryName === blockJsonEntry.name).getData().toString('utf8');
            try {
                blockJson = JSON.parse(data);
            }
            catch (e) {
                reasons.push(`block.json does not parse: ${e.message}`);
            }
        }
        if (blockJson) {
            const name = typeof blockJson.name === 'string' ? blockJson.name : '';
            if (!BLOCK_NAME_RE.test(name))
                reasons.push(`block.json name "${name}" does not match ^agent/[a-z0-9-]+$`);
            if (name && name !== `${BLOCK_NAMESPACE}/${slug}`) {
                reasons.push(`block.json name "${name}" does not match the plugin directory "${root}"`);
            }
            const render = blockJson.render;
            if (typeof render !== 'string' || !render.startsWith('file:')) {
                reasons.push('block.json has no "render" entry pointing at a file (static blocks are never produced)');
            }
            const present = new Set(entries.map((e) => e.name));
            for (const key of FILE_REF_KEYS) {
                const v = blockJson[key];
                const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
                for (const item of list) {
                    if (typeof item !== 'string' || !item.startsWith('file:'))
                        continue;
                    const rel = item.slice('file:'.length).replace(/^\.\//, '');
                    if (!present.has(`${blockPrefix}${rel}`))
                        reasons.push(`block.json references "${item}" but ${blockPrefix}${rel} is not in the zip`);
                }
            }
        }
    }
    return { ok: reasons.length === 0, reasons, entries, zip_bytes: zipBytes, uncompressed_bytes: uncompressed, root, block_json: blockJson };
}
/** Zip `<dir>` as a single top-level directory named `rootName` (defaults to the directory's own name). */
export function packageBlock(blockDir, zipPath, rootName) {
    const Zip = loadAdmZip();
    const zip = new Zip();
    const root = rootName ?? path.basename(blockDir);
    const walk = (abs, rel) => {
        for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const childAbs = path.join(abs, entry.name);
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory())
                walk(childAbs, childRel);
            else if (entry.isFile())
                zip.addFile(`${root}/${childRel}`, fs.readFileSync(childAbs));
        }
    };
    walk(blockDir, '');
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    zip.writeZip(zipPath);
    return zipPath;
}
export function run(cmd, args, opts) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(cmd, args, {
            cwd: opts.cwd,
            env: { ...process.env, ...(opts.env ?? {}), CI: '1', NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const cap = (s, chunk) => (s.length > 200_000 ? s : s + chunk);
        child.stdout.on('data', (d) => (stdout = cap(stdout, d.toString('utf8'))));
        child.stderr.on('data', (d) => (stderr = cap(stderr, d.toString('utf8'))));
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, opts.timeoutMs);
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ code: null, signal: null, stdout, stderr: stderr + String(e), timedOut, ms: Date.now() - started });
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - started });
        });
    });
}
/**
 * The no-build gate: parse every script block.json ships, exactly as shipped.
 * Classic scripts (editorScript, script, viewScript) are checked with
 * `node --check`; a viewScriptModule is checked as an ES module (the same
 * check against a `.mjs` copy, so `import` syntax is not a false failure).
 *
 * This replaced `npm ci` + `wp-scripts build` (decision 2026-08-26): the
 * scaffold is vanilla JS against the wp.* globals, so there is nothing to
 * compile — and therefore no dependency cache to rot and no registry to reach.
 */
export async function syntaxGate(dir, opts = {}) {
    const started = Date.now();
    const meta = readBlockMetadata(dir);
    const raw = meta.raw;
    const refOf = (v) => typeof v === 'string' && v.startsWith('file:') ? v.slice('file:'.length).replace(/^\.\//, '') : null;
    const entries = [];
    for (const key of ['editorScript', 'script', 'viewScript']) {
        const rel = refOf(raw[key]);
        if (rel && rel.endsWith('.js'))
            entries.push({ rel, module: false });
    }
    const mod = refOf(raw.viewScriptModule);
    if (mod && mod.endsWith('.js'))
        entries.push({ rel: mod, module: true });
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SYNTAX_TIMEOUT_MS;
    const problems = [];
    for (const { rel, module } of entries) {
        const abs = path.join(dir, rel);
        if (!fs.existsSync(abs)) {
            problems.push(`${rel}: named in block.json but missing from the scaffold`);
            continue;
        }
        // ES-module syntax needs the .mjs extension for node to parse it as ESM.
        const target = module ? path.join(os.tmpdir(), `x-agent-gate-${crypto.randomBytes(6).toString('hex')}.mjs`) : abs;
        if (module)
            fs.copyFileSync(abs, target);
        try {
            const res = await run(process.execPath, ['--check', target], { cwd: dir, timeoutMs });
            if (res.code !== 0) {
                const detail = (res.stderr || res.stdout).trim().split('\n').slice(0, 12).join('\n');
                problems.push(`${rel}:\n${detail.replaceAll(target, rel)}`);
            }
        }
        finally {
            if (module)
                fs.rmSync(target, { force: true });
        }
    }
    return { ok: problems.length === 0, log: problems.join('\n\n'), ms: Date.now() - started };
}
function tail(s, max = 8000) {
    const t = s.trim();
    return t.length > max ? `…\n${t.slice(-max)}` : t;
}
/* ========================================================================== */
/* Smoke test — real Playground boot, in a child process                      */
/* ========================================================================== */
/** Locate `@wp-playground/cli` without depending on this package's node_modules. */
export function resolvePlaygroundCli() {
    const override = process.env.X_AGENT_PLAYGROUND_CLI;
    if (override && fs.existsSync(override))
        return override;
    try {
        return localRequire.resolve('@wp-playground/cli');
    }
    catch {
        /* fall through to the directory walk */
    }
    let dir = here;
    for (let i = 0; i < 8; i += 1) {
        for (const rel of ['node_modules/@wp-playground/cli/index.js', 'tools/node_modules/@wp-playground/cli/index.js']) {
            const candidate = path.join(dir, rel);
            if (fs.existsSync(candidate))
                return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    throw new XError('smoke_failed', '@wp-playground/cli is not installed anywhere this package can reach, so the block cannot be smoke-tested.', 'Install @wp-playground/cli (e.g. `cd tools && npm install`) or point X_AGENT_PLAYGROUND_CLI at its index.js. Nothing is packaged without a passing smoke test.');
}
export async function freePort(preferred) {
    const check = (p) => new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(p);
    });
    if (preferred) {
        if (await check(preferred))
            return preferred;
        throw new XError('smoke_failed', `Port ${preferred} is busy.`, 'Pick another port, or leave `port` unset and let the factory choose.');
    }
    const [lo, hi] = portRange();
    for (let p = lo; p <= hi; p += 1)
        if (await check(p))
            return p;
    throw new XError('smoke_failed', `No free port in ${lo}-${hi} for the smoke sandbox.`, 'Stop a stale Playground instance, or set X_AGENT_SMOKE_PORT_RANGE to a free range like "9460-9469".');
}
/**
 * The child-process runner, written to disk next to the staged package.
 *
 * Deliberately dumb: it boots Playground, runs two PHP snippets that this module
 * generated, and hands back raw text. All parsing happens back in the parent —
 * a runner with no regexes in it is a runner that cannot be wrong about a PHP
 * fatal. It is a separate process because this process's stdout is the MCP
 * transport and Playground is under no obligation to keep quiet on it, and
 * because a PHP-wasm fatal is a real crash that must not reach the server.
 */
export const SMOKE_RUNNER_SOURCE = [
    "import fs from 'node:fs';",
    "import { pathToFileURL } from 'node:url';",
    '',
    "const cfg = JSON.parse( fs.readFileSync( process.argv[ 2 ], 'utf8' ) );",
    'const outPath = process.argv[ 3 ];',
    "const result = { booted: false, boot_ms: 0, error: '' };",
    'const write = () => { try { fs.writeFileSync( outPath, JSON.stringify( result ) ); } catch {} };',
    '',
    'async function probe( server, code ) {',
    '\ttry {',
    '\t\tconst r = await server.playground.run( { code } );',
    "\t\treturn { text: String( r.text ?? '' ), threw: false, error_text: '', exit_code: r.exitCode ?? 0 };",
    '\t} catch ( e ) {',
    "\t\tconst text = String( e?.response?.text ?? '' );",
    '\t\treturn {',
    '\t\t\ttext,',
    '\t\t\tthrew: true,',
    "\t\t\terror_text: text || String( e?.message ?? e ),",
    '\t\t\texit_code: e?.response?.exitCode ?? null,',
    '\t\t};',
    '\t}',
    '}',
    '',
    'let server;',
    'try {',
    '\tconst { runCLI } = await import( pathToFileURL( cfg.cliEntry ).href );',
    '\tconst t0 = Date.now();',
    '\tserver = await runCLI( {',
    "\t\tcommand: 'server',",
    '\t\tphp: cfg.php,',
    '\t\twp: cfg.wp,',
    '\t\tport: cfg.port,',
    '\t\tlogin: false,',
    "\t\tverbosity: 'quiet',",
    "\t\tmount: [ { hostPath: cfg.pluginDir, vfsPath: '/wordpress/wp-content/plugins/' + cfg.pluginSlug } ],",
    '\t\tblueprint: {',
    '\t\t\tpreferredVersions: { php: cfg.php, wp: cfg.wp },',
    '\t\t\tsteps: [ {',
    "\t\t\t\tstep: 'activatePlugin',",
    "\t\t\t\tpluginPath: cfg.pluginSlug + '/' + ( cfg.pluginFile || cfg.pluginSlug + '.php' ),",
    '\t\t\t\tpluginName: cfg.pluginSlug,',
    '\t\t\t} ],',
    '\t\t},',
    '\t} );',
    '\tresult.booted = true;',
    '\tresult.boot_ms = Date.now() - t0;',
    '',
    '\tif ( cfg.registerCode ) result.register = await probe( server, cfg.registerCode );',
    '\tif ( cfg.renderCode ) result.render = await probe( server, cfg.renderCode );',
    '\tif ( cfg.probes ) {',
    '\t\tresult.probes = {};',
    '\t\tfor ( const [ id, code ] of Object.entries( cfg.probes ) ) {',
    '\t\t\tresult.probes[ id ] = await probe( server, code );',
    '\t\t}',
    '\t}',
    '',
    '\t// Front smoke (M6): publish the markup, load the real front end in a',
    '\t// browser, and report console errors + asset presence. This is the one',
    '\t// place the runner parses probe text — a tag split, not a regex.',
    '\tif ( cfg.front ) {',
    '\t\ttry {',
    '\t\t\tconst pub = await probe( server, cfg.front.publishCode );',
    '\t\t\tconst info = JSON.parse( String( pub.text ?? \'\' ).split( cfg.front.tag )[ 1 ] ?? \'{}\' );',
    '\t\t\tconst pw = await import( pathToFileURL( cfg.front.playwrightEntry ).href );',
    '\t\t\tconst chromium = pw.chromium ?? pw.default?.chromium;',
    '\t\t\tconst browser = await chromium.launch( { headless: true } );',
    '\t\t\tconst page = await browser.newPage();',
    '\t\t\tconst consoleErrors = [];',
    "\t\t\tpage.on( 'console', ( m ) => { if ( m.type() === 'error' ) consoleErrors.push( m.text() ); } );",
    "\t\t\tpage.on( 'pageerror', ( e ) => consoleErrors.push( 'pageerror: ' + e.message ) );",
    "\t\t\tawait page.goto( info.url, { waitUntil: 'networkidle', timeout: 60000 } );",
    '\t\t\tconst checks = await page.evaluate( ( slug ) => ( {',
    '\t\t\t\tstyle_enqueued: Boolean( document.querySelector( \'link[id^="agent-\' + slug + \'"],style[id^="agent-\' + slug + \'"]\' ) ),',
    '\t\t\t\tview_ready: Boolean( document.querySelector( \'[data-x-agent-view="ready"]\' ) ),',
    '\t\t\t\tmodule_present: Boolean( document.querySelector( \'script[type="module"][src*="\' + slug + \'"]\' ) ),',
    '\t\t\t\tblock_present: Boolean( document.querySelector( \'.wp-block-agent-\' + slug ) ),',
    '\t\t\t} ), cfg.front.slug );',
    '\t\t\tawait browser.close();',
    '\t\t\tresult.front = { url: info.url, console_errors: consoleErrors, ...checks };',
    '\t\t} catch ( e ) {',
    "\t\t\tresult.front = { error: String( e?.message ?? e ) };",
    '\t\t}',
    '\t}',
    '} catch ( e ) {',
    "\tresult.error = String( e?.stack ?? e?.message ?? e );",
    '} finally {',
    '\ttry { if ( server ) await server[ Symbol.asyncDispose ](); } catch {}',
    '\twrite();',
    '\tprocess.exit( 0 );',
    '}',
    '',
].join('\n');
export const TAG = '<<<XSMOKE>>>';
/** PHP that asserts the block is in `/wp/v2/block-types`. */
export function registrationProbePhp(blockName) {
    return `<?php
require_once '/wordpress/wp-load.php';
wp_set_current_user( 1 );

$req   = new WP_REST_Request( 'GET', '/wp/v2/block-types' );
$res   = rest_do_request( $req );
$names = array();
if ( ! is_wp_error( $res ) && 200 === $res->get_status() ) {
	foreach ( (array) $res->get_data() as $bt ) {
		$names[] = is_array( $bt ) ? $bt['name'] : $bt->name;
	}
}
$agent = array_values(
	array_filter(
		$names,
		static function ( $n ) {
			return 0 === strpos( (string) $n, 'agent/' );
		}
	)
);

echo "\\n${TAG}" . wp_json_encode(
	array(
		'registered' => in_array( ${phpJson(blockName)}, $names, true ),
		'count'      => count( $names ),
		'agent'      => $agent,
		'active'     => array_values( (array) get_option( 'active_plugins', array() ) ),
	)
) . "${TAG}";
`;
}
/**
 * PHP that renders the sample attributes through the sandbox's own REST block
 * renderer, cross-checks with `do_blocks()`, and reports any diagnostic raised
 * from inside the package directory.
 */
export function renderProbePhp(blockName, markup, attributes, vfsBlockDir) {
    return `<?php
$x_pkg     = ${phpJson(vfsBlockDir)};
$x_notices = array();
set_error_handler(
	static function ( $no, $str, $file = '', $line = 0 ) use ( &$x_notices, $x_pkg ) {
		if ( '' !== $file && false !== strpos( (string) $file, $x_pkg ) ) {
			$x_notices[] = sprintf( '%s in %s on line %d', $str, $file, (int) $line );
		}
		return true;
	}
);

require_once '/wordpress/wp-load.php';
wp_set_current_user( 1 );

$name   = ${phpJson(blockName)};
$markup = ${phpJson(markup)};
$attrs  = json_decode( ${phpJson(JSON.stringify(attributes))}, true );

$rest_html  = null;
$rest_error = null;
$req = new WP_REST_Request( 'POST', '/wp/v2/block-renderer/' . $name );
$req->set_param( 'context', 'edit' );
$req->set_param( 'attributes', is_array( $attrs ) ? $attrs : array() );
$res = rest_do_request( $req );
if ( is_wp_error( $res ) ) {
	$rest_error = $res->get_error_message();
} elseif ( 200 === $res->get_status() ) {
	$data      = $res->get_data();
	$rest_html = ( is_array( $data ) && isset( $data['rendered'] ) ) ? $data['rendered'] : null;
} else {
	$d          = $res->get_data();
	$rest_error = ( is_array( $d ) && isset( $d['message'] ) ) ? $d['message'] : 'HTTP ' . $res->get_status();
}

$do_blocks_html = do_blocks( $markup );

echo "\\n${TAG}" . wp_json_encode(
	array(
		'rest_html'      => $rest_html,
		'rest_error'     => $rest_error,
		'do_blocks_html' => $do_blocks_html,
		'notices'        => $x_notices,
	)
) . "${TAG}";
`;
}
/** A PHP literal for a string, via JSON — safe for anything we generate. */
export function phpJson(value) {
    return JSON.stringify(value).replace(/\$/g, '\\$');
}
/** Pull the payload back out of a tagged PHP echo. */
export function readTagged(text) {
    const parts = String(text ?? '').split(TAG);
    if (parts.length < 3)
        return null;
    try {
        return JSON.parse(parts[1] ?? '');
    }
    catch {
        return null;
    }
}
const PHP_ERROR_LEVELS = 'Parse error|Fatal error|Warning|Notice|Deprecated|Recoverable fatal error|Uncaught \\w*Error';
/**
 * Extract the human-readable PHP diagnostic from sandbox output. WordPress wraps
 * it in `<b>…</b>` on its error page and PHP emits it plain on the CLI, so try
 * both shapes.
 */
export function extractPhpError(text) {
    const s = String(text ?? '');
    const html = new RegExp(`<b>(${PHP_ERROR_LEVELS})</b>:([\\s\\S]{0,800}?)<br\\s*/?>`).exec(s);
    if (html)
        return decodeHtml(`${html[1]}:${html[2]}`);
    const plain = new RegExp(`(${PHP_ERROR_LEVELS})[^\\n]{0,800}`).exec(s);
    return plain ? decodeHtml(plain[0]) : '';
}
function decodeHtml(s) {
    return String(s)
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}
/** Turn the runner's raw probe text into the smoke facts we report. */
export function interpretSmoke(raw) {
    const out = {
        booted: !!raw.booted,
        boot_ms: raw.boot_ms ?? 0,
        registered: false,
        block_type_count: 0,
        agent_blocks: [],
        rendered_html: '',
        render_source: '',
        php_error: '',
        php_notices: [],
        error: raw.error ?? '',
    };
    if (raw.front) {
        out.front = raw.front;
    }
    if (raw.register) {
        const info = readTagged(raw.register.text);
        if (info) {
            out.registered = info.registered === true;
            out.block_type_count = typeof info.count === 'number' ? info.count : 0;
            out.agent_blocks = Array.isArray(info.agent) ? info.agent : [];
        }
        else if (!out.error) {
            out.error = 'Could not read the registration probe result from the sandbox.';
        }
        const err = extractPhpError(raw.register.threw ? raw.register.error_text : raw.register.text);
        if (err)
            out.php_error = err;
    }
    if (raw.render) {
        const info = readTagged(raw.render.text);
        if (info) {
            const rest = typeof info.rest_html === 'string' ? info.rest_html : '';
            const doBlocks = typeof info.do_blocks_html === 'string' ? info.do_blocks_html : '';
            if (rest.trim()) {
                out.rendered_html = rest;
                out.render_source = 'rest:/wp/v2/block-renderer';
            }
            else if (doBlocks.trim()) {
                out.rendered_html = doBlocks;
                out.render_source = 'do_blocks';
            }
            else if (!out.error && typeof info.rest_error === 'string' && info.rest_error) {
                out.error = `The block renderer returned no HTML: ${info.rest_error}`;
            }
            if (Array.isArray(info.notices))
                out.php_notices = info.notices;
        }
        else if (!out.error) {
            out.error = 'Could not read the render probe result from the sandbox.';
        }
        const err = extractPhpError(raw.render.threw ? raw.render.error_text : raw.render.text);
        if (err && !out.php_error)
            out.php_error = err;
    }
    if (!out.php_error && out.php_notices.length)
        out.php_error = out.php_notices.join(' | ');
    return out;
}
export async function smokeTest(stage, sampleAttributes, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? envInt('X_AGENT_BLOCK_SMOKE_TIMEOUT_MS', DEFAULT_SMOKE_TIMEOUT_MS);
    const cliEntry = resolvePlaygroundCli();
    const port = await freePort(opts.port ?? (process.env.X_AGENT_SMOKE_PORT ? Number(process.env.X_AGENT_SMOKE_PORT) : undefined));
    const attributes = mergedSampleAttributes(stage.meta, sampleAttributes);
    const markup = blockMarkup(stage.meta.name, attributes);
    const vfsBlockDir = `/wordpress/wp-content/plugins/${stage.pluginDirName}/${stage.slug}`;
    const runDir = path.join(path.dirname(stage.stageDir), 'smoke');
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });
    const runnerPath = path.join(runDir, 'smoke-runner.mjs');
    const configPath = path.join(runDir, 'smoke-config.json');
    const resultPath = path.join(runDir, 'smoke-result.json');
    fs.writeFileSync(runnerPath, SMOKE_RUNNER_SOURCE, 'utf8');
    const config = {
        cliEntry,
        port,
        php: process.env.X_AGENT_SMOKE_PHP || '8.3',
        wp: process.env.X_AGENT_SMOKE_WP || 'latest',
        pluginDir: stage.stageDir,
        pluginSlug: stage.pluginDirName,
        registerCode: registrationProbePhp(stage.meta.name),
        renderCode: renderProbePhp(stage.meta.name, markup, attributes, vfsBlockDir),
    };
    // M6: a block that ships front-end assets (viewScript, viewScriptModule,
    // style) is additionally smoked in a real browser against the sandbox's
    // published front end.
    const hasFrontAssets = ['viewScript', 'viewScriptModule', 'style'].some((k) => typeof stage.meta.raw[k] === 'string');
    if (hasFrontAssets) {
        let playwrightEntry = '';
        try {
            playwrightEntry = localRequire.resolve('playwright');
        }
        catch {
            /* playwright not installed: front smoke silently unavailable */
        }
        if (playwrightEntry) {
            config.front = {
                publishCode: publishProbePhp(markup),
                tag: TAG,
                slug: stage.slug,
                playwrightEntry,
            };
        }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    opts.logger?.info(`smoke-testing ${stage.meta.name} in a throwaway WordPress on port ${port}`);
    const started = Date.now();
    const res = await run(process.execPath, [runnerPath, configPath, resultPath], { cwd: runDir, timeoutMs });
    const ms = Date.now() - started;
    let raw;
    if (fs.existsSync(resultPath)) {
        try {
            raw = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        }
        catch {
            /* fall through to the synthetic failure below */
        }
    }
    const log = [tail(res.stdout), tail(res.stderr)].filter(Boolean).join('\n');
    if (!raw) {
        raw = {
            booted: false,
            boot_ms: 0,
            error: res.timedOut
                ? `The smoke sandbox did not finish within ${timeoutMs}ms.`
                : `The smoke sandbox exited with code ${res.code} without writing a result. ${tail(res.stderr, 2000)}`.trim(),
        };
    }
    return { result: interpretSmoke(raw), log, ms, port, markup, attributes };
}
/** PHP that publishes the smoke markup as a post and echoes its permalink. */
export function publishProbePhp(markup) {
    return `<?php
require_once '/wordpress/wp-load.php';
wp_set_current_user( 1 );

$post_id = wp_insert_post(
	array(
		'post_title'   => 'x-agent front smoke',
		'post_status'  => 'publish',
		'post_type'    => 'post',
		'post_content' => ${phpJson(markup)},
	),
	true
);

echo "\\n${TAG}" . wp_json_encode(
	is_wp_error( $post_id )
		? array( 'error' => $post_id->get_error_message() )
		: array( 'url' => get_permalink( (int) $post_id ), 'id' => (int) $post_id )
) . "${TAG}";
`;
}
/** Sample attributes, with block.json defaults filling every gap. */
export function mergedSampleAttributes(meta, sample) {
    const declared = (meta.raw.attributes ?? {});
    const out = {};
    for (const [k, v] of Object.entries(declared))
        if (v && v.default !== undefined)
            out[k] = v.default;
    for (const [k, v] of Object.entries(sample ?? {}))
        out[k] = v;
    return out;
}
/** `<!-- wp:agent/slug {"a":1} /-->` — the canonical self-closing form. */
export function blockMarkup(name, attributes) {
    const attrs = Object.keys(attributes).length ? ` ${JSON.stringify(attributes)}` : '';
    return `<!-- wp:${name}${attrs} /-->`;
}
/* ========================================================================== */
/* The factory                                                                */
/* ========================================================================== */
export class BlockFactory {
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    scaffold(input) {
        const out = scaffold(input);
        this.logger?.info(`scaffolded ${out.name} at ${out.dir}`);
        return out;
    }
    /**
     * build -> stage -> smoke -> package. The zip is produced on the success path
     * only; every failure returns structured detail and no `zip_path`, so there is
     * nothing for `wp_block_install` to send.
     */
    async buildAndTest(input) {
        const dir = path.resolve(input.dir ?? '');
        if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            throw errInvalidInput(`${input.dir} is not a directory.`, 'Pass the `dir` returned by wp_block_scaffold.', { dir: input.dir });
        }
        const timings = {};
        const deviations = [];
        // 1. The syntax gate — no compile step; the bytes checked are the bytes
        //    that ship (decision 2026-08-26; npm/wp-scripts deleted).
        const gate = await syntaxGate(dir, input.timeout_ms ? { timeoutMs: input.timeout_ms } : {});
        timings.syntax_check = gate.ms;
        if (!gate.ok) {
            return {
                built: false,
                smoke: { registered: false, rendered_html: '' },
                build_log: gate.log,
                failure: {
                    code: 'build_failed',
                    message: 'A shipped script failed the syntax gate; see build_log.',
                    hint: 'Fix the JavaScript syntax error build_log names and call wp_block_build_test again. Nothing is packaged and nothing is sent to an instance until the gate passes.',
                },
                timings_ms: timings,
                deviations,
            };
        }
        // 2. Stage the exact bytes that will ship. -----------------------------
        const stage = stagePackage(dir);
        if (stage.missing.length) {
            return {
                built: true,
                smoke: { registered: false, rendered_html: '' },
                build_log: gate.log,
                failure: {
                    code: 'build_failed',
                    message: `block.json references file(s) the scaffold does not contain: ${stage.missing.join(', ')}.`,
                    hint: 'Correct the file: paths in block.json, or restore the missing file. The companion rejects a package whose block.json references a missing file.',
                },
                timings_ms: timings,
                deviations,
            };
        }
        // 3. Smoke test in a real, throwaway WordPress. ------------------------
        const smokeOpts = {};
        if (input.smoke_timeout_ms)
            smokeOpts.timeoutMs = input.smoke_timeout_ms;
        if (input.port)
            smokeOpts.port = input.port;
        if (this.logger)
            smokeOpts.logger = this.logger;
        const smoke = await smokeTest(stage, input.sample_attributes ?? {}, smokeOpts);
        timings.smoke = smoke.ms;
        timings.smoke_boot = smoke.result.boot_ms;
        const smokeOut = { registered: smoke.result.registered, rendered_html: smoke.result.rendered_html };
        if (smoke.result.php_error)
            smokeOut.php_error = smoke.result.php_error;
        if (smoke.result.front)
            smokeOut.front = smoke.result.front;
        const log = [gate.log, smoke.log].filter(Boolean).join('\n');
        // M6: R11 lint — surfaced always, never a failure by itself.
        const styleWarnings = styleLintWarnings(dir);
        // M6: front-end assets must actually work in a real browser. A viewScript
        // that never executed, a stylesheet that never enqueued, or any console
        // error on the sandbox front end fails the gate.
        const front = smoke.result.front;
        if (front) {
            const meta = stage.meta.raw;
            const frontFailures = [];
            if (front.error)
                frontFailures.push(`front smoke could not run: ${front.error}`);
            if (front.console_errors && front.console_errors.length)
                frontFailures.push(`console errors on the front end: ${front.console_errors.slice(0, 3).join(' | ')}`);
            if (typeof meta.viewScript === 'string' && front.view_ready === false)
                frontFailures.push('view.js never marked a block instance ready (data-x-agent-view)');
            if (typeof meta.style === 'string' && front.style_enqueued === false)
                frontFailures.push('style.css was not enqueued on the front end');
            if (typeof meta.viewScriptModule === 'string' && front.module_present === false)
                frontFailures.push('the view module was not present on the front end');
            if (frontFailures.length) {
                return {
                    built: true,
                    smoke: smokeOut,
                    build_log: log,
                    failure: {
                        code: 'smoke_failed',
                        message: frontFailures.join('; '),
                        hint: 'The block registered and rendered, but its front-end assets failed in a real browser. Fix view.js / style.css / the module and rerun wp_block_build_test.',
                    },
                    timings_ms: timings,
                    deviations,
                    ...(styleWarnings.length ? { style_warnings: styleWarnings } : {}),
                };
            }
        }
        if (smoke.result.php_error || !smoke.result.registered || !smoke.result.rendered_html) {
            return {
                built: true,
                smoke: smokeOut,
                build_log: log,
                failure: {
                    code: 'smoke_failed',
                    message: smoke.result.php_error
                        ? `The block produced a PHP error in the sandbox: ${smoke.result.php_error}`
                        : !smoke.result.booted
                            ? `The smoke sandbox did not boot: ${smoke.result.error}`
                            : !smoke.result.registered
                                ? `${stage.meta.name} did not appear in /wp/v2/block-types after registration. ${smoke.result.error}`.trim()
                                : `${stage.meta.name} registered but rendered nothing. ${smoke.result.error}`.trim(),
                    hint: 'Fix render.php (or block.json) and run wp_block_build_test again. No package was produced, so nothing can be installed onto an instance in this state.',
                },
                timings_ms: timings,
                deviations,
            };
        }
        // 4. Package — success path only. The zip is the staged plugin, verbatim:
        // a standard WordPress plugin zip a human could install from plugins.php.
        const zipPath = path.join(dir, BUILD_DIRNAME, `${stage.pluginDirName}-${stage.meta.version}.zip`);
        packageBlock(stage.stageDir, zipPath, stage.pluginDirName);
        const inspection = inspectPackage(zipPath);
        if (!inspection.ok) {
            fs.rmSync(zipPath, { force: true });
            return {
                built: true,
                smoke: smokeOut,
                build_log: log,
                failure: {
                    code: 'build_failed',
                    message: `The package would violate the companion install policy: ${inspection.reasons.join('; ')}.`,
                    hint: 'CONTRACT.md §5 pins the install policy. The zip was deleted rather than handed to you.',
                },
                timings_ms: timings,
                deviations,
            };
        }
        return {
            built: true,
            smoke: smokeOut,
            zip_path: zipPath,
            build_log: log,
            package: { entries: inspection.entries, zip_bytes: inspection.zip_bytes, uncompressed_bytes: inspection.uncompressed_bytes },
            timings_ms: timings,
            deviations,
            ...(styleWarnings.length ? { style_warnings: styleWarnings } : {}),
        };
    }
}
/* ========================================================================== */
/* Seam registration (context.ts note 2b)                                     */
/* ========================================================================== */
registerFactoryProvider({
    create: (ctx) => new BlockFactory(ctx.logger),
});
/** `getFactory(ctx)` returns `unknown`; this narrows it at the call site. */
export function asFactory(v) {
    if (v instanceof BlockFactory)
        return v;
    throw new XError('internal', 'The block factory provider produced an unexpected instance.', 'This is an agent-side bug.');
}
//# sourceMappingURL=factory.js.map