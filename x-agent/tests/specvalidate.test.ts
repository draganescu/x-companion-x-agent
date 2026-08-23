/**
 * M6: wp_spec_validate (fully local) and the theme.json emitter.
 *
 * Every E_/W_ code has a crafted fixture that triggers it AND NOTHING ELSE, so
 * a regression in one check cannot hide behind another. hero-sample.json must
 * pass clean.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../mcp/src/context.js';
import { callTool } from '../mcp/src/server.js';
import { validateDesignSpec, quantizableValues, BOX_SLACK_RATIO } from '../mcp/src/tools/specValidate.js';
import { DesignSpecIRSchema, type DesignSpecIR, type DesignTokens } from '../mcp/src/schemas.js';
import { emitThemeJsonSettings, emitThemeJson, slugToName, diffAgainstThemeTokens } from '../templates/theme-json/emitter.js';
import { MOCK_THEME_TOKENS } from './mock-companion/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', 'fixtures');
const readSpec = (n: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'specs', n), 'utf8'));
const codesOf = (r: { diagnostics: { code: string }[] }): string[] => r.diagnostics.map((d) => d.code);

let runtime: Runtime;
let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'x-agent-spec-'));
  runtime = new Runtime({ cwd, env: {} }); // deliberately NO connection config
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

async function callSpecValidate(spec: unknown): Promise<{ ok: boolean; data: any }> {
  const res = await callTool('wp_spec_validate', spec, runtime);
  return { ok: !res.isError, data: JSON.parse(res.content[0]!.text) };
}

/* ------------------------------------------------------------- fixtures */

describe('wp_spec_validate fixtures', () => {
  it('hero-sample.json passes clean', () => {
    const r = validateDesignSpec(readSpec('hero-sample.json'));
    expect(r.diagnostics).toEqual([]);
    expect(r.valid).toBe(true);
  });

  const matrix: [string, string][] = [
    ['invalid-spec-schema.json', 'E_SPEC_SCHEMA'],
    ['invalid-box-overlap.json', 'E_BOX_OVERLAP'],
    ['invalid-orphan-content.json', 'E_ORPHAN_CONTENT'],
    ['warn-unquantized.json', 'W_UNQUANTIZED'],
    ['warn-no-responsive.json', 'W_NO_RESPONSIVE'],
  ];

  for (const [file, code] of matrix) {
    it(`${file} triggers exactly one ${code} and nothing else`, () => {
      const r = validateDesignSpec(readSpec(file));
      expect(codesOf(r)).toEqual([code]);
      expect(r.valid).toBe(!code.startsWith('E_'));
      expect(r.diagnostics[0]!.fix_hint.length).toBeGreaterThan(20);
    });
  }

  it('every declared code is covered by a fixture', () => {
    const covered = new Set(matrix.map(([, c]) => c));
    expect([...covered].sort()).toEqual(
      ['E_BOX_OVERLAP', 'E_ORPHAN_CONTENT', 'E_SPEC_SCHEMA', 'W_NO_RESPONSIVE', 'W_UNQUANTIZED'].sort(),
    );
  });
});

/* ---------------------------------------------------------- check details */

describe('E_SPEC_SCHEMA stops everything else', () => {
  it('a schema-invalid spec reports only E_SPEC_SCHEMA even when other checks would fire', () => {
    const spec = readSpec('hero-sample.json') as any;
    spec.regions[0].role = 'banner'; // schema error
    spec.content[0].region_id = 'nope'; // would be E_ORPHAN_CONTENT
    delete spec.regions[0].responsive_assumptions; // would be W_NO_RESPONSIVE
    const r = validateDesignSpec(spec);
    expect(new Set(codesOf(r))).toEqual(new Set(['E_SPEC_SCHEMA']));
  });

  it('an entirely wrong shape is E_SPEC_SCHEMA, not a crash', () => {
    for (const bad of [null, 42, 'nope', [], {}]) {
      const r = validateDesignSpec(bad);
      expect(r.valid).toBe(false);
      expect(codesOf(r).every((c) => c === 'E_SPEC_SCHEMA')).toBe(true);
    }
  });
});

