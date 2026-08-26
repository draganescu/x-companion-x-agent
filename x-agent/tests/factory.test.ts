/**
 * M5 offline tests — scaffolding and packaging.
 *
 * Everything here runs with no network, no npm and no Playground: it covers the
 * two halves of the factory that must be deterministic and fast.
 *
 *   1. SCAFFOLDING. The file set, hard slug validation (traversal and uppercase
 *      are refused), and the invariant the spec's non-goals pin: the generated
 *      block is ALWAYS dynamic — apiVersion 3, an `agent/` name, a `render`
 *      entry, and a `save` that returns null.
 *
 *   2. PACKAGING. The zip is read back with adm-zip and checked against every
 *      structural rule in CONTRACT.md §5 `POST /blocks/install`. The companion
 *      answers 422 `block_policy` for any of them, and 422 must never be how we
 *      first hear about it.
 *
 * The build and the Playground smoke test are exercised live in tests/live/factory.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  BLOCK_NAME_RE,
  MAX_PACKAGE_BYTES,
  blockMarkup,
  extractPhpError,
  inspectPackage,
  interpolate,
  loadAdmZip,
  pluginMainSource,
  mergedSampleAttributes,
  packageBlock,
  readBlockMetadata,
  scaffold,
  stagePackage,
  syntaxGate,
  templateDir,
  type ScaffoldAttribute,
} from '../mcp/src/factory.js';
import { isXError, type XError } from '../mcp/src/errors.js';

const ATTRS: ScaffoldAttribute[] = [
  { name: 'planName', type: 'string', default: 'Starter', control: 'text' },
  { name: 'price', type: 'number', default: 9, control: 'number' },
  { name: 'featured', type: 'boolean', default: false, control: 'toggle' },
  { name: 'blurb', type: 'string', default: 'For small teams', control: 'textarea' },
  { name: 'tier', type: 'string', default: 'basic', control: 'select', options: [{ label: 'Basic', value: 'basic' }, { label: 'Pro', value: 'pro' }] },
  { name: 'photoUrl', type: 'string', default: '', control: 'image' },
];

const INTENT = 'Render a pricing card: plan name as an <h3>, price with a currency prefix, and a ribbon when featured.';

let WS: string;

beforeAll(() => {
  WS = fs.mkdtempSync(path.join(os.tmpdir(), 'x-agent-factory-'));
});

afterAll(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

const codeOf = (e: unknown): string => (isXError(e) ? (e as XError).code : `not-an-XError: ${String(e)}`);

function expectThrowsInvalidInput(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected a throw').toBeDefined();
  expect(codeOf(thrown)).toBe('invalid_input');
}

/* ========================================================================== */

describe('templates/dynamic-block', () => {
  it('ships exactly the file set the spec file_layout pins — no-build, no package.json, no src/', () => {
    const tpl = templateDir();
    for (const f of ['block.json', 'render.php', 'edit.js', 'edit.asset.php']) {
      expect(fs.existsSync(path.join(tpl, f)), `${f} missing from the template`).toBe(true);
    }
    expect(fs.existsSync(path.join(tpl, 'package.json'))).toBe(false);
    expect(fs.existsSync(path.join(tpl, 'src'))).toBe(false);
  });

  it('the template block.json declares apiVersion 3, an agent/ name, a render entry and the unbuilt editor script', () => {
    const raw = fs.readFileSync(path.join(templateDir(), 'block.json'), 'utf8');
    expect(raw).toContain('"apiVersion": 3');
    expect(raw).toContain('"name": "agent/{{slug}}"');
    expect(raw).toContain('"render": "file:./render.php"');
    expect(raw).toContain('"editorScript": "file:./edit.js"');
  });
});

describe('interpolate', () => {
  it('substitutes in a single pass, so a value containing {{x}} is never re-expanded', () => {
    expect(interpolate('a {{one}} b {{two}}', { one: '{{two}}', two: 'X' })).toBe('a {{two}} b X');
  });

  it('refuses to emit a file with an unfilled placeholder', () => {
    let thrown: unknown;
    try {
      interpolate('{{nope}}', {});
    } catch (e) {
      thrown = e;
    }
    expect(codeOf(thrown)).toBe('internal');
  });
});

