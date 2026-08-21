/**
 * Tool-level tests driven through the real MCP call path (`callTool`), against
 * the mock companion. Covers M1 (registry/list-tools, structured errors) and
 * M2 (wp_connect, wp_manifest, wp_patterns, wp_validate, wp_parse).
 *
 * The load-bearing assertion here is the wp_validate local pre-check: a
 * schema-invalid tree must produce E_TREE_SCHEMA with ZERO `/validate` hits on
 * the mock.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockCompanion, type MockCompanion } from './mock-companion/index.js';
import { Runtime } from '../mcp/src/context.js';
import { callTool, describeTool, toJsonSchema } from '../mcp/src/server.js';
import { TOOLS, loadExternalHandlers, findTool, unimplementedToolNames, isUnimplemented } from '../mcp/src/registry.js';
import { clearSecrets, errNotImplemented } from '../mcp/src/errors.js';
import { clearPatternCache } from '../mcp/src/tools/patterns.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', 'fixtures');
const readTree = (n: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, 'trees', n), 'utf8'));

const USER = 'agent';
const PW = 'aaaa bbbb cccc dddd eeee ffff';
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

const EXPECTED_16 = [
  'wp_connect',
  'wp_disconnect',
  'wp_manifest',
  'wp_patterns',
  'wp_validate',
  'wp_compile',
  'wp_render',
  'wp_verify',
  'wp_screenshot',
  'wp_spec_validate',
  'wp_tokens_apply',
  'wp_block_scaffold',
  'wp_block_build_test',
  'wp_block_install',
  'wp_parse',
  'wp_snapshot',
];

let mock: MockCompanion;
let runtime: Runtime;
let cwd: string;

beforeAll(async () => {
  await loadExternalHandlers();
});

beforeEach(async () => {
  mock = await startMockCompanion({ fingerprint: FP_A, user: USER, password: PW });
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'x-agent-tool-'));
  runtime = new Runtime({
    cwd,
    env: { X_WP_URL: mock.url, X_WP_USER: USER, X_WP_APP_PASSWORD: PW },
  });
  clearPatternCache();
  clearSecrets();
});

afterEach(async () => {
  await runtime.disconnect();
  await mock.close();
  fs.rmSync(cwd, { recursive: true, force: true });
  clearSecrets();
});

async function call(name: string, args: unknown = {}): Promise<{ ok: boolean; data: any }> {
  const res = await callTool(name, args, runtime);
  return { ok: !res.isError, data: JSON.parse(res.content[0]!.text) };
}

/* ------------------------------------------------------------ M1: registry */

