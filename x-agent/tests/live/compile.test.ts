/**
 * M3_compiler_session — live acceptance for session.ts + wp_compile.
 *
 * These tests need a REAL WordPress with x-companion mounted. Boot one first:
 *
 *     x-agent/tests/live/setup.sh
 *     cd x-agent/mcp
 *     X_AGENT_LIVE=1 npx vitest run ../tests/live --no-file-parallelism
 *
 * They are OPT-IN (`X_AGENT_LIVE=1`) so that a plain `npx vitest run` stays a
 * hermetic unit suite, and SEQUENTIAL (`--no-file-parallelism`) because both live
 * files drive the same instance and this one deliberately moves its fingerprint.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime, type Ctx } from '../../mcp/src/context.js';
import { callTool } from '../../mcp/src/server.js';
import { loadExternalHandlers } from '../../mcp/src/registry.js';
import { sessionFor, type HarnessSession } from '../../mcp/src/session.js';
import { liveRuntime, runtimeDescriptorPath, normaliseMarkup, readTree } from '../capture-golden.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', '..', 'fixtures');
const LIVE = process.env.X_AGENT_LIVE === '1';

/**
 * WordPress core's own plugins route. `companion.ts` is the only place that may
 * speak to `x-companion/v1`; this is `wp/v2`, which the companion deliberately
 * does not wrap (there are no author/admin routes in v1), so the test does it
 * directly. Nothing in `mcp/src/` gains a second HTTP surface from this.
 */