describe('E_BOX_OVERLAP', () => {
  const base = (): any => readSpec('hero-sample.json');

  it('accepts a child inside the 2% slack band', () => {
    const spec = base();
    const parent = spec.regions[0].box; // 1440 x 720 at 0,0
    const slackX = parent.w * BOX_SLACK_RATIO;
    spec.regions[0].children[1].box = { x: -slackX + 1, y: 0, w: 100, h: 100 };
    expect(codesOf(validateDesignSpec(spec))).toEqual([]);
  });

  it('rejects a child just outside the slack band', () => {
    const spec = base();
    const parent = spec.regions[0].box;
    const slackX = parent.w * BOX_SLACK_RATIO;
    spec.regions[0].children[1].box = { x: -slackX - 1, y: 0, w: 100, h: 100 };
    expect(codesOf(validateDesignSpec(spec))).toEqual(['E_BOX_OVERLAP']);
  });

  it('checks grandchildren too', () => {
    const spec = base();
    spec.regions[0].children[0].children[0].box = { x: 0, y: 0, w: 2000, h: 2000 };
    const r = validateDesignSpec(spec);
    expect(codesOf(r)).toEqual(['E_BOX_OVERLAP']);
    expect(r.diagnostics[0]!.path).toBe('/regions/0/children/0/children/0/box');
  });

  it('reports one diagnostic per offending child, naming both regions', () => {
    const spec = base();
    spec.regions[0].children[0].box = { x: -500, y: 0, w: 100, h: 100 };
    spec.regions[0].children[1].box = { x: 3000, y: 0, w: 100, h: 100 };
    // moving hero-copy also moves its child out of hero-copy
    const r = validateDesignSpec(spec);
    expect(r.diagnostics.filter((d) => d.code === 'E_BOX_OVERLAP').length).toBeGreaterThanOrEqual(2);
    expect(r.diagnostics[0]!.message).toContain('hero');
  });
});

describe('E_ORPHAN_CONTENT', () => {
  it('resolves region ids at any depth', () => {
    const spec = readSpec('hero-sample.json') as any;
    // hero-actions is a grandchild region; content already points at it
    expect(spec.content.some((c: { region_id: string }) => c.region_id === 'hero-actions')).toBe(true);
    expect(codesOf(validateDesignSpec(spec))).toEqual([]);
  });

  it('names the content item and the missing region', () => {
    const r = validateDesignSpec(readSpec('invalid-orphan-content.json'));
    expect(r.diagnostics[0]!.message).toContain('hero-buttons');
    expect(r.diagnostics[0]!.path).toBe('/content/3/region_id');
  });

  it('reports one diagnostic per orphaned item', () => {
    const spec = readSpec('hero-sample.json') as any;
    spec.content[0].region_id = 'ghost-1';
    spec.content[1].region_id = 'ghost-2';
    expect(codesOf(validateDesignSpec(spec))).toEqual(['E_ORPHAN_CONTENT', 'E_ORPHAN_CONTENT']);
  });
});

describe('W_UNQUANTIZED', () => {
  it('quantizableValues covers palette colours, spacing sizes, font sizes and the layout widths', () => {
    const spec = DesignSpecIRSchema.parse(readSpec('hero-sample.json'));
    const paths = quantizableValues(spec).map((v) => v.path);
    expect(paths).toContain('/tokens_candidates/palette/0/color');
    expect(paths).toContain('/tokens_candidates/spacing/steps/0/size');
    expect(paths).toContain('/tokens_candidates/typography/sizes/0/size');
    expect(paths).toContain('/tokens_candidates/layout/contentSize');
    expect(paths).toContain('/tokens_candidates/layout/wideSize');
    // font FAMILIES are not measured values and are deliberately not required
    expect(paths.some((p) => p.includes('families'))).toBe(false);
  });

  it('an empty quantization log warns once for every token value', () => {
    const spec = readSpec('hero-sample.json') as any;
    const expected = quantizableValues(DesignSpecIRSchema.parse(spec)).length;
    spec.tokens_candidates.quantization_log = [];
    const r = validateDesignSpec(spec);
    expect(codesOf(r).length).toBe(expected);
    expect(codesOf(r).every((c) => c === 'W_UNQUANTIZED')).toBe(true);
    expect(r.valid).toBe(true); // warnings never invalidate
  });

  it('matches snapped_to by value, not by slug', () => {
    const spec = readSpec('hero-sample.json') as any;
    spec.tokens_candidates.layout.contentSize = '768px';
    const r = validateDesignSpec(spec);
    expect(codesOf(r)).toEqual(['W_UNQUANTIZED']);
    expect(r.diagnostics[0]!.path).toBe('/tokens_candidates/layout/contentSize');
  });
});