describe('registry / tools list', () => {
  it('declares exactly the 16 tools, with schemas, regardless of which handlers exist', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...EXPECTED_16].sort());
    for (const t of TOOLS) {
      const described = describeTool(t);
      expect(described.name, `${t.name} name`).toBe(t.name);
      expect(String(described.description).length, `${t.name} description`).toBeGreaterThan(40);
      expect(toJsonSchema(t.inputSchema).type, `${t.name} input schema`).toBe('object');
      expect(toJsonSchema(t.outputSchema).type, `${t.name} output schema`).toBe('object');
    }
  });

  // The six session/oracle/factory tools are now all implemented. What is worth
  // asserting is the end state (every declared tool has a real handler) plus the
  // fact that the placeholder MECHANISM still works, since it is what keeps the
  // server bootable while a track is mid-build. The mechanism is exercised against
  // a synthetic entry rather than a genuinely missing module, so this test does not
  // silently turn back into a no-op the way the old build-order assertions did.
  it('every declared tool now resolves to a real handler', async () => {
    await loadExternalHandlers({ force: true });
    expect(unimplementedToolNames()).toEqual([]);
    for (const name of EXPECTED_16) {
      expect(isUnimplemented(name), `${name} should have a real handler`).toBe(false);
      expect(typeof findTool(name)?.handler, `${name} handler`).toBe('function');
    }
  });

  it('the not_implemented placeholder is still a structured error, not a crash', async () => {
    // Swap one real handler for the placeholder shape the registry installs while a
    // module is absent, and prove a call against it degrades cleanly.
    const tool = findTool('wp_compile')!;
    const real = tool.handler;
    tool.handler = async () => {
      throw errNotImplemented('wp_compile');
    };
    try {
      const r = await call('wp_compile', { version: 1, epoch: FP_A, blocks: [] });
      expect(r.ok).toBe(false);
      expect(r.data.code).toBe('not_implemented');
      expect(r.data.hint).toContain('src/tools/');

      // Ordering note: for a tool that needs a connection, config resolution runs
      // BEFORE the handler, so with no config at all the gate that fires first is
      // the config gate, not the handler. That is the intended precedence.
      const bare = new Runtime({ cwd, env: {} });
      const res = await callTool('wp_compile', { version: 1, epoch: FP_A, blocks: [] }, bare);
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0]!.text).code).toBe('invalid_input');
    } finally {
      tool.handler = real;
    }
  });

  it('an unknown tool is invalid_input, not a throw', async () => {
    const r = await call('wp_nope');
    expect(r.ok).toBe(false);
    expect(r.data.code).toBe('invalid_input');
  });

  it('bad arguments are invalid_input, not a throw', async () => {
    const r = await call('wp_render', { markup: 42 });
    expect(r.ok).toBe(false);
    expect(r.data.code).toBe('invalid_input');
    expect(r.data.message).toContain('markup');
  });

  it('the loader is idempotent, loads every external module, and none fail', async () => {
    const first = await loadExternalHandlers({ force: true });
    expect(first.missing).toEqual([]);
    expect(first.failed).toEqual([]);
    expect(TOOLS.length).toBe(16);

    // Running it again must not duplicate or drop entries.
    const second = await loadExternalHandlers({ force: true });
    expect(second.failed).toEqual([]);
    expect(TOOLS.length).toBe(16);
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...EXPECTED_16].sort());
  });

  it('every tool has a unique name and findTool resolves it', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(findTool(n)?.name).toBe(n);
  });
});

/* ------------------------------------- M2: connect / manifest / patterns */

describe('wp_connect', () => {
  it('resolves config from env, probes fingerprint + manifest, and reports the epoch', async () => {
    const r = await call('wp_connect');
    expect(r.ok).toBe(true);
    expect(r.data.fingerprint).toBe(FP_A);
    expect(r.data.posture).toBe('toolchain');
    expect(r.data.wp_version).toBe('6.7.1');
    expect(r.data.blocks_count).toBeGreaterThan(10);
    expect(r.data.suites).toEqual(['kadence-blocks']);
    expect(r.data.url_form).toBe('pretty');
    expect(r.data.config_sources).toEqual({ url: 'env', user: 'env', app_password: 'env' });
    expect(JSON.stringify(r.data)).not.toContain(PW);
    expect(JSON.stringify(r.data)).not.toContain(PW.replace(/ /g, ''));
  });

  it('refuses plain http to a public host with https_required', async () => {
    const r = await call('wp_connect', { url: 'http://public.example.com', user: 'a', app_password: PW });
    expect(r.ok).toBe(false);
    expect(r.data.code).toBe('https_required');
  });

  it('pins the connection for later calls, and wp_disconnect drops it', async () => {
    await call('wp_connect');
    const bare = new Runtime({ cwd, env: {} });
    expect((await callTool('wp_manifest', {}, bare)).isError).toBe(true);

    const d = await call('wp_disconnect');
    expect(d.data).toMatchObject({ disconnected: true, was_connected: true, caches_cleared: true });

    const after = await call('wp_manifest', {});
    expect(after.ok).toBe(true); // env still supplies the config
  });

  it('wp_disconnect works with no connection at all (fully local)', async () => {
    const bare = new Runtime({ cwd, env: {} });
    const res = await callTool('wp_disconnect', {}, bare);
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ disconnected: true, was_connected: false });
  });
});