describe('wp_block_scaffold — slug validation', () => {
  it.each([
    ['traversal', '../evil'],
    ['traversal segment', 'a/../b'],
    ['nested path', 'a/b'],
    ['backslash path', 'a\\b'],
    ['absolute path', '/etc/passwd'],
    ['uppercase', 'PricingCard'],
    ['mixed case', 'pricingCard'],
    ['underscore', 'pricing_card'],
    ['dot', 'pricing.card'],
    ['space', 'pricing card'],
    ['empty', ''],
    ['leading hyphen', '-card'],
    ['trailing hyphen', 'card-'],
  ])('refuses %s (%j)', (_label, slug) => {
    expectThrowsInvalidInput(() => scaffold({ slug, title: 'X', render_intent: INTENT, dir: WS }));
  });

  it('accepts a plain lowercase slug', () => {
    const out = scaffold({ slug: 'ok-slug-9', title: 'Ok', render_intent: INTENT, dir: WS, force: true });
    expect(out.name).toBe('agent/ok-slug-9');
    expect(path.dirname(out.dir)).toBe(path.resolve(WS));
  });

  it('never writes outside the parent directory it was given', () => {
    const before = fs.readdirSync(WS).sort();
    expectThrowsInvalidInput(() => scaffold({ slug: '../escape', title: 'X', render_intent: INTENT, dir: WS }));
    expect(fs.readdirSync(WS).sort()).toEqual(before);
    expect(fs.existsSync(path.join(path.dirname(WS), 'escape'))).toBe(false);
  });

  it('requires a render_intent', () => {
    expectThrowsInvalidInput(() => scaffold({ slug: 'no-intent', title: 'X', render_intent: '   ', dir: WS }));
  });

  it('refuses a select attribute with no options, and a duplicate attribute name', () => {
    expectThrowsInvalidInput(() =>
      scaffold({ slug: 'bad-attrs', title: 'X', render_intent: INTENT, dir: WS, attributes: [{ name: 'a', type: 'string', control: 'select' }] }),
    );
    expectThrowsInvalidInput(() =>
      scaffold({
        slug: 'bad-attrs',
        title: 'X',
        render_intent: INTENT,
        dir: WS,
        attributes: [
          { name: 'a', type: 'string', control: 'text' },
          { name: 'a', type: 'string', control: 'text' },
        ],
      }),
    );
  });

  it('refuses to clobber a non-empty directory unless force is set', () => {
    scaffold({ slug: 'clobber', title: 'X', render_intent: INTENT, dir: WS, force: true });
    expectThrowsInvalidInput(() => scaffold({ slug: 'clobber', title: 'X', render_intent: INTENT, dir: WS }));
    expect(scaffold({ slug: 'clobber', title: 'X', render_intent: INTENT, dir: WS, force: true }).name).toBe('agent/clobber');
  });
});

