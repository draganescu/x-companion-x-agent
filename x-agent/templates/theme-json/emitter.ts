/**
 * DesignTokens -> theme.json `settings` object.
 *
 * PURE. No I/O, no globals, no clock. This mirrors what the companion writes
 * server-side on POST /theme/tokens (companion spec: settings.color.palette,
 * settings.spacing.spacingSizes, settings.typography.fontSizes/fontFamilies,
 * settings.layout) so the agent can diff a proposed token set against the
 * instance's resolved `manifest.theme_tokens` locally, before spending an
 * extend-tier round trip.
 *
 * It emits exactly those four groups and nothing else — anything extra would be
 * a claim about server behaviour this side cannot honour.
 */
import type { DesignTokens } from '../../mcp/src/schemas.js';

export interface ThemeJsonPaletteEntry {
  slug: string;
  name: string;
  color: string;
}
export interface ThemeJsonSpacingSize {
  slug: string;
  name: string;
  size: string;
}
export interface ThemeJsonFontSize {
  slug: string;
  name: string;
  size: string;
  fluid?: boolean | { min?: string; max?: string };
}
export interface ThemeJsonFontFamily {
  slug: string;
  name: string;
  fontFamily: string;
  /** Font Library activation data (theme-factory font lane): rides into the
   * user global styles so wp_print_font_faces emits @font-face for it. */
  fontFace?: Array<{ fontFamily: string; fontStyle: string; fontWeight: string; src: string[] }>;
}

export interface ThemeJsonSettings {
  color: { palette: ThemeJsonPaletteEntry[] };
  spacing: { spacingSizes: ThemeJsonSpacingSize[] };
  typography: { fontSizes: ThemeJsonFontSize[]; fontFamilies: ThemeJsonFontFamily[] };
  layout: { contentSize: string; wideSize: string };
}

export interface ThemeJson {
  $schema: string;
  version: 3;
  settings: ThemeJsonSettings;
}

/** `x-large` -> `X Large`, `step-40` -> `Step 40`. */
export function slugToName(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The pure emitter. */
export function emitThemeJsonSettings(tokens: DesignTokens): ThemeJsonSettings {
  return {
    color: {
      palette: tokens.palette.map((p) => ({ slug: p.slug, name: p.name, color: p.color })),
    },
    spacing: {
      spacingSizes: tokens.spacing.steps.map((s) => ({
        slug: s.slug,
        name: slugToName(s.slug),
        size: s.size,
      })),
    },
    typography: {
      fontSizes: tokens.typography.sizes.map((s) => {
        const entry: ThemeJsonFontSize = { slug: s.slug, name: slugToName(s.slug), size: s.size };
        if (s.fluid !== undefined) entry.fluid = s.fluid;
        return entry;
      }),
      fontFamilies: tokens.typography.families.map((f) => {
        const entry: ThemeJsonFontFamily = { slug: f.slug, name: f.name, fontFamily: f.fontFamily };
        // `source` is an AGENT-side download instruction and never reaches
        // theme.json; `fontFace` is the activation payload and does.
        if (f.fontFace !== undefined) entry.fontFace = f.fontFace;
        return entry;
      }),
    },
    layout: {
      contentSize: tokens.layout.contentSize,
      wideSize: tokens.layout.wideSize,
    },
  };
}

/** Convenience wrapper producing a complete theme.json document. */
export function emitThemeJson(tokens: DesignTokens): ThemeJson {
  return {
    $schema: 'https://schemas.wp.org/trunk/theme.json',
    version: 3,
    settings: emitThemeJsonSettings(tokens),
  };
}

export interface ThemeTokenDiff {
  group: 'color.palette' | 'spacing.spacingSizes' | 'typography.fontSizes' | 'typography.fontFamilies' | 'layout';
  slug: string;
  kind: 'missing_on_instance' | 'value_differs';
  expected: string;
  actual: string | null;
}

/**
 * Diff the emitted settings against `manifest.theme_tokens` (the instance's
 * resolved wp_get_global_settings() subset). Best effort: the instance shape is
 * loose, so anything unrecognised is skipped rather than guessed at.
 */
export function diffAgainstThemeTokens(settings: ThemeJsonSettings, themeTokens: unknown): ThemeTokenDiff[] {
  const diffs: ThemeTokenDiff[] = [];
  const t = (themeTokens ?? {}) as Record<string, Record<string, unknown>>;

  const indexBySlug = (v: unknown, valueKey: string): Map<string, string> => {
    const m = new Map<string, string>();
    if (!Array.isArray(v)) return m;
    for (const e of v) {
      if (e && typeof e === 'object' && typeof (e as Record<string, unknown>).slug === 'string') {
        const val = (e as Record<string, unknown>)[valueKey];
        m.set(String((e as Record<string, unknown>).slug), val === undefined ? '' : String(val));
      }
    }
    return m;
  };

  const compare = (
    group: ThemeTokenDiff['group'],
    expected: { slug: string; value: string }[],
    actual: Map<string, string>,
  ) => {
    for (const e of expected) {
      const a = actual.get(e.slug);
      if (a === undefined) diffs.push({ group, slug: e.slug, kind: 'missing_on_instance', expected: e.value, actual: null });
      else if (a.toLowerCase() !== e.value.toLowerCase())
        diffs.push({ group, slug: e.slug, kind: 'value_differs', expected: e.value, actual: a });
    }
  };

  compare(
    'color.palette',
    settings.color.palette.map((p) => ({ slug: p.slug, value: p.color })),
    indexBySlug(t.color?.palette, 'color'),
  );
  compare(
    'spacing.spacingSizes',
    settings.spacing.spacingSizes.map((s) => ({ slug: s.slug, value: s.size })),
    indexBySlug(t.spacing?.spacingSizes, 'size'),
  );
  compare(
    'typography.fontSizes',
    settings.typography.fontSizes.map((s) => ({ slug: s.slug, value: s.size })),
    indexBySlug(t.typography?.fontSizes, 'size'),
  );
  compare(
    'typography.fontFamilies',
    settings.typography.fontFamilies.map((f) => ({ slug: f.slug, value: f.fontFamily })),
    indexBySlug(t.typography?.fontFamilies, 'fontFamily'),
  );

  const layout = (t.layout ?? {}) as Record<string, unknown>;
  for (const key of ['contentSize', 'wideSize'] as const) {
    const actual = layout[key] === undefined ? null : String(layout[key]);
    const expected = settings.layout[key];
    if (actual === null) diffs.push({ group: 'layout', slug: key, kind: 'missing_on_instance', expected, actual: null });
    else if (actual !== expected) diffs.push({ group: 'layout', slug: key, kind: 'value_differs', expected, actual });
  }

  return diffs;
}