describe('wp_manifest', () => {
  it('returns the full manifest and caches it', async () => {
    const first = await call('wp_manifest');
    expect(first.ok).toBe(true);
    expect(first.data.blocks['core/columns'].attributes.isStackedOnMobile.default).toBe(true);
    expect(first.data.served_from_cache).toBe(false);
    expect(mock.countHits('/manifest')).toBe(1);

    const second = await call('wp_manifest');
    expect(second.data.served_from_cache).toBe(true);
    expect(mock.countHits('/manifest')).toBe(1);
  });

  it('refresh:true forces a refetch', async () => {
    await call('wp_manifest');
    await call('wp_manifest', { refresh: true });
    expect(mock.countHits('/manifest')).toBe(2);
  });

  it('summary:true returns names + parents only', async () => {
    const r = await call('wp_manifest', { summary: true });
    expect(r.data.summary).toBe(true);
    const col = r.data.blocks['core/column'];
    expect(Object.keys(col).sort()).toEqual(['ancestor', 'is_dynamic', 'parent', 'title']);
    expect(col.parent).toEqual(['core/columns']);
    expect(JSON.stringify(r.data.blocks)).not.toContain('verticalAlignment');
  });

  it('filter.name_prefix and filter.dynamic_only narrow the blocks map', async () => {
    const core = await call('wp_manifest', { filter: { name_prefix: 'core/' } });
    expect(core.data.filtered).toBe(true);
    expect(Object.keys(core.data.blocks).every((n) => n.startsWith('core/'))).toBe(true);
    expect(core.data.blocks_returned).toBeLessThan(core.data.blocks_total);

    const dyn = await call('wp_manifest', { filter: { dynamic_only: true } });
    expect(Object.keys(dyn.data.blocks).sort()).toEqual(
      ['agent/testimonial', 'core/latest-posts', 'core/post-template', 'core/query', 'core/site-title'].sort(),
    );

    const both = await call('wp_manifest', { filter: { name_prefix: 'agent/', dynamic_only: true }, summary: true });
    expect(Object.keys(both.data.blocks)).toEqual(['agent/testimonial']);
  });
});

describe('wp_patterns', () => {
  it('fetches once per fingerprint and filters locally', async () => {
    const all = await call('wp_patterns');
    expect(all.data.total).toBe(3);
    expect(all.data.served_from_cache).toBe(false);
    expect(all.data.patterns[0].parsed_tree.length).toBeGreaterThan(0);
    expect(all.data.patterns[0].content).toBeUndefined();

    const filtered = await call('wp_patterns', { query: 'testimonial' });
    expect(filtered.data.total).toBe(1);
    expect(filtered.data.served_from_cache).toBe(true);
    expect(mock.countHits('/patterns')).toBe(1);

    const byCategory = await call('wp_patterns', { category: 'columns' });
    expect(byCategory.data.patterns.map((p: { name: string }) => p.name)).toEqual(['twentytwentyfive/three-features']);

    const withMarkup = await call('wp_patterns', { query: 'hero', include_markup: true });
    expect(withMarkup.data.patterns[0].content).toContain('<!-- wp:group');
  });

  it('refetches after the epoch moves', async () => {
    await call('wp_patterns');
    mock.setFingerprint(FP_B);
    await call('wp_manifest', { refresh: true });
    await call('wp_patterns');
    expect(mock.countHits('/patterns')).toBe(2);
  });
});

/* -------------------------------------------------------- M2: wp_validate */