describe('wp_block_scaffold — generated files', () => {
  let dir: string;

  beforeAll(() => {
    dir = scaffold({ slug: 'pricing-card', title: 'Pricing Card', render_intent: INTENT, dir: WS, attributes: ATTRS, force: true }).dir;
  });

  it('produces exactly the expected file set', () => {
    const out = scaffold({ slug: 'file-set', title: 'File Set', render_intent: INTENT, dir: WS, attributes: ATTRS, force: true });
    expect(out.files).toEqual(['block.json', 'edit.asset.php', 'edit.js', 'render.php']);
    for (const f of out.files) expect(fs.existsSync(path.join(out.dir, f))).toBe(true);
  });

  it('generates a block.json that is valid JSON with apiVersion 3, an agent/ name and a render entry', () => {
    const raw = fs.readFileSync(path.join(dir, 'block.json'), 'utf8');
    expect(raw).not.toContain('{{');
    const meta = JSON.parse(raw) as Record<string, unknown>;
    expect(meta.apiVersion).toBe(3);
    expect(meta.name).toBe('agent/pricing-card');
    expect(BLOCK_NAME_RE.test(String(meta.name))).toBe(true);
    expect(meta.render).toBe('file:./render.php');
    expect(meta.title).toBe('Pricing Card');
  });

  it('declares every attribute, with defaults and a select enum', () => {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'block.json'), 'utf8')) as {
      attributes: Record<string, { type: string; default?: unknown; enum?: string[] }>;
    };
    expect(Object.keys(meta.attributes).sort()).toEqual(['blurb', 'featured', 'photoUrl', 'planName', 'price', 'tier']);
    expect(meta.attributes.planName).toEqual({ type: 'string', default: 'Starter' });
    expect(meta.attributes.price).toEqual({ type: 'number', default: 9 });
    expect(meta.attributes.featured).toEqual({ type: 'boolean', default: false });
    expect(meta.attributes.tier?.enum).toEqual(['basic', 'pro']);
  });

  it('embeds render_intent verbatim in render.php as the comment to implement against', () => {
    const php = fs.readFileSync(path.join(dir, 'render.php'), 'utf8');
    expect(php).toContain('RENDER INTENT');
    expect(php).toContain(INTENT);
    expect(php).not.toContain('{{');
  });

  it('render.php escapes every attribute and uses get_block_wrapper_attributes()', () => {
    const php = fs.readFileSync(path.join(dir, 'render.php'), 'utf8');
    expect(php).toContain('get_block_wrapper_attributes(');
    expect(php).toContain('esc_html( (string) $plan_name )');
    expect(php).toContain('esc_html( (string) $price )');
    expect(php).toContain('wp_kses_post( wpautop( (string) $blurb ) )');
    // Nothing may reach the browser unescaped except the wrapper attributes,
    // which get_block_wrapper_attributes() has already escaped.
    const echoes = php.match(/<\?php echo [^?]*\?>/g) ?? [];
    for (const e of echoes) {
      expect(e, `unescaped echo: ${e}`).toMatch(/esc_html|esc_attr|esc_url|wp_kses_post|\$wrapper_attributes/);
    }
  });

  it('edit.js picks images in the inspector via MediaUpload (the canvas shows the server render)', () => {
    const js = fs.readFileSync(path.join(dir, 'edit.js'), 'utf8');
    expect(js).toContain('el( MediaUploadCheck');
    expect(js).toContain('el( MediaUpload, {');
    expect(js).toContain('setAttributes( { photoUrl: media.url } )');
    // No inline media slot: the image is visible in the ServerSideRender preview.
    expect(js).not.toContain('MediaPlaceholder');
  });

  it('render.php outputs image attributes through esc_url inside an <img>', () => {
    const php = fs.readFileSync(path.join(dir, 'render.php'), 'utf8');
    expect(php).toContain('esc_url( (string) $photo_url )');
  });

  it('edit.js previews through ServerSideRender and keeps every control in the inspector', () => {
    const js = fs.readFileSync(path.join(dir, 'edit.js'), 'utf8');
    expect(js).not.toContain('{{');
    expect(js).toContain('useBlockProps');
    expect(js).toContain('el( InspectorControls');
    // The canvas IS render.php: no hand-maintained preview markup that can drift.
    expect(js).toContain('el( ServerSideRender, {');
    expect(js).toContain("block: 'agent/pricing-card'");
    expect(js).not.toContain('RichText');
    // Every attribute gets a sidebar control with a user-facing label.
    expect(js).toContain('label: __( "Plan name", "agent-pricing-card" )');
    expect(js).toContain('setAttributes( { planName: value } )');
    expect(js).toContain('el( TextareaControl');
    expect(js).toContain("type: 'number'");
    expect(js).toContain('el( ToggleControl');
    expect(js).toContain('el( SelectControl');
    expect(js).toContain('{ label: __( "Pro", "agent-pricing-card" ), value: "pro" }');
  });

  it('edit.js is vanilla no-build JS: wp.* globals only, no module syntax, no JSX', () => {
    const js = fs.readFileSync(path.join(dir, 'edit.js'), 'utf8');
    expect(js).not.toContain('import ');
    expect(js).not.toContain('require(');
    expect(js).not.toMatch(/<[A-Z]/); // no JSX element anywhere
    expect(js).toContain('wp.blocks');
    expect(js).toContain('wp.serverSideRender');
    // The whole block registers from this one file: no src/index.js entry point.
    expect(js).toContain("registerBlockType( 'agent/pricing-card'");
  });

  it('edit.asset.php declares the wp.* dependencies WordPress must load before edit.js', () => {
    const php = fs.readFileSync(path.join(dir, 'edit.asset.php'), 'utf8');
    expect(php).not.toContain('{{');
    for (const handle of ['wp-blocks', 'wp-element', 'wp-i18n', 'wp-block-editor', 'wp-components', 'wp-server-side-render']) {
      expect(php, `${handle} missing from edit.asset.php`).toContain(`'${handle}'`);
    }
    expect(php).toContain("'version'");
    expect(php).toContain('0.1.0');
  });

  it('block.json and edit.js carry user-facing copy only — no toolchain vocabulary', () => {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'block.json'), 'utf8')) as Record<string, unknown>;
    // The description defaults to the title, never to provenance chatter.
    expect(meta.description).toBe('Pricing Card');
    expect(meta.keywords).toEqual(['pricing-card']);
    expect(JSON.stringify(meta)).not.toContain('x-agent');
    expect(JSON.stringify(meta)).not.toContain('scaffolded');
  });

  it('a supplied description and per-attribute label/help flow into block.json and the inspector', () => {
    const out = scaffold({
      slug: 'labeled-card',
      title: 'Labeled Card',
      description: 'A card with a friendly description.',
      render_intent: INTENT,
      dir: WS,
      force: true,
      attributes: [{ name: 'ctaText', type: 'string', control: 'text', label: 'Button text', help: 'Shown on the card’s button.' }],
    });
    const meta = JSON.parse(fs.readFileSync(path.join(out.dir, 'block.json'), 'utf8')) as Record<string, unknown>;
    expect(meta.description).toBe('A card with a friendly description.');
    const js = fs.readFileSync(path.join(out.dir, 'edit.js'), 'utf8');
    expect(js).toContain('label: __( "Button text", "agent-labeled-card" )');
    expect(js).toContain('help: __( "Shown on the card’s button.", "agent-labeled-card" )');
  });

  it('an array attribute with control textarea is edited one item per line and stays an array', () => {
    const out = scaffold({
      slug: 'lines-block',
      title: 'Lines Block',
      render_intent: INTENT,
      dir: WS,
      force: true,
      attributes: [{ name: 'items', type: 'array', default: [], control: 'textarea', help: 'One fact per line.' }],
    });
    const js = fs.readFileSync(path.join(out.dir, 'edit.js'), 'utf8');
    expect(js).toContain("( attributes.items ?? [] ).join( '\\n' )");
    expect(js).toContain("setAttributes( { items: value.split( '\\n' ) } )");
    // Never a raw value dump: the array is not bound to a control as-is.
    expect(js).not.toContain('value: attributes.items,');
  });

  it('a structured attribute scaffolds the JSON fallback flagged for replacement before install', () => {
    const out = scaffold({
      slug: 'structured-block',
      title: 'Structured Block',
      render_intent: INTENT,
      dir: WS,
      force: true,
      attributes: [{ name: 'rows', type: 'array', default: [] }],
    });
    const js = fs.readFileSync(path.join(out.dir, 'edit.js'), 'utf8');
    expect(js).toContain('el( StructuredFallbackControl');
    expect(js).toContain('Replace its usage below');
    expect(js).toContain('useState');
    expect(js).not.toContain('import ');
  });

  it('render.php exposes $is_editor_preview for front-hidden output', () => {
    const php = fs.readFileSync(path.join(dir, 'render.php'), 'utf8');
    expect(php).toContain('$is_editor_preview');
    expect(php).toContain("'edit' === sanitize_key");
  });

  it('is DYNAMIC by construction — save returns null and there is no static path', () => {
    const js = fs.readFileSync(path.join(dir, 'edit.js'), 'utf8');
    expect(js).toContain('save: () => null');
    expect(js).not.toMatch(/save\s*:\s*function/);
    // The whole template tree: no block.json anywhere without a render entry.
    const tplBlockJson = fs.readFileSync(path.join(templateDir(), 'block.json'), 'utf8');
    expect(tplBlockJson).toContain('"render"');
  });

  it('the scaffold is no-build: no package.json, no src/, no node_modules ever', () => {
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'src'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'block.json'), 'utf8')) as { editorScript: string };
    expect(meta.editorScript).toBe('file:./edit.js');
  });

  it('readBlockMetadata refuses a block.json with no render entry (a static block)', () => {
    const staticDir = path.join(WS, 'static-block');
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, 'block.json'), JSON.stringify({ apiVersion: 3, name: 'agent/static-block' }));
    expectThrowsInvalidInput(() => readBlockMetadata(staticDir));
  });

  it('readBlockMetadata refuses a name outside the agent/ namespace', () => {
    const d = path.join(WS, 'wrong-ns');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'block.json'), JSON.stringify({ apiVersion: 3, name: 'core/paragraph', render: 'file:./render.php' }));
    expectThrowsInvalidInput(() => readBlockMetadata(d));
  });
});

