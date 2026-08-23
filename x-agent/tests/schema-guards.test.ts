import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaScaffold } from '../mcp/src/schemaFactory.js';

function scaffoldAndRead(postType: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-agent-schema-guards-'));
  const result = schemaScaffold({
    slug: 'guards',
    intent: 'Test package for the scaffold guards.',
    post_types: [postType as never],
    dir,
    force: true,
  });
  return result.files.map((f: string) => fs.readFileSync(path.join(result.dir, f), 'utf8')).join('\n');
}

describe('custom-fields is never optional when meta is declared', () => {
  it('forces custom-fields into an explicit supports list that dropped it', () => {
    const php = scaffoldAndRead({
      slug: 'service',
      label: 'Services',
      supports: ['title', 'editor'],
      meta: [{ key: 'price', type: 'string' }],
    });
    expect(php).toMatch(/'supports'\s+=>\s+array\( "title", "editor", "custom-fields" \)/);
  });

  it('leaves an explicit supports list alone when there is no meta', () => {
    const php = scaffoldAndRead({ slug: 'service', label: 'Services', supports: ['title', 'editor'] });
    expect(php).toMatch(/'supports'\s+=>\s+array\( "title", "editor" \)/);
    expect(php).not.toMatch(/"editor", "custom-fields"/);
  });
});

describe('the URL map is explicit for public post types', () => {
  it('emits rewrite and has_archive for a public type', () => {
    const php = scaffoldAndRead({
      slug: 'service',
      label: 'Services',
      public: true,
      rewrite_slug: 'offerings',
      has_archive: true,
    });
    expect(php).toMatch(/'rewrite'\s+=>\s+array\( 'slug' => "offerings" \)/);
    expect(php).toMatch(/'has_archive'\s+=>\s+true/);
  });

  it('defaults the rewrite to the post type slug, archive off', () => {
    const php = scaffoldAndRead({ slug: 'service', label: 'Services', public: true });
    expect(php).toMatch(/'rewrite'\s+=>\s+array\( 'slug' => "service" \)/);
    expect(php).toMatch(/'has_archive'\s+=>\s+false/);
  });

  it('emits no rewrite for a data-first (non-public) type', () => {
    const php = scaffoldAndRead({ slug: 'service', label: 'Services' });
    expect(php).not.toMatch(/'rewrite'/);
    expect(php).not.toMatch(/'has_archive'/);
  });
});
