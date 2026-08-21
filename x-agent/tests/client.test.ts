/**
 * companion.ts against the mock companion: URL-form probing, auth, the
 * WP_Error envelope mapping, the manifest cache's 10s fingerprint rate limit,
 * posture gating, and — the load-bearing one — the epoch retry rule from
 * CONTRACT.md §8: refresh ONCE, retry ONCE, then surface. Never loop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockCompanion, type MockCompanion } from './mock-companion/index.js';
import { CompanionClient, ManifestCache, type EpochEvent } from '../mcp/src/companion.js';
import { resolveConfig } from '../mcp/src/config.js';
import { toEnvelope, clearSecrets } from '../mcp/src/errors.js';

const USER = 'agent';
const PW = 'aaaa bbbb cccc dddd eeee ffff';
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

let mock: MockCompanion;
let emptyCwd: string;

beforeEach(async () => {
  mock = await startMockCompanion({ fingerprint: FP_A, user: USER, password: PW });
  emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'x-agent-client-'));
  clearSecrets();
});

afterEach(async () => {
  await mock.close();
  fs.rmSync(emptyCwd, { recursive: true, force: true });
  clearSecrets();
});

function makeClient(overrides: { user?: string; password?: string } = {}, events?: EpochEvent[]): CompanionClient {
  const config = resolveConfig(
    { url: mock.url, user: overrides.user ?? USER, app_password: overrides.password ?? PW },
    { cwd: emptyCwd, env: {} },
  );
  const opts: ConstructorParameters<typeof CompanionClient>[0] = { config };
  if (events) opts.onEpochEvent = (e) => events.push(e);
  return new CompanionClient(opts);
}

describe('transport, auth and URL-form probing', () => {
  it('talks to a pretty-permalink instance and caches the form', async () => {
    const c = makeClient();
    const fp = await c.fetchFingerprint();
    expect(fp.fingerprint).toBe(FP_A);
    expect(c.resolvedUrlForm).toBe('pretty');
    expect(mock.log.every((e) => e.form === 'pretty')).toBe(true);
  });

  it('falls back to ?rest_route= on a 404 and then sticks to it', async () => {
    mock.setUrlForm('plain');
    const c = makeClient();
    await c.fetchFingerprint();
    expect(c.resolvedUrlForm).toBe('plain');
    // first request probed pretty (404) then plain (200)
    expect(mock.log.map((e) => `${e.form}:${e.status}`)).toEqual(['pretty:404', 'plain:200']);

    mock.clearLog();
    await c.fetchManifest();
    expect(mock.log.map((e) => e.form)).toEqual(['plain']);
  });

  it('sends Basic auth on every request including /harness', async () => {
    const c = makeClient();
    await c.fetchFingerprint();
    await c.harnessHtml();
    expect(mock.log.length).toBe(2);
    expect(mock.log.every((e) => e.authorized)).toBe(true);
    expect(mock.log.map((e) => e.route)).toContain('/harness');
  });

  it('maps a 401 to companion_error with the wp code, and never echoes the password', async () => {
    const c = makeClient({ password: 'wrong wrong wrong wrong wrong wrong' });
    const env = toEnvelope(await catchIt(() => c.fetchFingerprint()));
    expect(env.code).toBe('companion_error');
    expect(env.status).toBe(401);
    expect(env.wp_code).toBe('rest_forbidden');
    expect(JSON.stringify(env)).not.toContain('wrong wrong');
  });

  it('maps an unreachable host to companion_unreachable', async () => {
    const config = resolveConfig({ url: 'http://127.0.0.1:1', user: USER, app_password: PW }, { cwd: emptyCwd, env: {} });
    const c = new CompanionClient({ config });
    expect(toEnvelope(await catchIt(() => c.fetchFingerprint())).code).toBe('companion_unreachable');
  });

  it('harnessUrl() is the authenticated harness route and credentials are available for Playwright', async () => {
    const c = makeClient();
    expect(c.harnessUrl()).toBe(`${mock.url}/wp-json/x-companion/v1/harness`);
    expect(c.harnessUrlAlternate()).toContain('rest_route=%2Fx-companion%2Fv1%2Fharness');
    expect(c.basicCredentials()).toEqual({ username: USER, password: PW });
    expect(c.authHeader().startsWith('Basic ')).toBe(true);
  });

  it('sends the expected fingerprint header once the epoch is known', async () => {
    const c = makeClient();
    await c.fetchFingerprint();
    mock.clearLog();
    await c.patterns();
    expect(mock.log[0]?.expectedFingerprintHeader).toBe(FP_A);
  });
});

describe('routes', () => {
  it('manifest parses against manifest.schema.json and exposes realistic nesting', async () => {
    const c = makeClient();
    const m = await c.fetchManifest();
    expect(m.blocks['core/column']?.parent).toEqual(['core/columns']);
    expect(m.blocks['core/list-item']?.parent).toEqual(['core/list']);
    expect(m.blocks['core/button']?.parent).toEqual(['core/buttons']);
    expect(m.blocks['core/post-template']?.ancestor).toEqual(['core/query']);
    expect(m.counts.blocks).toBe(Object.keys(m.blocks).length);
    expect(c.posture).toBe('toolchain');
  });

  it('patterns, parse and render round trip', async () => {
    const c = makeClient();
    await c.fetchFingerprint();
    expect((await c.patterns()).length).toBeGreaterThan(0);
    const parsed = await c.parse('<!-- wp:core/paragraph {"content":"x"} /-->');
    expect(parsed.blocks[0]?.blockName).toBe('core/paragraph');
    const rendered = await c.render('<!-- wp:core/paragraph /-->');
    expect(rendered.html).toContain('wp-block-core-paragraph');
    expect(rendered.enqueued_styles.length).toBe(1);
  });

  it('refuses extend-tier routes locally once the posture is known to be production', async () => {
    mock.setPosture('production');
    const c = makeClient();
    await c.fetchFingerprint();
    const env = toEnvelope(await catchIt(() => c.blocksLibrary()));
    expect(env.code).toBe('posture_forbidden');
    expect(env.hint).toBe('clone to sandbox via wp_snapshot then apply there');
  });

  it('maps a server-side posture_forbidden to the same structured error', async () => {
    const c = makeClient();
    mock.setPosture('production'); // client has not learned the posture yet
    const env = toEnvelope(await catchIt(() => c.blocksLibrary()));
    expect(env.code).toBe('posture_forbidden');
  });

  it('installs a block via the raw multipart POST and adopts the new fingerprint', async () => {
    const c = makeClient();
    await c.fetchFingerprint();
    const before = mock.getFingerprint();
    const res = await c.installBlockBytes('pricing-card.zip', new Uint8Array([80, 75, 3, 4]));
    expect(res.installed.name).toBe('agent/pricing-card');
    expect(res.fingerprint).not.toBe(before);
    expect(c.expectedFingerprint).toBe(res.fingerprint);
    const entry = mock.log.find((e) => e.route === '/blocks/install');
    expect((entry?.body as { __multipart_bytes: number }).__multipart_bytes).toBeGreaterThan(4);
  });

  it('streams a snapshot export to disk', async () => {
    const c = makeClient();
    await c.fetchFingerprint();
    const dest = path.join(emptyCwd, 'snap.zip');
    const res = await c.snapshotExport(dest);
    expect(res.zip_path).toBe(dest);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest).subarray(0, 2).toString('utf8')).toBe('PK');
  });
});

describe('epoch discipline (CONTRACT.md §8)', () => {
  it('a mid-run epoch bump triggers exactly ONE refresh and ONE retry, then succeeds', async () => {
    const events: EpochEvent[] = [];
    const c = makeClient({}, events);
    await c.fetchManifest(); // client now expects FP_A

    // The instance moves underneath us.
    mock.setFingerprint(FP_B);
    mock.clearLog();

    const tree = { version: 1 as const, epoch: FP_A, blocks: [{ name: 'core/paragraph', attributes: { content: 'hi' } }] };
    const diag = await c.validate(tree);

    expect(diag.valid).toBe(true);
    expect(diag.epoch_ok).toBe(true);
    expect(c.stats.epochRefreshes).toBe(1);
    expect(c.stats.epochRetries).toBe(1);
    expect(c.stats.epochSurfaced).toBe(0);
    expect(events.map((e) => e.kind)).toEqual(['detected', 'refreshed', 'retried']);

    // exactly two /validate hits, and the second carried the new epoch
    const validates = mock.log.filter((e) => e.route === '/validate');
    expect(validates.length).toBe(2);
    expect((validates[0]!.body as { epoch: string }).epoch).toBe(FP_A);
    expect((validates[1]!.body as { epoch: string }).epoch).toBe(FP_B);
    // the refresh itself was one /fingerprint + one /manifest
    expect(mock.countHits('/fingerprint')).toBe(1);
    expect(mock.countHits('/manifest')).toBe(1);
  });

  it('a permanent mismatch surfaces epoch_mismatch after exactly one retry — it never loops', async () => {
    const events: EpochEvent[] = [];
    const c = makeClient({}, events);
    await c.fetchManifest();
    mock.setEpochMode('always');
    mock.clearLog();

    const env = toEnvelope(
      await catchIt(() => c.validate({ version: 1, epoch: FP_A, blocks: [{ name: 'core/paragraph' }] })),
    );
    expect(env.code).toBe('epoch_mismatch');
    expect(c.stats.epochRefreshes).toBe(1);
    expect(c.stats.epochRetries).toBe(1);
    expect(c.stats.epochSurfaced).toBe(1);
    expect(mock.countHits('/validate')).toBe(2);
    expect(events.map((e) => e.kind)).toEqual(['detected', 'refreshed', 'retried', 'surfaced']);
  });

  it('an HTTP 409 epoch conflict follows the same one-refresh one-retry rule', async () => {
    const c = makeClient();
    await c.fetchManifest();
    mock.setEpochMode('http409');
    mock.setFingerprint(FP_B);
    mock.clearLog();

    const diag = await c.validate({ version: 1, epoch: FP_A, blocks: [] });
    expect(diag.valid).toBe(true);
    expect(c.stats.epochRefreshes).toBe(1);
    expect(c.stats.epochRetries).toBe(1);
    expect(mock.countHits('/validate')).toBe(2);
    expect(mock.log.filter((e) => e.status === 409).length).toBe(1);
  });

  it('does not refresh at all when the epoch is fresh', async () => {
    const c = makeClient();
    await c.fetchManifest();
    mock.clearLog();
    await c.validate({ version: 1, epoch: FP_A, blocks: [] });
    expect(c.stats.epochRefreshes).toBe(0);
    expect(mock.countHits('/validate')).toBe(1);
    expect(mock.countHits('/fingerprint')).toBe(0);
  });
});

describe('ManifestCache', () => {
  it('serves the cache and probes /fingerprint at most once per 10s', async () => {
    const c = makeClient();
    const cache = new ManifestCache(c);
    const t0 = 1_000_000;

    await cache.get({ now: t0 }); // cold: one /manifest
    expect(mock.countHits('/manifest')).toBe(1);

    await cache.get({ now: t0 + 1_000 });
    await cache.get({ now: t0 + 5_000 });
    await cache.get({ now: t0 + 9_999 });
    expect(mock.countHits('/fingerprint')).toBe(0);
    expect(mock.countHits('/manifest')).toBe(1);
    expect(cache.stats.cacheHits).toBe(3);

    await cache.get({ now: t0 + 10_000 });
    expect(mock.countHits('/fingerprint')).toBe(1);
    expect(mock.countHits('/manifest')).toBe(1); // fingerprint unchanged -> no rebuild
  });

  it('rebuilds when the probe shows the fingerprint moved', async () => {
    const c = makeClient();
    const cache = new ManifestCache(c);
    const t0 = 2_000_000;
    await cache.get({ now: t0 });
    mock.setFingerprint(FP_B);

    const m = await cache.get({ now: t0 + 20_000 });
    expect(m.fingerprint).toBe(FP_B);
    expect(mock.countHits('/manifest')).toBe(2);
  });

  it('refresh:true always refetches and does not consume a probe', async () => {
    const c = makeClient();
    const cache = new ManifestCache(c);
    await cache.get({ now: 0 });
    await cache.get({ refresh: true, now: 1 });
    expect(mock.countHits('/manifest')).toBe(2);
    expect(mock.countHits('/fingerprint')).toBe(0);
  });
});

async function catchIt(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return new Error('did not throw');
  } catch (e) {
    return e;
  }
}