/* ========================================================================== */

/**
 * A minimal STORED-method zip writer, so a test can put entry names in a zip
 * that adm-zip would refuse to write (`../`, absolute paths). That is exactly
 * the shape the install policy exists to reject.
 */
function writeHostileZip(name: string, files: Record<string, string>): string {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [entryName, body] of Object.entries(files)) {
    const nameBuf = Buffer.from(entryName, 'utf8');
    const data = Buffer.from(body, 'utf8');
    const crc = zlib.crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8); // stored
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lfh, nameBuf, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 10); // stored
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const p = path.join(WS, name);
  fs.writeFileSync(p, Buffer.concat([...locals, cd, eocd]));
  return p;
}

describe('packaging — CONTRACT.md §5 install policy, asserted by reading the zip back', () => {
  let zipPath: string;
  let blockDir: string;

  beforeAll(() => {
    // No build step exists: the scaffold's own files ARE the package.
    const dir = scaffold({ slug: 'packaged-card', title: 'Packaged', render_intent: INTENT, dir: WS, attributes: ATTRS, force: true }).dir;
    const stage = stagePackage(dir);
    expect(stage.missing).toEqual([]);
    expect(stage.pluginDirName).toBe('agent-block-packaged-card');
    blockDir = stage.blockDir;
    zipPath = packageBlock(stage.stageDir, path.join(WS, 'packaged-card.zip'), stage.pluginDirName);
  });

  it('stages the plugin main file next to the block, wrapping register_block_type', () => {
    const main = fs.readFileSync(path.join(path.dirname(blockDir), 'agent-block-packaged-card.php'), 'utf8');
    expect(main).toContain('Plugin Name:');
    expect(main).toContain("register_block_type( __DIR__ . '/packaged-card' )");
    expect(pluginMainSource('x', { name: 'agent/x', version: '1.0.0', render: 'file:./render.php', fileRefs: [], raw: {} })).toContain('register_block_type');
  });

  it('is a standard plugin zip: one top-level agent-block-{slug}/ directory', () => {
    const Zip = loadAdmZip();
    const entries = new Zip(zipPath).getEntries().filter((e) => !e.isDirectory);
    const tops = new Set(entries.map((e) => e.entryName.split('/')[0]));
    expect([...tops]).toEqual(['agent-block-packaged-card']);
  });

  it('carries the plugin main file with a real header', () => {
    const Zip = loadAdmZip();
    const entry = new Zip(zipPath).getEntries().find((e) => e.entryName === 'agent-block-packaged-card/agent-block-packaged-card.php');
    expect(entry).toBeDefined();
    expect(entry!.getData().toString('utf8')).toMatch(/Plugin Name\s*:/);
  });

  it('has block.json at the block directory root, parsing, with an agent/ name', () => {
    const Zip = loadAdmZip();
    const entry = new Zip(zipPath).getEntries().find((e) => e.entryName === 'agent-block-packaged-card/packaged-card/block.json');
    expect(entry).toBeDefined();
    const meta = JSON.parse(entry!.getData().toString('utf8')) as Record<string, unknown>;
    expect(BLOCK_NAME_RE.test(String(meta.name))).toBe(true);
    expect(meta.apiVersion).toBe(3);
  });

  it('has a render entry pointing at a file that is in the zip', () => {
    const Zip = loadAdmZip();
    const entries = new Zip(zipPath).getEntries().filter((e) => !e.isDirectory);
    const names = new Set(entries.map((e) => e.entryName));
    const meta = JSON.parse(entries.find((e) => e.entryName.endsWith('block.json'))!.getData().toString('utf8')) as { render: string };
    expect(meta.render.startsWith('file:')).toBe(true);
    const rel = meta.render.slice('file:'.length).replace(/^\.\//, '');
    expect(names.has(`agent-block-packaged-card/packaged-card/${rel}`)).toBe(true);
  });

  it('includes every file referenced by block.json, and the editor script asset file', () => {
    const Zip = loadAdmZip();
    const entries = new Zip(zipPath).getEntries().filter((e) => !e.isDirectory);
    const names = new Set(entries.map((e) => e.entryName));
    expect(names).toContain('agent-block-packaged-card/packaged-card/edit.js');
    expect(names).toContain('agent-block-packaged-card/packaged-card/edit.asset.php');
    expect(names).toContain('agent-block-packaged-card/packaged-card/render.php');
    expect([...names].some((n) => n.includes('/build/'))).toBe(false);
  });

  it('carries no ../ and no absolute zip entries', () => {
    const Zip = loadAdmZip();
    for (const e of new Zip(zipPath).getEntries()) {
      expect(e.entryName.split('/')).not.toContain('..');
      expect(e.entryName.startsWith('/')).toBe(false);
      expect(/^[A-Za-z]:[\\/]/.test(e.entryName)).toBe(false);
    }
  });

  it('does not ship node_modules, src or package.json', () => {
    const Zip = loadAdmZip();
    const names = new Zip(zipPath).getEntries().map((e) => e.entryName);
    expect(names.some((n) => n.includes('node_modules'))).toBe(false);
    expect(names.some((n) => n.includes('/src/'))).toBe(false);
    expect(names.some((n) => n.endsWith('/package.json'))).toBe(false);
  });

  it('is comfortably under the 5 MB install limit', () => {
    expect(fs.statSync(zipPath).size).toBeLessThan(MAX_PACKAGE_BYTES);
  });

  it('inspectPackage agrees it is clean', () => {
    const report = inspectPackage(zipPath);
    expect(report.reasons).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.root).toBe('agent-block-packaged-card');
    expect(report.zip_bytes).toBeLessThan(MAX_PACKAGE_BYTES);
  });
});