async function setPluginStatus(rt: LiveDescriptor, plugin: string, status: 'active' | 'inactive'): Promise<void> {
  const auth = 'Basic ' + Buffer.from(`${rt.admin.user}:${rt.admin.app_password}`).toString('base64');
  const res = await fetch(`${rt.url}/?rest_route=/wp/v2/plugins/${plugin}`, {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`could not set ${plugin} ${status}: HTTP ${res.status} ${await res.text()}`);
}

interface LiveDescriptor {
  url: string;
  admin: { user: string; app_password: string };
}

let runtime: Runtime;
let rt: LiveDescriptor;
let ctx: Ctx;
const TOGGLE_PLUGIN = 'akismet/akismet';

async function call(name: string, args: unknown = {}): Promise<{ ok: boolean; data: any }> {
  const res = await callTool(name, args, runtime);
  return { ok: !res.isError, data: JSON.parse(res.content[0]!.text) };
}

beforeAll(async () => {
  if (!LIVE) return;
  await loadExternalHandlers({ force: true });
  rt = JSON.parse(fs.readFileSync(runtimeDescriptorPath(), 'utf8'));
  runtime = liveRuntime();
  ctx = runtime.ctx({});
  await setPluginStatus(rt, TOGGLE_PLUGIN, 'inactive').catch(() => {});
}, 180_000);

afterAll(async () => {
  if (!LIVE) return;
  await setPluginStatus(rt, TOGGLE_PLUGIN, 'inactive').catch(() => {});
  await runtime?.disconnect();
}, 120_000);

describe.skipIf(!LIVE)('M3 live — wp_compile against a real instance', () => {
  it('compiles the golden landing tree to markup byte-equal to the captured golden', async () => {
    const r = await call('wp_compile', readTree('valid-core-landing.json'));
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    expect(r.data.all_valid).toBe(true);
    expect(r.data.invalid).toEqual([]);

    const golden = fs.readFileSync(path.join(FIXTURES, 'golden', 'valid-core-landing.html'), 'utf8');
    expect(normaliseMarkup(r.data.markup)).toBe(normaliseMarkup(golden));
    expect(r.data.epoch).toMatch(/^[0-9a-f]{64}$/);
  }, 180_000);

  it('the second compile is warm: no page load, sub-100ms in the browser', async () => {
    // Start genuinely cold so the number in the log is the real one.
    await call('wp_disconnect');
    runtime = liveRuntime();
    const cold = await call('wp_compile', readTree('golden-landing.json'));
    expect(cold.ok, JSON.stringify(cold.data)).toBe(true);
    expect(cold.data.timing.cold).toBe(true);
    expect(cold.data.timing.page_ms).toBeGreaterThan(200);
    const warm = await call('wp_compile', readTree('golden-landing.json'));
    expect(warm.ok).toBe(true);
    expect(warm.data.timing.cold).toBe(false);
    expect(warm.data.timing.page_ms).toBe(0);
    expect(warm.data.timing.total_ms).toBeLessThan(100);
    // eslint-disable-next-line no-console
    console.log(
      `[warm-session] COLD total ${cold.data.timing.total_ms}ms (browser launch + GET /harness + __ready = ${cold.data.timing.page_ms}ms, ` +
        `__compile ${cold.data.timing.compile_ms}ms) -> WARM total ${warm.data.timing.total_ms}ms (page ${warm.data.timing.page_ms}ms, ` +
        `__compile ${warm.data.timing.compile_ms}ms) = ${(cold.data.timing.total_ms / Math.max(1, warm.data.timing.total_ms)).toFixed(0)}x`,
    );
  }, 180_000);

  it('reports registry_gaps: manifest blocks that never registered client-side', async () => {
    const r = await call('wp_compile', readTree('golden-landing.json'));
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data.registry_gaps)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[registry] gaps at this epoch: ${r.data.registry_gaps.join(', ') || '(none)'}`);
  }, 180_000);

  it('an epoch bump (plugin toggled) auto-reloads the session and the next compile succeeds at the new epoch', async () => {
    const before = await call('wp_compile', readTree('valid-core-landing.json'));
    expect(before.ok).toBe(true);
    const reloadsBefore = before.data.harness.reloaded;
    const epochBefore = before.data.epoch;

    await setPluginStatus(rt, TOGGLE_PLUGIN, 'active');

    const after = await call('wp_compile', readTree('valid-core-landing.json'));
    expect(after.ok, JSON.stringify(after.data)).toBe(true);
    expect(after.data.all_valid).toBe(true);
    expect(after.data.epoch).not.toBe(epochBefore);
    expect(after.data.harness.reloaded).toBe(reloadsBefore + 1);

    // and the markup is unchanged, because the epoch moved but the vocabulary did not
    const golden = fs.readFileSync(path.join(FIXTURES, 'golden', 'valid-core-landing.html'), 'utf8');
    expect(normaliseMarkup(after.data.markup)).toBe(normaliseMarkup(golden));

    await setPluginStatus(rt, TOGGLE_PLUGIN, 'inactive');
    const back = await call('wp_compile', readTree('valid-core-landing.json'));
    expect(back.ok).toBe(true);
    expect(back.data.epoch).toBe(epochBefore);
    expect(back.data.harness.reloaded).toBe(reloadsBefore + 2);
    // eslint-disable-next-line no-console
    console.log(
      `[epoch] ${epochBefore.slice(0, 12)} -> ${after.data.epoch.slice(0, 12)} -> ${back.data.epoch.slice(0, 12)}, ` +
        `${back.data.harness.reloaded - reloadsBefore} automatic harness reloads`,
    );
  }, 300_000);

  it('a client-side registry gap surfaces harness_gap with the fallback hint, and never compiles', async () => {
    // Warm the session, then manufacture a real gap the only honest way there is.
    const warm = await call('wp_compile', readTree('valid-core-landing.json'));
    expect(warm.ok).toBe(true);

    const session = (await sessionFor(runtime.ctx({}))) as HarnessSession;
    const page = session.harnessPageHandle;
    expect(page, 'the harness page should be loaded by now').toBeTruthy();

    const removed = await page!.evaluate(() => {
      const w = window as unknown as { wp: { blocks: { unregisterBlockType: (n: string) => unknown } } };
      w.wp.blocks.unregisterBlockType('core/separator');
      return true;
    });
    expect(removed).toBe(true);
    session.invalidateRegistry();

    const r = await call('wp_compile', readTree('valid-core-landing.json'));
    expect(r.ok).toBe(false);
    expect(r.data.code).toBe('harness_gap');
    expect(r.data.blocks).toContain('core/separator');
    expect(r.data.registry_gaps).toContain('core/separator');
    expect(r.data.hint).toContain('X_AGENT_HARNESS_FALLBACK=1');
    expect(r.data.message).toContain('core/separator');

    // Reload puts the real registry back so later tests are not poisoned.
    await session.reload();
    const healed = await call('wp_compile', readTree('valid-core-landing.json'));
    expect(healed.ok, JSON.stringify(healed.data)).toBe(true);
    expect(healed.data.registry_gaps).not.toContain('core/separator');
  }, 300_000);

  it('a tree the instance has never heard of is invalid_input, not harness_gap', async () => {
    const r = await call('wp_compile', {
      version: 1,
      epoch: 'a'.repeat(64),
      blocks: [{ name: 'nosuch/block', attributes: {} }],
    });
    expect(r.ok).toBe(false);
    expect(r.data.code).toBe('invalid_input');
    expect(r.data.message).toContain('nosuch/block');
  }, 120_000);

  it('wp_disconnect actually closes the browser', async () => {
    await call('wp_compile', readTree('valid-core-landing.json'));
    const session = (await sessionFor(runtime.ctx({}))) as HarnessSession;
    expect(session.describe().browser_open).toBe(true);
    const r = await call('wp_disconnect');
    expect(r.ok).toBe(true);
    expect(r.data.session_closed).toBe(true);
    expect(session.describe().browser_open).toBe(false);
    // and a fresh compile re-warms from scratch
    runtime = liveRuntime();
    const again = await call('wp_compile', readTree('valid-core-landing.json'));
    expect(again.ok, JSON.stringify(again.data)).toBe(true);
    expect(again.data.timing.cold).toBe(true);
  }, 300_000);
});
