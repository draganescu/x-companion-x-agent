/**
 * mergeClientCapture + sectionEnvelope — the interfaces-v2 client-capture
 * merge is pure and additive: server entries win on name collision, client
 * entries join with their source label, the input manifest is never mutated.
 */
import { describe, expect, it } from 'vitest';
import { mergeClientCapture, sectionEnvelope } from '../mcp/src/tools/manifest.js';
import type { Manifest } from '../mcp/src/schemas.js';
import type { ClientCapture } from '../mcp/src/session.js';

const manifest = (): Manifest => ({
  fingerprint: 'a'.repeat(64),
  generated_at: '2026-08-22T00:00:00+00:00',
  wp_version: '7.1',
  site_url: 'http://127.0.0.1:9410',
  posture: 'toolchain',
  interfaces_version: '2',
  blocks: {
    'core/embed': {
      title: 'Embed',
      category: 'embed',
      api_version: 3,
      attributes: {},
      is_dynamic: false,
      variations_count: 0,
      variations: [],
      styles: [],
    },
    'core/button': {
      title: 'Button',
      category: 'design',
      api_version: 3,
      attributes: {},
      is_dynamic: true,
      variations_count: 1,
      variations: [{ name: 'core-button-default', title: 'Default', source: 'server' }],
      styles: [{ name: 'outline', label: 'Outline', source: 'theme' }],
    },
  },
  patterns: [],
  theme_tokens: { color: {}, spacing: {}, typography: {}, layout: {} },
  suites: [],
  bindings: { sources: [] },
  counts: { blocks: 2, dynamic_blocks: 1, static_blocks: 1, patterns: 0 },
});

const capture: ClientCapture = {
  fingerprint: 'a'.repeat(64),
  variations: {
    'core/embed': [
      { name: 'youtube', title: 'YouTube', attributes: { providerNameSlug: 'youtube' } },
      { name: 'vimeo', title: 'Vimeo' },
    ],
    'core/button': [{ name: 'core-button-default', title: 'Default (client duplicate)' }],
  },
  styles: {
    'core/button': [
      { name: 'outline', label: 'Outline (client duplicate)' },
      { name: 'fill', label: 'Fill' },
    ],
  },
};

describe('mergeClientCapture', () => {
  it('adds client variations with source client, keeps server entries on collision', () => {
    const merged = mergeClientCapture(manifest(), capture);

    const embed = merged.blocks['core/embed']!;
    expect(embed.variations!.map((v) => v.name)).toEqual(['vimeo', 'youtube']);
    expect(embed.variations!.every((v) => v.source === 'client')).toBe(true);

    const button = merged.blocks['core/button']!;
    expect(button.variations).toEqual([{ name: 'core-button-default', title: 'Default', source: 'server' }]);
  });

  it('adds client styles as plugin-sourced, server styles win on collision', () => {
    const merged = mergeClientCapture(manifest(), capture);
    const button = merged.blocks['core/button']!;
    expect(button.styles).toEqual([
      { name: 'fill', label: 'Fill', source: 'plugin' },
      { name: 'outline', label: 'Outline', source: 'theme' },
    ]);
  });

  it('never mutates the input manifest', () => {
    const input = manifest();
    const before = JSON.stringify(input);
    mergeClientCapture(input, capture);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('sectionEnvelope', () => {
  it('extracts styles/variations as block-name maps, only non-empty', () => {
    const merged = mergeClientCapture(manifest(), capture);
    const env = sectionEnvelope(merged, 'variations');
    expect(env.section).toBe('variations');
    expect(Object.keys(env.variations as Record<string, unknown>).sort()).toEqual(['core/button', 'core/embed']);

    const styles = sectionEnvelope(merged, 'styles');
    expect(Object.keys(styles.styles as Record<string, unknown>)).toEqual(['core/button']);
  });

  it('passes top-level sections through, defaulting to {}', () => {
    const env = sectionEnvelope(manifest(), 'bindings');
    expect(env.bindings).toEqual({ sources: [] });
    expect(sectionEnvelope(manifest(), 'features').features).toEqual({});
  });
});