describe('inspectPackage — catches every policy violation before the companion has to', () => {
  const Zip = loadAdmZip();
  const write = (name: string, files: Record<string, string>): string => {
    const zip = new Zip();
    for (const [entry, body] of Object.entries(files)) zip.addFile(entry, Buffer.from(body, 'utf8'));
    const p = path.join(WS, name);
    zip.writeZip(p);
    return p;
  };
  const goodBlockJson = JSON.stringify({ apiVersion: 3, name: 'agent/x', render: 'file:./render.php', editorScript: 'file:./build/index.js' });
  const MAIN = '<?php\n/**\n * Plugin Name: Agent block: x\n */\n';
  const good = (blockJson: string = goodBlockJson): Record<string, string> => ({
    'agent-block-x/agent-block-x.php': MAIN,
    'agent-block-x/x/block.json': blockJson,
    'agent-block-x/x/render.php': '<?php',
    'agent-block-x/x/build/index.js': '',
  });

  // adm-zip normalises entry names on write, so it cannot *produce* a hostile
  // package. A hand-rolled writer can — which is the case the policy is for:
  // the zip arrives from somewhere else and the entry names are attacker-chosen.
  it('flags a traversal entry', () => {
    const p = writeHostileZip('bad-traversal.zip', { ...good(), 'agent-block-x/../../evil.php': '<?php' });
    const r = inspectPackage(p);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/traversal segment in zip entry: agent-block-x\/\.\.\/\.\.\/evil\.php/);
  });

  it('flags an absolute entry', () => {
    const p = writeHostileZip('bad-absolute.zip', { ...good(), '/etc/evil.php': '<?php' });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/absolute path in zip entry: \/etc\/evil\.php/);
  });

  it('flags two top-level directories', () => {
    const p = write('bad-two-tops.zip', { ...good(), 'y/other.php': '<?php' });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/top-level/);
  });

  it('flags a root that is not an agent-block-{slug} plugin directory', () => {
    const p = write('bad-root.zip', { 'x/block.json': goodBlockJson, 'x/render.php': '<?php', 'x/build/index.js': '' });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/does not start with "agent-block-"/);
  });

  it('flags a missing plugin main file', () => {
    const files = good();
    delete files['agent-block-x/agent-block-x.php'];
    const p = write('bad-no-main.zip', files);
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/plugin main file/);
  });

  it('flags a main file without a Plugin Name header', () => {
    const p = write('bad-headerless.zip', { ...good(), 'agent-block-x/agent-block-x.php': '<?php // no header' });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/no "Plugin Name:" header/);
  });

  it('flags a missing block.json at the block directory root', () => {
    const p = write('bad-nested.zip', { 'agent-block-x/agent-block-x.php': MAIN, 'agent-block-x/inner/block.json': goodBlockJson });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/block\.json is not at agent-block-x\/x\//);
  });

  it('flags a block.json that does not parse', () => {
    const p = write('bad-json.zip', { ...good('{ not json') });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/does not parse/);
  });

  it('flags a name outside the agent/ namespace', () => {
    const p = write('bad-ns.zip', { ...good(JSON.stringify({ name: 'core/x', render: 'file:./render.php' })) });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/does not match \^agent/);
  });

  it('flags a name that disagrees with the plugin directory', () => {
    const p = write('bad-mismatch.zip', { ...good(JSON.stringify({ name: 'agent/other', render: 'file:./render.php' })) });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/does not match the plugin directory/);
  });

  it('flags a missing render entry — a static block never gets packaged', () => {
    const p = write('bad-static.zip', { ...good(JSON.stringify({ name: 'agent/x' })) });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/no "render" entry/);
  });

  it('flags a referenced file that is not in the zip', () => {
    const files = good();
    delete files['agent-block-x/x/build/index.js'];
    const p = write('bad-missing-ref.zip', files);
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/build\/index\.js is not in the zip/);
  });

  it('flags a package over 5 MB', () => {
    const p = write('bad-big.zip', {
      ...good(),
      // Random bytes so the zip cannot compress its way under the limit.
      'agent-block-x/x/big.bin': Array.from({ length: MAX_PACKAGE_BYTES + 1024 }, () => String.fromCharCode(32 + Math.floor(Math.random() * 94))).join(''),
    });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/over the 5 MB install limit/);
  });

  it('refuses flat files at the zip root — a package is a plugin directory', () => {
    const p = write('flat-not-ok.zip', { 'block.json': JSON.stringify({ name: 'agent/x', render: 'file:./render.php' }), 'render.php': '<?php' });
    const r = inspectPackage(p);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/exactly one plugin directory/);
  });
});