describe('wp_validate local pre-check', () => {
  it('catches a schema error WITHOUT any network call — zero /validate hits', async () => {
    const r = await call('wp_validate', readTree('invalid-tree-schema.json'));
    expect(r.ok).toBe(true);
    expect(r.data.valid).toBe(false);
    expect(r.data.checked_locally_only).toBe(true);
    expect(r.data.diagnostics.map((d: { code: string }) => d.code)).toEqual(['E_TREE_SCHEMA']);
    expect(r.data.diagnostics[0].path).toBe('/blocks/0');
    expect(r.data.diagnostics[0].fix_hint).toContain('innerHTML');
    expect(mock.countHits('/validate')).toBe(0);
    expect(mock.log.length).toBe(0);
  });

  for (const [label, tree] of [
    ['missing version', { epoch: FP_A, blocks: [] }],
    ['blocks not an array', { version: 1, epoch: FP_A, blocks: {} }],
    ['bad block name', { version: 1, epoch: FP_A, blocks: [{ name: 'paragraph' }] }],
    ['nested innerHTML', { version: 1, epoch: FP_A, blocks: [{ name: 'a/b', innerBlocks: [{ name: 'c/d', innerHTML: '' }] }] }],
  ] as const) {
    it(`short-circuits on ${label} with zero network calls`, async () => {
      const r = await call('wp_validate', tree);
      expect(r.data.checked_locally_only).toBe(true);
      expect(r.data.diagnostics.every((d: { code: string }) => d.code === 'E_TREE_SCHEMA')).toBe(true);
      expect(mock.log.length).toBe(0);
    });
  }

  it('a schema-clean tree DOES go to the instance', async () => {
    const r = await call('wp_validate', readTree('valid-core-landing.json'));
    expect(r.ok).toBe(true);
    expect(r.data.checked_locally_only).toBe(false);
    expect(mock.countHits('/validate')).toBe(1);
  });
});

describe('wp_validate against the instance', () => {
  it('accepts the golden landing tree (warnings only)', async () => {
    const r = await call('wp_validate', readTree('valid-core-landing.json'));
    expect(r.data.valid).toBe(true);
    expect(r.data.epoch_ok).toBe(true);
    const codes = new Set(r.data.diagnostics.map((d: { code: string }) => d.code));
    expect(codes.has('W_STATIC_NEEDS_HARNESS')).toBe(true);
    expect([...codes].every((c) => String(c).startsWith('W_'))).toBe(true);
    const staticWarning = r.data.diagnostics.find((d: { code: string }) => d.code === 'W_STATIC_NEEDS_HARNESS');
    expect(staticWarning.fix_hint).toBe('canonical markup must come from harness compile, do not hand-serialize');
  });

  it('accepts a tree that uses an installed agent block', async () => {
    const r = await call('wp_validate', readTree('valid-with-agent-block.json'));
    expect(r.data.valid).toBe(true);
  });

  for (const [file, code] of [
    ['invalid-unknown-block.json', 'E_UNKNOWN_BLOCK'],
    ['invalid-attr-type.json', 'E_ATTR_TYPE'],
    ['invalid-attr-enum.json', 'E_ATTR_ENUM'],
    ['invalid-nest-parent.json', 'E_NEST_PARENT'],
    ['invalid-nest-ancestor.json', 'E_NEST_ANCESTOR'],
  ] as const) {
    it(`${file} produces ${code}`, async () => {
      const r = await call('wp_validate', readTree(file));
      expect(r.data.valid).toBe(false);
      expect(r.data.diagnostics.map((d: { code: string }) => d.code)).toContain(code);
    });
  }

  it('warn-attr-unknown.json is a warning, not an error', async () => {
    const r = await call('wp_validate', readTree('warn-attr-unknown.json'));
    expect(r.data.valid).toBe(true);
    expect(r.data.diagnostics.map((d: { code: string }) => d.code)).toContain('W_ATTR_UNKNOWN');
  });

  it('a stale epoch is transparently refreshed and retried once', async () => {
    await call('wp_connect');
    mock.setFingerprint(FP_B);
    mock.clearLog();
    const r = await call('wp_validate', readTree('invalid-epoch.json'));
    expect(r.ok).toBe(true);
    expect(r.data.epoch_ok).toBe(true);
    expect(mock.countHits('/validate')).toBe(2);
  });

  it('a permanent mismatch surfaces epoch_mismatch as a structured error', async () => {
    await call('wp_connect');
    mock.setEpochMode('always');
    const r = await call('wp_validate', readTree('valid-core-landing.json'));
    expect(r.ok).toBe(false);
    expect(r.data.code).toBe('epoch_mismatch');
    expect(mock.countHits('/validate')).toBe(2);
  });
});

/* ------------------------------------------------- M2: wp_parse / wp_render */

