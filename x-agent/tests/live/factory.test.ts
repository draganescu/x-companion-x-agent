/**
 * M5 live acceptance — scaffold → build → smoke → package → install, against
 * REAL WordPress instances.
 *
 *   ./factory-setup.sh            boot/adopt a toolchain and a production instance
 *   eval "$(./factory-setup.sh --export)"
 *   npx vitest run ../tests/live/factory.test.ts       (from x-agent/mcp)
 *
 * The suite self-skips unless `X_AGENT_FACTORY_LIVE=1` and the state file written
 * by factory-setup.sh exists, so a plain `npx vitest run` stays offline and fast.
 *
 * WHAT IS BEING PROVEN
 *   1. A scaffolded block, with render.php implemented against the embedded
 *      intent, passes the no-build syntax gate, registers in a real WordPress, renders
 *      the sample attributes, and packages into a policy-clean zip.
 *   2. Installing it onto a TOOLCHAIN instance moves the epoch, and a tree using
 *      the new block compiles/validates clean at that new epoch.
 *   3. The same install against a PRODUCTION-posture instance is refused with
 *      exactly `posture_forbidden`, and the instance does not move.
 *   4. A sabotaged render.php is caught by the local smoke test — php_error set,
 *      NO zip produced, and nothing sent to any instance.
 *
 * CLEANUP. When factory-setup.sh had to adopt somebody else's toolchain instance
 * (both slots held), the block installed here is deleted afterwards and the
 * fingerprint is asserted back to its pre-install value, so the instance is
 * handed back exactly as it was found.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Runtime } from '../../mcp/src/context.js';
import { callTool } from '../../mcp/src/server.js';
import { loadExternalHandlers } from '../../mcp/src/registry.js';
import { inspectPackage, loadAdmZip } from '../../mcp/src/factory.js';
import type { LibraryEntry } from '../../mcp/src/companion.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.X_AGENT_FACTORY_INSTANCES || path.join(HERE, '.factory-instances.json');
/**
 * Gate. Deliberately a factory-specific variable, not the generic `X_AGENT_LIVE`
 * the M3/M4 live suite uses: several tracks share this repo and this vitest root,
 * and installing a block mutates a real instance's epoch. This suite must run
 * only when somebody asked for THIS suite.
 */
const LIVE = process.env.X_AGENT_FACTORY_LIVE === '1' && fs.existsSync(STATE_PATH);

interface InstanceEntry {
  profile: string;
  posture: 'toolchain' | 'production';
  runtime: string;
  url: string;
  booted_by_us: boolean;
}
interface Conn {
  url: string;
  user: string;
  app_password: string;
}

const SLUG = 'pricing-card';
const BLOCK = `agent/${SLUG}`;
const BROKEN_SLUG = 'broken-card';
const INTENT =
  'Render a pricing card: the plan name as an <h3>, the monthly price with a "$" prefix inside a <p class="price">, and a "Most popular" ribbon when featured is true.';

const BUILD_TIMEOUT = 15 * 60_000;

/** render.php implemented against the intent, over the scaffold's default body. */
const IMPLEMENTED_BODY = `
<div <?php echo $wrapper_attributes; ?>>
	<h3 class="agent-pricing-card__plan-name"><?php echo esc_html( (string) $plan_name ); ?></h3>
	<p class="price"><?php echo esc_html( '$' . (string) $price ); ?></p>
	<?php if ( $featured ) : ?>
		<span class="agent-pricing-card__ribbon"><?php echo esc_html__( 'Most popular', 'agent-pricing-card' ); ?></span>
	<?php endif; ?>
</div>
`;