/* ========================================================================== */

describe('smoke helpers', () => {
  it('merges sample attributes over the block.json defaults', () => {
    const dir = scaffold({ slug: 'merge-card', title: 'Merge Card', render_intent: INTENT, dir: WS, attributes: ATTRS, force: true }).dir;
    const meta = readBlockMetadata(dir);
    const merged = mergedSampleAttributes(meta, { planName: 'Enterprise', price: 49 });
    expect(merged).toMatchObject({ planName: 'Enterprise', price: 49, featured: false, tier: 'basic' });
  });

  it('builds canonical self-closing block markup', () => {
    expect(blockMarkup('agent/x', {})).toBe('<!-- wp:agent/x /-->');
    expect(blockMarkup('agent/x', { a: 1 })).toBe('<!-- wp:agent/x {"a":1} /-->');
  });

  it('extracts a PHP parse error out of a WordPress error page', () => {
    const page = '<br />\n<b>Parse error</b>:  syntax error, unexpected token &quot;;&quot; in <b>/wordpress/wp-content/plugins/x/render.php</b> on line <b>4</b><br />\n<!DOCTYPE html>';
    expect(extractPhpError(page)).toBe('Parse error: syntax error, unexpected token ";" in /wordpress/wp-content/plugins/x/render.php on line 4');
  });

  it('extracts a plain-text fatal', () => {
    expect(extractPhpError('PHP Fatal error:  Uncaught Error: Call to undefined function x()')).toMatch(/^Fatal error/);
  });

  it('returns empty string when there is no PHP error to find', () => {
    expect(extractPhpError('<div>all good</div>')).toBe('');
  });
});