describe('wp_parse', () => {
  it('returns both the raw parse output and a TreeIR with no innerHTML', async () => {
    await call('wp_connect');
    const markup =
      '<!-- wp:core/group {"tagName":"section"} --><!-- wp:core/paragraph {"content":"x"} /--><!-- /wp:core/group -->';
    const r = await call('wp_parse', { markup });
    expect(r.ok).toBe(true);
    expect(r.data.tree.version).toBe(1);
    expect(r.data.tree.epoch).toBe(FP_A);
    expect(JSON.stringify(r.data.tree)).not.toContain('innerHTML');
    expect(r.data.blocks.some((b: { innerHTML?: string }) => b.innerHTML !== undefined)).toBe(true);
    expect(r.data.dropped_freeform).toBeGreaterThan(0);
  });

  it('include_raw:false omits the bulky verbatim output', async () => {
    await call('wp_connect');
    const r = await call('wp_parse', { markup: '<!-- wp:core/paragraph /-->', include_raw: false });
    expect(r.data.blocks).toBeUndefined();
  });

  it('the parsed tree round-trips back through wp_validate', async () => {
    await call('wp_connect');
    const parsed = await call('wp_parse', { markup: '<!-- wp:core/paragraph {"content":"x"} /-->' });
    const v = await call('wp_validate', parsed.data.tree);
    expect(v.data.valid).toBe(true);
  });
});

describe('wp_render', () => {
  it('returns html and the enqueued stylesheet URLs', async () => {
    const r = await call('wp_render', { markup: '<!-- wp:core/paragraph /-->' });
    expect(r.ok).toBe(true);
    expect(r.data.html).toContain('wp-block-core-paragraph');
    expect(r.data.enqueued_styles[0]).toContain('block-library');
  });
});

/* ---------------------------------------------- posture-gated extend tools */

describe('posture gating', () => {
  it('wp_tokens_apply is refused on a production instance with the sandbox hint', async () => {
    mock.setPosture('production');
    const tokens = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'design-tokens.sample.json'), 'utf8'));
    const r = await call('wp_tokens_apply', tokens);
    expect(r.ok).toBe(false);
    expect(r.data.code).toBe('posture_forbidden');
    expect(r.data.hint).toBe('clone to sandbox via wp_snapshot then apply there');
    expect(mock.countHits('/theme/tokens')).toBe(0);
  });

  it('wp_tokens_apply dry_run never writes, even on a toolchain instance', async () => {
    const tokens = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'design-tokens.sample.json'), 'utf8'));
    const r = await call('wp_tokens_apply', { ...tokens, dry_run: true });
    expect(r.ok).toBe(true);
    expect(r.data.applied).toBe(false);
    expect((r.data.theme_json_preview as { color: { palette: unknown[] } }).color.palette.length).toBe(7);
    expect(Array.isArray(r.data.diff_against_instance)).toBe(true);
    expect(mock.countHits('/theme/tokens')).toBe(0);
  });

  it('wp_tokens_apply writes on a toolchain instance and returns the new epoch', async () => {
    const tokens = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'design-tokens.sample.json'), 'utf8'));
    const r = await call('wp_tokens_apply', tokens);
    expect(r.ok).toBe(true);
    expect(r.data.applied).toBe(true);
    expect(r.data.adapters_applied).toEqual(['kadence-blocks']);
    expect(r.data.fingerprint).not.toBe(FP_A);
  });

  it('wp_snapshot is refused on production and streams a zip on toolchain', async () => {
    mock.setPosture('production');
    const refused = await call('wp_snapshot');
    expect(refused.data.code).toBe('posture_forbidden');
    expect(mock.countHits('/snapshot/export')).toBe(0);

    mock.setPosture('toolchain');
    const out = path.join(cwd, 'snap.zip');
    const ok = await call('wp_snapshot', { out_path: out });
    expect(ok.ok).toBe(true);
    expect(fs.existsSync(ok.data.zip_path)).toBe(true);
    expect(ok.data.fingerprint).toBe(FP_A);
  });
});