describe('W_NO_RESPONSIVE', () => {
  it('only top-level regions are required to declare assumptions', () => {
    const spec = readSpec('hero-sample.json') as any;
    // children have none, and that is fine
    expect(spec.regions[0].children.every((c: any) => c.responsive_assumptions === undefined)).toBe(true);
    expect(codesOf(validateDesignSpec(spec))).toEqual([]);
  });

  it('an empty array counts as none', () => {
    const spec = readSpec('hero-sample.json') as any;
    spec.regions[0].responsive_assumptions = [];
    expect(codesOf(validateDesignSpec(spec))).toEqual(['W_NO_RESPONSIVE']);
  });

  it('warns once per top-level region', () => {
    const spec = readSpec('warn-no-responsive.json') as any;
    spec.regions.push({ id: 'footer', role: 'footer', box: { x: 0, y: 720, w: 1440, h: 180 } });
    expect(codesOf(validateDesignSpec(spec))).toEqual(['W_NO_RESPONSIVE', 'W_NO_RESPONSIVE']);
  });
});

/* ------------------------------------------------------ the tool wrapper */

describe('wp_spec_validate as an MCP tool', () => {
  it('runs with NO connection config at all', async () => {
    const r = await callSpecValidate(readSpec('hero-sample.json'));
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ valid: true, diagnostics: [] });
  });

  it('reports a malformed spec as E_SPEC_SCHEMA diagnostics, not as invalid_input', async () => {
    const r = await callSpecValidate({ version: 2 });
    expect(r.ok).toBe(true);
    expect(r.data.valid).toBe(false);
    expect(r.data.diagnostics.every((d: { code: string }) => d.code === 'E_SPEC_SCHEMA')).toBe(true);
  });

  it('rejects a wrong-typed container (version as a string) at the input boundary', async () => {
    const r = await callSpecValidate({ version: 'one' });
    expect(r.ok).toBe(false);
    expect(r.data.code).toBe('invalid_input');
  });

  it('output always carries fix_hint on every diagnostic', async () => {
    for (const f of ['invalid-box-overlap.json', 'invalid-orphan-content.json', 'warn-unquantized.json', 'warn-no-responsive.json']) {
      const r = await callSpecValidate(readSpec(f));
      expect(r.data.diagnostics.every((d: { fix_hint?: string }) => typeof d.fix_hint === 'string' && d.fix_hint.length > 0)).toBe(true);
    }
  });
});

/* ------------------------------------------------------- theme.json emitter */

const sampleTokens = (): DesignTokens =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, 'design-tokens.sample.json'), 'utf8')) as DesignTokens;

describe('theme.json emitter', () => {
  it('is pure: same input, deep-equal output, input untouched', () => {
    const tokens = sampleTokens();
    const snapshot = JSON.stringify(tokens);
    const a = emitThemeJsonSettings(tokens);
    const b = emitThemeJsonSettings(tokens);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(JSON.stringify(tokens)).toBe(snapshot);
  });

  it('emits exactly the four groups the companion writes server-side', () => {
    const s = emitThemeJsonSettings(sampleTokens());
    expect(Object.keys(s).sort()).toEqual(['color', 'layout', 'spacing', 'typography']);
    expect(Object.keys(s.color)).toEqual(['palette']);
    expect(Object.keys(s.spacing)).toEqual(['spacingSizes']);
    expect(Object.keys(s.typography).sort()).toEqual(['fontFamilies', 'fontSizes']);
    expect(Object.keys(s.layout).sort()).toEqual(['contentSize', 'wideSize']);
  });

  it('maps palette entries to {slug,name,color} and drops role', () => {
    const s = emitThemeJsonSettings(sampleTokens());
    expect(s.color.palette[0]).toEqual({ slug: 'base', name: 'Base', color: '#ffffff' });
    expect(s.color.palette.every((p) => !('role' in p))).toBe(true);
    expect(s.color.palette.length).toBe(7);
  });

  it('maps spacing steps to spacingSizes with derived names', () => {
    const s = emitThemeJsonSettings(sampleTokens());
    expect(s.spacing.spacingSizes[0]).toEqual({ slug: '20', name: '20', size: '0.5rem' });
    expect(s.spacing.spacingSizes.length).toBe(6);
  });

  it('carries fluid through in both of its shapes and derives font-size names', () => {
    const s = emitThemeJsonSettings(sampleTokens());
    const byslug = Object.fromEntries(s.typography.fontSizes.map((f) => [f.slug, f]));
    expect(byslug['small']).toEqual({ slug: 'small', name: 'Small', size: '0.875rem' });
    expect(byslug['x-large']!.name).toBe('X Large');
    expect(byslug['x-large']!.fluid).toEqual({ min: '1.75rem', max: '2.25rem' });
    expect(byslug['xx-large']!.fluid).toBe(true);
    expect(byslug['medium']).not.toHaveProperty('fluid');
  });

  it('keeps the author-supplied family names verbatim', () => {
    const s = emitThemeJsonSettings(sampleTokens());
    expect(s.typography.fontFamilies).toEqual([
      { slug: 'body', name: 'Body', fontFamily: '"Inter", system-ui, sans-serif' },
      { slug: 'heading', name: 'Heading', fontFamily: '"Playfair Display", Georgia, serif' },
    ]);
  });

  it('slugToName handles the WordPress slug conventions', () => {
    expect(slugToName('x-large')).toBe('X Large');
    expect(slugToName('accent-1')).toBe('Accent 1');
    expect(slugToName('50')).toBe('50');
    expect(slugToName('')).toBe('');
  });

  it('emitThemeJson wraps the settings in a version-3 document', () => {
    const doc = emitThemeJson(sampleTokens());
    expect(doc.version).toBe(3);
    expect(doc.$schema).toContain('schemas.wp.org');
    expect(doc.settings).toEqual(emitThemeJsonSettings(sampleTokens()));
  });

  it('handles an empty token set without throwing', () => {
    const empty: DesignTokens = {
      palette: [],
      spacing: { scale_unit: 'rem', steps: [] },
      typography: { families: [], sizes: [] },
      layout: { contentSize: '600px', wideSize: '1000px' },
    };
    expect(emitThemeJsonSettings(empty)).toEqual({
      color: { palette: [] },
      spacing: { spacingSizes: [] },
      typography: { fontSizes: [], fontFamilies: [] },
      layout: { contentSize: '600px', wideSize: '1000px' },
    });
  });
});