/* ========================================================================== */

/**
 * The syntax gate replaced the npm/wp-scripts build (decision 2026-08-26):
 * there is no compile step, so the gate parses the exact bytes that ship —
 * classic scripts as scripts, a viewScriptModule as an ES module. All offline.
 */
describe('syntaxGate — the no-build first step of wp_block_build_test', () => {
  it('passes a fresh scaffold and never creates node_modules', async () => {
    const dir = scaffold({ slug: 'gate-clean', title: 'Gate Clean', render_intent: INTENT, dir: WS, attributes: ATTRS, force: true }).dir;
    const gate = await syntaxGate(dir);
    expect(gate.log).toBe('');
    expect(gate.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
  });

  it('fails a broken edit.js, naming the file in the log', async () => {
    const dir = scaffold({ slug: 'gate-broken-edit', title: 'Gate Broken', render_intent: INTENT, dir: WS, attributes: ATTRS, force: true }).dir;
    fs.appendFileSync(path.join(dir, 'edit.js'), '\nconst = nope;\n');
    const gate = await syntaxGate(dir);
    expect(gate.ok).toBe(false);
    expect(gate.log).toContain('edit.js');
  });

  it('checks a vanilla viewScript too', async () => {
    const dir = scaffold({ slug: 'gate-view', title: 'Gate View', render_intent: INTENT, dir: WS, attributes: ATTRS, force: true, interactivity: 'view-script' }).dir;
    fs.appendFileSync(path.join(dir, 'view.js'), '\nfunction ( { broken\n');
    const gate = await syntaxGate(dir);
    expect(gate.ok).toBe(false);
    expect(gate.log).toContain('view.js');
  });

  it('parses a viewScriptModule as an ES module — import syntax is not a false failure', async () => {
    const dir = scaffold({ slug: 'gate-esm', title: 'Gate ESM', render_intent: INTENT, dir: WS, attributes: ATTRS, force: true, interactivity: 'interactivity-api' }).dir;
    const view = fs.readFileSync(path.join(dir, 'view.js'), 'utf8');
    expect(view).toContain('import'); // the premise: the module really uses ESM syntax
    const gate = await syntaxGate(dir);
    expect(gate.log).toBe('');
    expect(gate.ok).toBe(true);
  });
});
