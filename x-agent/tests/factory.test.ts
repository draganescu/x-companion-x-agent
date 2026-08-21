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
  loaderPlugin,
  mergedSampleAttributes,
  packageBlock,
  readBlockMetadata,
  scaffold,
  stagePackage,
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
  it('ships exactly the file set the spec file_layout pins', () => {
    const tpl = templateDir();
    for (const f of ['block.json', 'render.php', 'package.json', 'src/edit.js', 'src/index.js']) {
      expect(fs.existsSync(path.join(tpl, f)), `${f} missing from the template`).toBe(true);
    }
  });

  it('the template block.json declares apiVersion 3, an agent/ name and a render entry', () => {
    const raw = fs.readFileSync(path.join(templateDir(), 'block.json'), 'utf8');
    expect(raw).toContain('"apiVersion": 3');
    expect(raw).toContain('"name": "agent/{{slug}}"');
    expect(raw).toContain('"render": "file:./render.php"');
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
    expect(out.files).toEqual(['block.json', 'package.json', 'render.php', 'src/edit.js', 'src/index.js']);
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
    expect(Object.keys(meta.attributes).sort()).toEqual(['blurb', 'featured', 'planName', 'price', 'tier']);
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

  it('src/edit.js uses useBlockProps and InspectorControls with a control per attribute', () => {
    const js = fs.readFileSync(path.join(dir, 'src/edit.js'), 'utf8');
    expect(js).not.toContain('{{');
    expect(js).toContain('useBlockProps');
    expect(js).toContain('<InspectorControls>');
    expect(js).toContain('setAttributes( { planName: value } )');
    expect(js).toContain('type="number"');
    expect(js).toContain('<ToggleControl');
    expect(js).toContain('<TextareaControl');
    expect(js).toContain('<SelectControl');
    expect(js).toContain("{ label: __( \"Pro\", \"agent-pricing-card\" ), value: \"pro\" }");
  });

  it('is DYNAMIC by construction — save returns null and there is no static path', () => {
    const js = fs.readFileSync(path.join(dir, 'src/index.js'), 'utf8');
    expect(js).toContain('save: () => null');
    expect(js).not.toMatch(/save\s*:\s*function/);
    // The whole template tree: no block.json anywhere without a render entry.
    const tplBlockJson = fs.readFileSync(path.join(templateDir(), 'block.json'), 'utf8');
    expect(tplBlockJson).toContain('"render"');
  });

  it('package.json builds with @wordpress/scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts.build).toBe('wp-scripts build');
    expect(pkg.devDependencies['@wordpress/scripts']).toBeTruthy();
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

/** A scaffold plus the artefacts a wp-scripts build would have produced. */
function scaffoldWithFakeBuild(slug: string): string {
  const out = scaffold({ slug, title: 'Packaged', render_intent: INTENT, dir: WS, attributes: ATTRS, force: true });
  fs.mkdirSync(path.join(out.dir, 'build'), { recursive: true });
  fs.writeFileSync(path.join(out.dir, 'build/index.js'), '/* built by wp-scripts */\n');
  fs.writeFileSync(path.join(out.dir, 'build/index.asset.php'), "<?php return array('dependencies' => array(), 'version' => 'x');\n");
  return out.dir;
}

describe('packaging — CONTRACT.md §5 install policy, asserted by reading the zip back', () => {
  let zipPath: string;
  let blockDir: string;

  beforeAll(() => {
    const dir = scaffoldWithFakeBuild('packaged-card');
    const stage = stagePackage(dir);
    expect(stage.missing).toEqual([]);
    blockDir = stage.blockDir;
    zipPath = packageBlock(stage.blockDir, path.join(WS, 'packaged-card.zip'));
  });

  it('stages the loader plugin next to the block, wrapping register_block_type', () => {
    const loader = fs.readFileSync(path.join(path.dirname(blockDir), 'x-agent-smoke.php'), 'utf8');
    expect(loader).toContain('Plugin Name:');
    expect(loader).toContain("register_block_type( __DIR__ . '/packaged-card' )");
    expect(loaderPlugin('x', 'agent/x')).toContain('register_block_type');
  });

  it('has exactly one top-level directory', () => {
    const Zip = loadAdmZip();
    const entries = new Zip(zipPath).getEntries().filter((e) => !e.isDirectory);
    const tops = new Set(entries.map((e) => e.entryName.split('/')[0]));
    expect([...tops]).toEqual(['packaged-card']);
  });

  it('has block.json at the block root, parsing, with an agent/ name', () => {
    const Zip = loadAdmZip();
    const entry = new Zip(zipPath).getEntries().find((e) => e.entryName === 'packaged-card/block.json');
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
    expect(names.has(`packaged-card/${rel}`)).toBe(true);
  });

  it('includes every file referenced by block.json, and the editor script asset file', () => {
    const Zip = loadAdmZip();
    const entries = new Zip(zipPath).getEntries().filter((e) => !e.isDirectory);
    const names = new Set(entries.map((e) => e.entryName));
    expect(names).toContain('packaged-card/build/index.js');
    expect(names).toContain('packaged-card/build/index.asset.php');
    expect(names).toContain('packaged-card/render.php');
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
    expect(report.root).toBe('packaged-card');
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

  // adm-zip normalises entry names on write, so it cannot *produce* a hostile
  // package. A hand-rolled writer can — which is the case the policy is for:
  // the zip arrives from somewhere else and the entry names are attacker-chosen.
  it('flags a traversal entry', () => {
    const p = writeHostileZip('bad-traversal.zip', { 'x/block.json': goodBlockJson, 'x/render.php': '<?php', 'x/../../evil.php': '<?php' });
    const r = inspectPackage(p);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/traversal segment in zip entry: x\/\.\.\/\.\.\/evil\.php/);
  });

  it('flags an absolute entry', () => {
    const p = writeHostileZip('bad-absolute.zip', { 'x/block.json': goodBlockJson, 'x/render.php': '<?php', '/etc/evil.php': '<?php' });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/absolute path in zip entry: \/etc\/evil\.php/);
  });

  it('flags two top-level directories', () => {
    const p = write('bad-two-tops.zip', { 'x/block.json': goodBlockJson, 'x/render.php': '<?php', 'y/other.php': '<?php' });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/top-level/);
  });

  it('flags a missing block.json at the block root', () => {
    const p = write('bad-nested.zip', { 'x/inner/block.json': goodBlockJson, 'x/inner/render.php': '<?php' });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/block\.json is not at the block root/);
  });

  it('flags a block.json that does not parse', () => {
    const p = write('bad-json.zip', { 'x/block.json': '{ not json', 'x/render.php': '<?php' });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/does not parse/);
  });

  it('flags a name outside the agent/ namespace', () => {
    const p = write('bad-ns.zip', { 'x/block.json': JSON.stringify({ name: 'core/x', render: 'file:./render.php' }), 'x/render.php': '<?php' });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/does not match \^agent/);
  });

  it('flags a missing render entry — a static block never gets packaged', () => {
    const p = write('bad-static.zip', { 'x/block.json': JSON.stringify({ name: 'agent/x' }) });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/no "render" entry/);
  });

  it('flags a referenced file that is not in the zip', () => {
    const p = write('bad-missing-ref.zip', { 'x/block.json': goodBlockJson, 'x/render.php': '<?php' });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/build\/index\.js is not in the zip/);
  });

  it('flags a package over 5 MB', () => {
    const p = write('bad-big.zip', {
      'x/block.json': goodBlockJson,
      'x/render.php': '<?php',
      'x/build/index.js': '',
      // Random bytes so the zip cannot compress its way under the limit.
      'x/big.bin': Array.from({ length: MAX_PACKAGE_BYTES + 1024 }, () => String.fromCharCode(32 + Math.floor(Math.random() * 94))).join(''),
    });
    expect(inspectPackage(p).reasons.join(' ')).toMatch(/over the 5 MB install limit/);
  });

  it('accepts flat files with block.json at the root', () => {
    const p = write('flat-ok.zip', { 'block.json': JSON.stringify({ name: 'agent/x', render: 'file:./render.php' }), 'render.php': '<?php' });
    const r = inspectPackage(p);
    expect(r.reasons).toEqual([]);
    expect(r.root).toBe('');
  });
});

/* ========================================================================== */

describe('smoke helpers', () => {
  it('merges sample attributes over the block.json defaults', () => {
    const dir = scaffoldWithFakeBuild('merge-card');
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