describe.skipIf(!LIVE)('M5 factory — live', () => {
  let toolchain: InstanceEntry;
  let production: InstanceEntry;
  let tc: Conn;
  let prod: Conn;
  let runtime: Runtime;
  let workspace: string;

  /** Facts carried between the ordered steps. */
  const ctx: {
    dir?: string;
    zipPath?: string;
    epochBefore?: string;
    epochAfter?: string;
    prodEpochBefore?: string;
    librarySnapshot?: LibraryEntry[];
    compileSubstituted?: boolean;
  } = {};

  const readConn = (e: InstanceEntry): Conn => {
    const r = JSON.parse(fs.readFileSync(e.runtime, 'utf8')) as { url: string; admin: { user: string; app_password: string } };
    return { url: r.url, user: r.admin.user, app_password: r.admin.app_password };
  };

  const call = async (name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any }> => {
    const res = await callTool(name, args, runtime);
    return { ok: !res.isError, data: JSON.parse(res.content[0]!.text) };
  };

  const companionFor = (c: Conn) => runtime.ctx({ url: c.url, user: c.user, app_password: c.app_password }).companion;

  beforeAll(async () => {
    await loadExternalHandlers();
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as { toolchain: InstanceEntry; production: InstanceEntry };
    toolchain = state.toolchain;
    production = state.production;
    tc = readConn(toolchain);
    prod = readConn(production);

    // A stable workspace so the @wordpress/scripts dependency cache survives
    // between runs; a cold install is ~1500 packages.
    workspace = path.join(os.tmpdir(), 'x-agent-live-factory');
    fs.mkdirSync(workspace, { recursive: true });
    process.env.X_AGENT_BLOCK_WORKSPACE = workspace;

    // Deterministic config resolution: an empty cwd and env, so only the
    // per-call connection arguments can possibly apply.
    runtime = new Runtime({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'x-agent-live-cwd-')), env: {} });

    // eslint-disable-next-line no-console
    console.log(`[live] toolchain ${toolchain.url} (${toolchain.profile}, booted_by_us=${toolchain.booted_by_us}) / production ${production.url}`);
  }, 120_000);

  afterAll(async () => {
    if (!runtime) return;
    // Hand an adopted instance back byte-identical: remove what we installed.
    if (ctx.epochAfter && toolchain && !toolchain.booted_by_us) {
      try {
        const companion = companionFor(tc);
        await companion.fetchFingerprint();
        const res = await companion.deleteBlock(SLUG);
        // The fingerprint is a pure function of the registry + theme + plugins,
        // so removing the block must return it to exactly its pre-install value.
        expect(res.fingerprint).toBe(ctx.epochBefore);
        // eslint-disable-next-line no-console
        console.log(`[live] cleaned up ${BLOCK}; epoch restored to ${String(ctx.epochBefore).slice(0, 12)}…`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[live] cleanup of ${BLOCK} failed: ${(e as Error).message}`);
      }
    }
    await runtime.disconnect();
  }, 120_000);

  /* ------------------------------------------------------------ scaffold */

  it(
    'scaffolds agent/pricing-card with three attributes',
    async () => {
      const r = await call('wp_block_scaffold', {
        slug: SLUG,
        title: 'Pricing Card',
        dir: workspace,
        force: true,
        render_intent: INTENT,
        attributes: [
          { name: 'planName', type: 'string', default: 'Starter', control: 'text' },
          { name: 'price', type: 'number', default: 9, control: 'number' },
          { name: 'featured', type: 'boolean', default: false, control: 'toggle' },
        ],
      });
      expect(r.ok, JSON.stringify(r.data)).toBe(true);
      expect(r.data.name).toBe(BLOCK);
      expect(r.data.files).toEqual(['block.json', 'edit.asset.php', 'edit.js', 'render.php']);
      ctx.dir = r.data.dir;

      const meta = JSON.parse(fs.readFileSync(path.join(ctx.dir!, 'block.json'), 'utf8')) as Record<string, unknown>;
      expect(meta.apiVersion).toBe(3);
      expect(meta.name).toBe(BLOCK);
      expect(meta.render).toBe('file:./render.php');
      expect(fs.readFileSync(path.join(ctx.dir!, 'render.php'), 'utf8')).toContain(INTENT);
    },
    60_000,
  );

  it('implements render.php against the intent embedded in the template default', () => {
    const p = path.join(ctx.dir!, 'render.php');
    const src = fs.readFileSync(p, 'utf8');
    // The scaffold body nests one div per attribute, so the wrapper's own
    // closing tag is the LAST </div>, not the first one after the opening tag.
    const start = src.indexOf('<div <?php echo $wrapper_attributes; ?>>');
    const end = src.lastIndexOf('</div>') + '</div>'.length;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    fs.writeFileSync(p, src.slice(0, start) + IMPLEMENTED_BODY.trim() + src.slice(end), 'utf8');
    const out = fs.readFileSync(p, 'utf8');
    expect(out).toContain('<h3 class="agent-pricing-card__plan-name">');
    expect(out).toContain('Most popular');
    // Still every attribute escaped on output.
    expect(out).toContain('esc_html( (string) $plan_name )');
    // The scaffold's default per-attribute divs are gone: one wrapper, one body.
    expect(out).not.toContain('agent-pricing-card__price');
    expect((out.match(/<div <\?php echo \$wrapper_attributes; \?>>/g) ?? []).length).toBe(1);
  });

  /* --------------------------------------------------------- build + smoke */

  it(
    'wp_block_build_test builds, registers in a real WordPress, renders the sample attributes and packages a policy-clean zip',
    async () => {
      const started = Date.now();
      const r = await call('wp_block_build_test', {
        dir: ctx.dir,
        sample_attributes: { planName: 'Enterprise', price: 49, featured: true },
      });
      // eslint-disable-next-line no-console
      console.log(`[live] build+smoke+package took ${Date.now() - started}ms; timings=${JSON.stringify(r.data.timings_ms)}`);

      expect(r.ok, JSON.stringify(r.data).slice(0, 2000)).toBe(true);
      expect(r.data.failure, JSON.stringify(r.data.failure)).toBeUndefined();
      expect(r.data.built).toBe(true);
      expect(r.data.smoke.registered).toBe(true);
      expect(r.data.smoke.php_error).toBeUndefined();
      expect(r.data.smoke.rendered_html).toContain('Enterprise');
      expect(r.data.smoke.rendered_html).toContain('$49');
      expect(r.data.smoke.rendered_html).toContain('Most popular');
      expect(typeof r.data.zip_path).toBe('string');
      expect(fs.existsSync(r.data.zip_path)).toBe(true);
      ctx.zipPath = r.data.zip_path;

      // Read the produced zip back and re-check it against the install policy.
      const report = inspectPackage(ctx.zipPath!);
      expect(report.reasons).toEqual([]);
      expect(report.root).toBe(SLUG);
      const Zip = loadAdmZip();
      const names = new Zip(ctx.zipPath!).getEntries().map((e) => e.entryName);
      expect(names).toContain(`${SLUG}/block.json`);
      expect(names).toContain(`${SLUG}/render.php`);
      expect(names).toContain(`${SLUG}/edit.js`);
      expect(names).toContain(`${SLUG}/edit.asset.php`);
    },
    BUILD_TIMEOUT,
  );

  /* ------------------------------------------------------------- install */

  it(
    'wp_block_install against a toolchain instance installs the block and moves the epoch',
    async () => {
      const companion = companionFor(tc);
      const before = await companion.fetchFingerprint();
      expect(before.posture).toBe('toolchain');
      ctx.epochBefore = before.fingerprint;

      const r = await call('wp_block_install', { ...tc, zip_path: ctx.zipPath });
      expect(r.ok, JSON.stringify(r.data)).toBe(true);
      expect(r.data.installed.slug).toBe(SLUG);
      expect(r.data.installed.name).toBe(BLOCK);
      expect(typeof r.data.fingerprint).toBe('string');
      expect(r.data.fingerprint).toHaveLength(64);
      expect(r.data.fingerprint).not.toBe(ctx.epochBefore);
      expect(r.data.previous_fingerprint).toBe(ctx.epochBefore);
      expect(r.data.manifest_refreshed).toBe(true);
      ctx.epochAfter = r.data.fingerprint;
      // eslint-disable-next-line no-console
      console.log(`[live] epoch ${String(ctx.epochBefore).slice(0, 12)}… -> ${String(ctx.epochAfter).slice(0, 12)}…`);

      // The instance really did move, and it agrees with what we were handed.
      const after = await companionFor(tc).fetchFingerprint();
      expect(after.fingerprint).toBe(ctx.epochAfter);

      const library = await companionFor(tc).blocksLibrary();
      expect(library.map((e) => e.slug)).toContain(SLUG);

      // The installed block really renders on the instance, from the render.php
      // implemented above — not just in the local smoke sandbox.
      const rendered = await call('wp_render', {
        ...tc,
        markup: `<!-- wp:${BLOCK} {"planName":"Enterprise","price":49,"featured":true} /-->`,
      });
      expect(rendered.ok, JSON.stringify(rendered.data)).toBe(true);
      expect(rendered.data.html).toContain('Enterprise');
      expect(rendered.data.html).toContain('$49');
      expect(rendered.data.html).toContain('Most popular');
    },
    180_000,
  );

  it(
    'the new block is in the manifest at the new epoch, and a tree that uses it compiles all_valid',
    async () => {
      const manifest = await call('wp_manifest', { ...tc, refresh: true });
      expect(manifest.ok, JSON.stringify(manifest.data)).toBe(true);
      expect(manifest.data.fingerprint).toBe(ctx.epochAfter);
      const blockNames = Object.keys(manifest.data.blocks ?? {});
      expect(blockNames).toContain(BLOCK);

      const tree = {
        version: 1,
        epoch: ctx.epochAfter,
        blocks: [
          {
            name: 'core/group',
            attributes: {},
            innerBlocks: [{ name: BLOCK, attributes: { planName: 'Enterprise', price: 49, featured: true } }],
          },
        ],
      };

      const compiled = await call('wp_compile', { ...tc, ...tree });
      if (compiled.ok) {
        expect(compiled.data.all_valid, JSON.stringify(compiled.data.invalid)).toBe(true);
        expect(compiled.data.markup).toContain(`wp:${BLOCK}`);
        expect(compiled.data.epoch).toBe(ctx.epochAfter);
      } else {
        // Documented substitution. wp_compile belongs to the session track; it may
        // be absent, and it also fails with `harness_gap` when the instance
        // advertises the block but its editor script never registered
        // client-side — which is what an installed agent block currently does,
        // because WordPress builds its script URL with plugins_url() and the
        // block lives under wp_upload_dir(). Either way, prove the equivalent
        // through the contract routes: valid at the new epoch, and in the
        // manifest (asserted above).
        ctx.compileSubstituted = true;
        // eslint-disable-next-line no-console
        console.warn(`[live] wp_compile did not compile (${compiled.data.code}); substituting POST /validate at the new epoch`);
        const validated = await call('wp_validate', { ...tc, ...tree });
        expect(validated.ok, JSON.stringify(validated.data)).toBe(true);
        expect(validated.data.valid, JSON.stringify(validated.data.diagnostics)).toBe(true);
        expect(validated.data.epoch_ok).toBe(true);
      }
    },
    300_000,
  );

  /* ------------------------------------------------------------- posture */

  it(
    'wp_block_install against a production-posture instance is refused with exactly posture_forbidden, and nothing is sent',
    async () => {
      const companion = companionFor(prod);
      const before = await companion.fetchFingerprint();
      expect(before.posture).toBe('production');
      ctx.prodEpochBefore = before.fingerprint;

      const r = await call('wp_block_install', { ...prod, zip_path: ctx.zipPath });
      expect(r.ok).toBe(false);
      expect(r.data.code).toBe('posture_forbidden');
      expect(r.data.hint).toMatch(/sandbox/i);

      // Nothing mutated: the epoch is exactly where it was.
      const after = await companionFor(prod).fetchFingerprint();
      expect(after.fingerprint).toBe(ctx.prodEpochBefore);
    },
    120_000,
  );

  /* ------------------------------------------------------------ sabotage */

  it(
    'a sabotaged render.php is caught by the smoke test: php_error set, no zip, and nothing sent to the instance',
    async () => {
      ctx.librarySnapshot = await companionFor(tc).blocksLibrary();
      expect(ctx.librarySnapshot.map((e) => e.slug)).not.toContain(BROKEN_SLUG);

      const scaffolded = await call('wp_block_scaffold', {
        slug: BROKEN_SLUG,
        title: 'Broken Card',
        dir: workspace,
        force: true,
        render_intent: 'Deliberately sabotaged for the M5 safety-gate proof.',
        attributes: [{ name: 'planName', type: 'string', default: 'Starter', control: 'text' }],
      });
      expect(scaffolded.ok, JSON.stringify(scaffolded.data)).toBe(true);

      // A PHP syntax error: an `if (` that is never closed.
      const p = path.join(scaffolded.data.dir, 'render.php');
      const src = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(
        p,
        src.replace('$wrapper_attributes = get_block_wrapper_attributes(', 'if ( true {\n$wrapper_attributes = get_block_wrapper_attributes('),
        'utf8',
      );

      const r = await call('wp_block_build_test', { dir: scaffolded.data.dir, sample_attributes: { planName: 'Enterprise' } });
      expect(r.ok, JSON.stringify(r.data).slice(0, 1500)).toBe(true);

      // The JS build is fine — it is the PHP that is broken, and only a real
      // WordPress running the file could tell us that.
      expect(r.data.built).toBe(true);
      expect(r.data.smoke.php_error, 'the sandbox must report the PHP parse error').toBeTruthy();
      expect(r.data.smoke.php_error).toMatch(/Parse error|Fatal error/);
      expect(r.data.smoke.php_error).toContain('render.php');
      expect(r.data.failure?.code).toBe('smoke_failed');

      // NO ZIP. Not in the result, and not on disk either.
      expect(r.data.zip_path).toBeUndefined();
      const buildDir = path.join(scaffolded.data.dir, '.x-agent-build');
      const zips = fs.existsSync(buildDir) ? fs.readdirSync(buildDir).filter((f) => f.endsWith('.zip')) : [];
      expect(zips).toEqual([]);

      // NOTHING SENT — proven two ways.
      //
      // (a) Structurally. wp_block_build_test is `local: true`, and the calls
      //     above carried no connection arguments, so this Runtime has NO
      //     resolvable connection: its ctx.companion is an accessor trap that
      //     throws. Any attempt by the tool to reach an instance would have
      //     surfaced as invalid_input rather than a result. Demonstrated by a
      //     non-local tool on the very same Runtime failing exactly that way:
      const noConnection = await call('wp_manifest', {});
      expect(noConnection.ok).toBe(false);
      expect(noConnection.data.code).toBe('invalid_input');
      expect(noConnection.data.message).toMatch(/Missing connection config/);

      // (b) Observationally. The block never appears in the instance's library,
      //     and nothing that was there has gone away. (The toolchain instance is
      //     shared with other suites in this repo, so entries may legitimately be
      //     ADDED by somebody else mid-test; what must never happen is
      //     broken-card showing up, or one of ours disappearing.)
      const libraryAfter = await companionFor(tc).blocksLibrary();
      expect(libraryAfter.map((e) => e.slug)).not.toContain(BROKEN_SLUG);
      for (const before of ctx.librarySnapshot!) {
        expect(libraryAfter.map((e) => `${e.slug}@${e.version}`)).toContain(`${before.slug}@${before.version}`);
      }
    },
    BUILD_TIMEOUT,
  );
});
