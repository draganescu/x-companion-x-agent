/**
 * Drift test: the zod mirrors in mcp/src/schemas.ts must agree with the vendored
 * JSON Schemas in x-agent/schemas/ on ACCEPT/REJECT, document by document.
 *
 * The JSON-Schema validator below is inline and deliberately tiny — no ajv. It
 * covers exactly the keyword subset the vendored schemas use:
 *   type (incl. type arrays), required, properties, additionalProperties,
 *   items, enum, const, pattern, minimum, exclusiveMinimum, oneOf,
 *   $ref (#/definitions/... and cross-file "x-contract/<file>#/properties/...")
 * Any other keyword encountered makes the test fail loudly rather than silently
 * passing, so a schema change cannot slip past this file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TreeIRSchema,
  DiagnosticsSchema,
  ManifestSchema,
  DesignTokensSchema,
  DesignSpecIRSchema,
} from '../mcp/src/schemas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(HERE, '..', 'schemas');
const FIXTURES = path.resolve(HERE, '..', 'fixtures');

/* ------------------------------------------------- tiny JSON-Schema engine */

type JsonSchema = Record<string, any>;

const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  'title',
  'description',
  'definitions',
  'type',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'pattern',
  'minimum',
  'exclusiveMinimum',
  'oneOf',
]);

const registry = new Map<string, JsonSchema>();

function loadSchema(file: string): JsonSchema {
  const raw = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8')) as JsonSchema;
  if (typeof raw.$id === 'string') registry.set(raw.$id, raw);
  return raw;
}

function assertKeywordsSupported(schema: JsonSchema, where: string, seen = new Set<JsonSchema>()): string[] {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return [];
  seen.add(schema);
  const unsupported: string[] = [];
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(k)) unsupported.push(`${where}.${k}`);
  }
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' || k === 'definitions') {
      for (const [pk, pv] of Object.entries(v as Record<string, JsonSchema>)) {
        unsupported.push(...assertKeywordsSupported(pv, `${where}.${k}.${pk}`, seen));
      }
    } else if (k === 'items' || k === 'additionalProperties') {
      if (v && typeof v === 'object') unsupported.push(...assertKeywordsSupported(v as JsonSchema, `${where}.${k}`, seen));
    } else if (k === 'oneOf') {
      (v as JsonSchema[]).forEach((s, i) => unsupported.push(...assertKeywordsSupported(s, `${where}.oneOf[${i}]`, seen)));
    }
  }
  return unsupported;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema {
  const [file, pointer] = ref.split('#');
  const base = file ? registry.get(file) : root;
  if (!base) throw new Error(`unresolvable $ref target: ${ref}`);
  if (!pointer || pointer === '') return base;
  let node: any = base;
  for (const seg of pointer.split('/').slice(1)) {
    node = node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`unresolvable $ref pointer: ${ref}`);
  }
  return node as JsonSchema;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

/** Returns a list of error strings; empty means valid. */
function validate(value: unknown, schema: JsonSchema, root: JsonSchema, at = ''): string[] {
  if (schema.$ref) return validate(value, resolveRef(schema.$ref, root), root, at);
  const errors: string[] = [];

  if (schema.const !== undefined && value !== schema.const) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => deepEqual(e, value)))
    errors.push(`${at}: not in enum`);

  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) errors.push(`${at}: type ${typeOf(value)} not in ${types.join('|')}`);
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${at}: not above exclusiveMinimum`);
  }

  if (typeof value === 'string' && typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${at}: does not match pattern ${schema.pattern}`);
  }

  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter((s: JsonSchema) => validate(value, s, root, at).length === 0);
    if (passing.length !== 1) errors.push(`${at}: matched ${passing.length} oneOf branches, expected exactly 1`);
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${at}/${req}: required property missing`);
    }
    const props: Record<string, JsonSchema> = schema.properties ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) {
        errors.push(...validate(v, props[k], root, `${at}/${k}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}/${k}: additional property not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validate(v, schema.additionalProperties as JsonSchema, root, `${at}/${k}`));
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validate(v, schema.items as JsonSchema, root, `${at}/${i}`)));
  }

  return errors;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ------------------------------------------------------------------ setup */