describe('diffAgainstThemeTokens', () => {
  it('reports nothing when the instance already matches', () => {
    const settings = {
      color: { palette: [{ slug: 'base', name: 'Base', color: '#ffffff' }] },
      spacing: { spacingSizes: [{ slug: '20', name: '20', size: '0.5rem' }] },
      typography: {
        fontSizes: [{ slug: 'small', name: 'Small', size: '0.875rem' }],
        fontFamilies: [{ slug: 'body', name: 'Body', fontFamily: '"Inter", sans-serif' }],
      },
      layout: { contentSize: '720px', wideSize: '1200px' },
    };
    expect(diffAgainstThemeTokens(settings, MOCK_THEME_TOKENS)).toEqual([]);
  });

  it('flags tokens the instance does not have', () => {
    const settings = emitThemeJsonSettings(sampleTokens());
    const diffs = diffAgainstThemeTokens(settings, MOCK_THEME_TOKENS);
    const missing = diffs.filter((d) => d.kind === 'missing_on_instance').map((d) => d.slug);
    expect(missing).toContain('surface'); // not in the mock palette
    expect(missing).toContain('accent'); // the mock calls it accent-1
    expect(missing).toContain('70'); // spacing step the mock theme lacks
    // the slugs the instance already carries at the same value are silent
    expect(diffs.some((d) => d.slug === 'base')).toBe(false);
    expect(diffs.some((d) => d.slug === 'contrast')).toBe(false);
  });

  it('flags a token whose value moved, and compares colours case-insensitively', () => {
    const tokens = sampleTokens();
    tokens.palette[0]!.color = '#FFFFFF'; // same colour, different case -> silent
    tokens.palette[2]!.color = '#000000'; // contrast really changed -> value_differs
    tokens.layout.contentSize = '800px';
    const diffs = diffAgainstThemeTokens(emitThemeJsonSettings(tokens), MOCK_THEME_TOKENS);
    expect(diffs.some((d) => d.slug === 'base')).toBe(false);
    expect(diffs).toContainEqual({ group: 'color.palette', slug: 'contrast', kind: 'value_differs', expected: '#000000', actual: '#111111' });
    expect(diffs).toContainEqual({ group: 'layout', slug: 'contentSize', kind: 'value_differs', expected: '800px', actual: '720px' });
  });

  it('tolerates a completely unrecognised theme_tokens shape', () => {
    const settings = emitThemeJsonSettings(sampleTokens());
    expect(() => diffAgainstThemeTokens(settings, {})).not.toThrow();
    expect(() => diffAgainstThemeTokens(settings, null)).not.toThrow();
    expect(diffAgainstThemeTokens(settings, {}).every((d) => d.kind === 'missing_on_instance')).toBe(true);
  });
});