// Load every vendored schema so cross-file $refs resolve.
const treeIr = loadSchema('tree-ir.schema.json');
const diagnostics = loadSchema('diagnostics.schema.json');
const manifest = loadSchema('manifest.schema.json');
const designTokens = loadSchema('design-tokens.schema.json');
const designSpec = loadSchema('design-spec.schema.json');

const readFixture = (rel: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'));

const EPOCH = 'a'.repeat(64);
const FP = 'a'.repeat(64);

interface Case {
  label: string;
  doc: unknown;
  expectValid: boolean;
}

const CASES: { name: string; jsonSchema: JsonSchema; zod: { safeParse(v: unknown): { success: boolean } }; cases: Case[] }[] = [
  {
    name: 'TreeIR',
    jsonSchema: treeIr,
    zod: TreeIRSchema,
    cases: [
      { label: 'golden landing tree', doc: readFixture('trees/valid-core-landing.json'), expectValid: true },
      { label: 'tree using an agent block', doc: readFixture('trees/valid-with-agent-block.json'), expectValid: true },
      { label: 'minimal', doc: { version: 1, epoch: EPOCH, blocks: [] }, expectValid: true },
      { label: 'node with attributes only', doc: { version: 1, epoch: EPOCH, blocks: [{ name: 'core/paragraph', attributes: {} }] }, expectValid: true },
      { label: 'deeply nested', doc: { version: 1, epoch: EPOCH, blocks: [{ name: 'a/b', innerBlocks: [{ name: 'c/d', innerBlocks: [{ name: 'e/f' }] }] }] }, expectValid: true },
      { label: 'innerHTML on a node', doc: readFixture('trees/invalid-tree-schema.json'), expectValid: false },
      { label: 'wrong version', doc: { version: 2, epoch: EPOCH, blocks: [] }, expectValid: false },
      { label: 'missing epoch', doc: { version: 1, blocks: [] }, expectValid: false },
      { label: 'epoch not a string', doc: { version: 1, epoch: 1, blocks: [] }, expectValid: false },
      { label: 'blocks not an array', doc: { version: 1, epoch: EPOCH, blocks: {} }, expectValid: false },
      { label: 'block name without a namespace', doc: { version: 1, epoch: EPOCH, blocks: [{ name: 'paragraph' }] }, expectValid: false },
      { label: 'block name with capitals', doc: { version: 1, epoch: EPOCH, blocks: [{ name: 'Core/Paragraph' }] }, expectValid: false },
      { label: 'node missing name', doc: { version: 1, epoch: EPOCH, blocks: [{ attributes: {} }] }, expectValid: false },
      { label: 'innerContent leaked into a node', doc: { version: 1, epoch: EPOCH, blocks: [{ name: 'core/paragraph', innerContent: [] }] }, expectValid: false },
      { label: 'attributes not an object', doc: { version: 1, epoch: EPOCH, blocks: [{ name: 'core/paragraph', attributes: [] }] }, expectValid: false },
      { label: 'nested node with innerHTML', doc: { version: 1, epoch: EPOCH, blocks: [{ name: 'a/b', innerBlocks: [{ name: 'c/d', innerHTML: '<p></p>' }] }] }, expectValid: false },
    ],
  },
  {
    name: 'Diagnostics',
    jsonSchema: diagnostics,
    zod: DiagnosticsSchema,
    cases: [
      { label: 'clean', doc: { valid: true, epoch_ok: true, diagnostics: [] }, expectValid: true },
      {
        label: 'one error + one warning',
        doc: {
          valid: false,
          epoch_ok: false,
          server_fingerprint: FP,
          diagnostics: [
            { code: 'E_EPOCH_MISMATCH', severity: 'error', path: '/epoch', message: 'stale' },
            { code: 'W_STATIC_NEEDS_HARNESS', severity: 'warning', path: '/blocks/0', message: 'static', fix_hint: 'canonical markup must come from harness compile, do not hand-serialize' },
          ],
        },
        expectValid: true,
      },
      { label: 'missing epoch_ok', doc: { valid: true, diagnostics: [] }, expectValid: false },
      { label: 'unknown diagnostic code', doc: { valid: false, epoch_ok: true, diagnostics: [{ code: 'E_NOPE', severity: 'error', path: '/', message: 'x' }] }, expectValid: false },
      { label: 'unknown severity', doc: { valid: false, epoch_ok: true, diagnostics: [{ code: 'E_ATTR_TYPE', severity: 'fatal', path: '/', message: 'x' }] }, expectValid: false },
      { label: 'diagnostic missing message', doc: { valid: false, epoch_ok: true, diagnostics: [{ code: 'E_ATTR_TYPE', severity: 'error', path: '/' }] }, expectValid: false },
      { label: 'valid not a boolean', doc: { valid: 'yes', epoch_ok: true, diagnostics: [] }, expectValid: false },
      { label: 'diagnostics not an array', doc: { valid: true, epoch_ok: true, diagnostics: {} }, expectValid: false },
    ],
  },
  {
    name: 'Manifest',
    jsonSchema: manifest,
    zod: ManifestSchema,
    cases: [
      { label: 'realistic manifest', doc: sampleManifest(), expectValid: true },
      { label: 'block with null parent and ancestor', doc: withBlock({ parent: null, ancestor: null }), expectValid: true },
      { label: 'block with agent hints', doc: withBlock({ agent_hints: { allowed_blocks: ['core/column'], template_lock: 'all', usage_notes: 'x' } }), expectValid: true },
      { label: 'short fingerprint', doc: { ...sampleManifest(), fingerprint: 'abc' }, expectValid: false },
      { label: 'uppercase fingerprint', doc: { ...sampleManifest(), fingerprint: 'A'.repeat(64) }, expectValid: false },
      { label: 'unknown posture', doc: { ...sampleManifest(), posture: 'staging' }, expectValid: false },
      { label: 'missing counts', doc: omit(sampleManifest(), 'counts'), expectValid: false },
      { label: 'block missing is_dynamic', doc: withBlock({}, true), expectValid: false },
      { label: 'api_version not an integer', doc: withBlock({ api_version: 3.5 }), expectValid: false },
      { label: 'patterns entry missing has_content', doc: { ...sampleManifest(), patterns: [{ name: 'a/b', title: 'T', categories: [], source: null }] }, expectValid: false },
      { label: 'theme_tokens missing layout', doc: { ...sampleManifest(), theme_tokens: { color: {}, spacing: {}, typography: {} } }, expectValid: false },
    ],
  },
  {
    name: 'DesignTokens',
    jsonSchema: designTokens,
    zod: DesignTokensSchema,
    cases: [
      { label: 'sample fixture', doc: readFixture('design-tokens.sample.json'), expectValid: true },
      { label: 'minimal', doc: minimalTokens(), expectValid: true },
      { label: 'fluid as a boolean', doc: tokensWith({ typography: { families: [], sizes: [{ slug: 's', size: '1rem', fluid: true }] } }), expectValid: true },
      { label: 'fluid as min/max', doc: tokensWith({ typography: { families: [], sizes: [{ slug: 's', size: '1rem', fluid: { min: '1rem', max: '2rem' } }] } }), expectValid: true },
      { label: 'palette slug with capitals', doc: tokensWith({ palette: [{ slug: 'Primary', name: 'P', color: '#fff' }] }), expectValid: false },
      { label: 'colour without a hash', doc: tokensWith({ palette: [{ slug: 'p', name: 'P', color: 'ffffff' }] }), expectValid: false },
      { label: 'colour of the wrong length', doc: tokensWith({ palette: [{ slug: 'p', name: 'P', color: '#ffff' }] }), expectValid: false },
      { label: 'unknown palette role', doc: tokensWith({ palette: [{ slug: 'p', name: 'P', color: '#ffffff', role: 'brand' }] }), expectValid: false },
      { label: 'extra key on a palette entry', doc: tokensWith({ palette: [{ slug: 'p', name: 'P', color: '#ffffff', hex: '#fff' }] }), expectValid: false },
      { label: 'unknown scale_unit', doc: tokensWith({ spacing: { scale_unit: 'pt', steps: [] } }), expectValid: false },
      { label: 'spacing size as a number', doc: tokensWith({ spacing: { scale_unit: 'rem', steps: [{ slug: 's', size: 16 }] } }), expectValid: false },
      { label: 'missing layout', doc: omit(minimalTokens(), 'layout'), expectValid: false },
      { label: 'extra top-level key', doc: { ...minimalTokens(), shadows: [] }, expectValid: false },
      { label: 'family missing fontFamily', doc: tokensWith({ typography: { families: [{ slug: 'b', name: 'B' }], sizes: [] } }), expectValid: false },
    ],
  },
  {
    name: 'DesignSpecIR',
    jsonSchema: designSpec,
    zod: DesignSpecIRSchema,
    cases: [
      { label: 'hero-sample', doc: readFixture('specs/hero-sample.json'), expectValid: true },
      { label: 'box-overlap fixture (schema-valid)', doc: readFixture('specs/invalid-box-overlap.json'), expectValid: true },
      { label: 'orphan-content fixture (schema-valid)', doc: readFixture('specs/invalid-orphan-content.json'), expectValid: true },
      { label: 'unquantized fixture (schema-valid)', doc: readFixture('specs/warn-unquantized.json'), expectValid: true },
      { label: 'no-responsive fixture (schema-valid)', doc: readFixture('specs/warn-no-responsive.json'), expectValid: true },
      { label: 'bad region role', doc: readFixture('specs/invalid-spec-schema.json'), expectValid: false },
      { label: 'wrong version', doc: { ...(readFixture('specs/hero-sample.json') as object), version: 2 }, expectValid: false },
      { label: 'unknown source kind', doc: mutate('specs/hero-sample.json', (s: any) => { s.source.kind = 'sketch'; }), expectValid: false },
      { label: 'zero viewport width', doc: mutate('specs/hero-sample.json', (s: any) => { s.source.viewport.width = 0; }), expectValid: false },
      { label: 'negative box width', doc: mutate('specs/hero-sample.json', (s: any) => { s.regions[0].box.w = -10; }), expectValid: false },
      { label: 'unknown content kind', doc: mutate('specs/hero-sample.json', (s: any) => { s.content[0].kind = 'video'; }), expectValid: false },
      { label: 'content missing region_id', doc: mutate('specs/hero-sample.json', (s: any) => { delete s.content[0].region_id; }), expectValid: false },
      { label: 'extra key on a region', doc: mutate('specs/hero-sample.json', (s: any) => { s.regions[0].zIndex = 3; }), expectValid: false },
      { label: 'quantization entry missing delta', doc: mutate('specs/hero-sample.json', (s: any) => { delete s.tokens_candidates.quantization_log[0].delta; }), expectValid: false },
      { label: 'responsive confidence not in enum', doc: mutate('specs/hero-sample.json', (s: any) => { s.regions[0].responsive_assumptions[0].confidence = 'guessed'; }), expectValid: false },
      { label: 'layout direction not in enum', doc: mutate('specs/hero-sample.json', (s: any) => { s.regions[0].layout.direction = 'diagonal'; }), expectValid: false },
      { label: 'columns below 1', doc: mutate('specs/hero-sample.json', (s: any) => { s.regions[0].layout.columns = 0; }), expectValid: false },
      { label: 'nested region with a bad role', doc: mutate('specs/hero-sample.json', (s: any) => { s.regions[0].children[0].role = 'sidebar'; }), expectValid: false },
      { label: 'missing tokens_candidates', doc: mutate('specs/hero-sample.json', (s: any) => { delete s.tokens_candidates; }), expectValid: false },
      // exercises the cross-file $ref into design-tokens.schema.json#/properties/palette
      { label: 'palette colour invalid via the cross-file $ref', doc: mutate('specs/hero-sample.json', (s: any) => { s.tokens_candidates.palette[0].color = 'white'; }), expectValid: false },
      { label: 'spacing scale_unit invalid via the cross-file $ref', doc: mutate('specs/hero-sample.json', (s: any) => { s.tokens_candidates.spacing.scale_unit = 'pt'; }), expectValid: false },
    ],
  },
];

/* ------------------------------------------------------------------- tests */

describe('vendored JSON Schemas use only the supported keyword subset', () => {
  for (const [name, schema] of [
    ['tree-ir', treeIr],
    ['diagnostics', diagnostics],
    ['manifest', manifest],
    ['design-tokens', designTokens],
    ['design-spec', designSpec],
  ] as const) {
    it(`${name} uses no keyword this validator cannot enforce`, () => {
      expect(assertKeywordsSupported(schema, name)).toEqual([]);
    });
  }
});

describe('zod mirrors agree with the vendored JSON Schemas', () => {
  for (const group of CASES) {
    describe(group.name, () => {
      for (const c of group.cases) {
        it(`${c.expectValid ? 'accepts' : 'rejects'}: ${c.label}`, () => {
          const jsonErrors = validate(c.doc, group.jsonSchema, group.jsonSchema);
          const jsonValid = jsonErrors.length === 0;
          const zodValid = group.zod.safeParse(c.doc).success;

          expect(
            jsonValid,
            `JSON Schema disagreed with the expectation. errors: ${jsonErrors.slice(0, 3).join(' | ')}`,
          ).toBe(c.expectValid);
          expect(zodValid, 'zod mirror disagreed with the expectation').toBe(c.expectValid);
          expect(zodValid, 'zod mirror and JSON Schema disagree with EACH OTHER (drift)').toBe(jsonValid);
        });
      }
    });
  }
});

/* --------------------------------------------------------------- helpers */

function omit<T extends Record<string, unknown>>(o: T, key: string): Record<string, unknown> {
  const c = { ...o };
  delete c[key];
  return c;
}

function mutate(rel: string, fn: (o: any) => void): unknown {
  const o = readFixture(rel);
  fn(o);
  return o;
}

function sampleManifest(): Record<string, unknown> {
  return {
    fingerprint: FP,
    generated_at: '2026-01-01T00:00:00+00:00',
    wp_version: '6.7.1',
    site_url: 'https://example.com',
    posture: 'toolchain',
    interfaces_version: '1',
    blocks: {
      'core/paragraph': {
        title: 'Paragraph',
        category: 'text',
        api_version: 3,
        attributes: { content: { type: 'string' } },
        supports: { anchor: true },
        parent: null,
        ancestor: null,
        is_dynamic: false,
        variations_count: 0,
      },
      'core/column': {
        title: 'Column',
        category: 'design',
        api_version: 3,
        attributes: { width: { type: 'string' } },
        parent: ['core/columns'],
        ancestor: null,
        is_dynamic: false,
      },
    },
    patterns: [{ name: 'core/hero', title: 'Hero', categories: ['banner'], source: 'theme', has_content: true }],
    theme_tokens: {
      color: { palette: [] },
      spacing: { spacingSizes: [], spacingScale: {} },
      typography: { fontSizes: [], fontFamilies: [] },
      layout: { contentSize: '720px', wideSize: '1200px' },
    },
    suites: [{ slug: 'kadence-blocks', version: '3.2.29' }],
    counts: { blocks: 2, dynamic_blocks: 0, static_blocks: 2, patterns: 1 },
  };
}

function withBlock(overrides: Record<string, unknown>, dropIsDynamic = false): Record<string, unknown> {
  const m = sampleManifest();
  const base: Record<string, unknown> = {
    title: 'Test',
    category: 'text',
    api_version: 3,
    attributes: {},
    is_dynamic: true,
    ...overrides,
  };
  if (dropIsDynamic) delete base.is_dynamic;
  (m.blocks as Record<string, unknown>)['x/test'] = base;
  return m;
}

function minimalTokens(): Record<string, unknown> {
  return {
    palette: [],
    spacing: { scale_unit: 'rem', steps: [] },
    typography: { families: [], sizes: [] },
    layout: { contentSize: '720px', wideSize: '1200px' },
  };
}

function tokensWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...minimalTokens(), ...overrides };
}
