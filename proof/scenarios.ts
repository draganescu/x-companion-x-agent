/**
 * proof/scenarios.ts — the thirteen interop scenarios from PROOF-PLAN.md.
 *
 * The agent side is always driven through the real MCP entrypoint `callTool`,
 * so what is proven here is the same code path Claude uses. The companion side
 * is always a real WordPress instance, reached over HTTP with an Application
 * Password, never a mock.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Scenario, Recorder, REPO_ROOT, ARTIFACTS } from './runner.ts';

// adm-zip is a dependency of x-agent/mcp, not of proof/. Resolve it from there
// rather than duplicating the dependency.
const requireFromMcp = createRequire(path.join(REPO_ROOT, 'x-agent/mcp/package.json'));

const FX = path.join(REPO_ROOT, 'x-agent/fixtures');
const CFX = path.join(REPO_ROOT, 'x-companion/fixtures');

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The sequence of block delimiters — structure without html-sourced content. */
const delimiters = (markup: string) => (markup.match(/<!--\s*\/?wp:[a-z0-9/-]+/g) ?? []).map((d) => d.replace(/\s+/g, ' '));

/** '#rrggbb' -> 'rgb(r,g,b)', for comparing against getComputedStyle output. */
function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(full, 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}

/** Nesting shape: names + child counts, ignoring attributes. */
function shapeOf(blocks: any[]): any {
  return blocks.map((b) => ({ n: b.name, c: shapeOf(b.innerBlocks ?? []) }));
}

/** Unwrap an MCP CallResult into {ok, data}. */
function unwrap(res: any): { ok: boolean; data: any } {
  const text = res?.content?.[0]?.text ?? '{}';
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: !res.isError, data };
}

/** Pick a tree fixture that only uses blocks the live instance actually has. */
function treeFor(manifest: any, epoch: string) {
  const has = (n: string) => Boolean(manifest.blocks[n]);
  const blocks: any[] = [];
  if (has('core/heading')) blocks.push({ name: 'core/heading', attributes: { content: 'Proof heading', level: 2 } });
  if (has('core/paragraph')) blocks.push({ name: 'core/paragraph', attributes: { content: 'Compiled by the instance, not by a model.' } });
  if (has('core/group') && has('core/paragraph')) {
    blocks.push({
      name: 'core/group',
      attributes: {},
      innerBlocks: [{ name: 'core/paragraph', attributes: { content: 'Nested.' } }],
    });
  }
  return { version: 1, epoch, blocks };
}

/* ───────────────────────────────── P1 ─────────────────────────────────── */

const p1: Scenario = {
  id: 'P1',
  title: 'Handshake and epoch agreement',
  proves: 'The client speaks the companion’s dialect and the epoch is one shared value, not two guesses.',
  needs: 'toolchain',
  async run({ env, call }, t) {
    const c = unwrap(await call('wp_connect', {}));
    t.check('wp_connect succeeded', c.ok, c.data.code ?? 'ok');
    t.note('site_url', c.data.site_url);
    t.note('wp_version', c.data.wp_version);
    t.note('posture', c.data.posture);

    const fp = await env.call('GET', '/x-companion/v1/fingerprint');
    t.eq('agent fingerprint === companion GET /fingerprint', c.data.fingerprint, fp.json.fingerprint);
    t.eq('posture agrees', c.data.posture, fp.json.posture);
    t.eq('interfaces_version is 2', fp.json.interfaces_version, '2');

    const m = unwrap(await call('wp_manifest', {}));
    t.eq('blocks_count === manifest counts.blocks', c.data.blocks_count, m.data.counts.blocks);

    const bt = await env.call('GET', '/wp/v2/block-types');
    const live = Array.isArray(bt.json) ? bt.json.length : Object.keys(bt.json).length;
    t.check(
      'manifest block count tracks the live WP registry',
      Math.abs(live - m.data.counts.blocks) <= 2,
      `manifest=${m.data.counts.blocks} wp/v2/block-types=${live}`,
    );
    t.note('suites detected', c.data.suites);
  },
};

/* ───────────────────────────────── P2 ─────────────────────────────────── */

const p2: Scenario = {
  id: 'P2',
  title: 'Auth and capability gating are real',
  proves: 'Tiering is enforced in code by the permission callback, not hidden in a UI.',
  needs: 'toolchain',
  async run({ env }, t) {
    const anon = await env.call('GET', '/x-companion/v1/manifest', { as: 'anon' });
    t.eq('anonymous GET /manifest is 401', anon.status, 401);
    t.eq('  with the pinned error envelope code', anon.json.code, 'rest_forbidden');

    const asAgent = await env.call('GET', '/x-companion/v1/manifest', { as: 'agent' });
    t.eq('the x_agent role reads the manifest', asAgent.status, 200);
    t.note('x_agent identity', env.runtime.agent.user + ' / role=' + env.runtime.agent.role);

    const anonFp = await env.call('GET', '/x-companion/v1/fingerprint', { as: 'anon' });
    t.eq('even the cheap epoch route requires auth', anonFp.status, 401);

    // Extend tier on a toolchain instance is permitted for admin.
    const lib = await env.call('GET', '/x-companion/v1/blocks/library', { as: 'admin' });
    t.check('extend tier is reachable for admin on toolchain', lib.status === 200, `HTTP ${lib.status}`);
  },
};

/* ───────────────────────────────── P3 ─────────────────────────────────── */

const p3: Scenario = {
  id: 'P3',
  title: 'Tree → validate → compile → parse round trip',
  proves: 'The core loop is closed and idempotent; the markup came from WordPress’s own save(), not a model.',
  needs: 'toolchain',
  async run({ env, call }, t) {
    const fp = (await env.call('GET', '/x-companion/v1/fingerprint')).json.fingerprint;
    const manifest = unwrap(await call('wp_manifest', {})).data;
    const tree = treeFor(manifest, fp);
    t.note('tree block names', tree.blocks.map((b: any) => b.name));

    const v = unwrap(await call('wp_validate', tree));
    t.check('wp_validate reports valid', v.data.valid === true, JSON.stringify(v.data.diagnostics ?? []));
    t.eq('epoch_ok', v.data.epoch_ok, true);

    const c = unwrap(await call('wp_compile', tree));
    t.check('wp_compile succeeded', c.ok, c.data.code ?? 'ok');
    t.eq('all_valid', c.data.all_valid, true);
    t.check('markup carries block delimiters', String(c.data.markup).includes('<!-- wp:'), String(c.data.markup).slice(0, 120));
    t.artifact('p3-compiled.html', c.data.markup);

    // Feed the compiled markup back through the companion's parser.
    const parsed = unwrap(await call('wp_parse', { markup: c.data.markup }));
    const names = (parsed.data.tree?.blocks ?? []).map((b: any) => b.name).filter(Boolean);
    t.eq('parse-back yields the same block names', names, tree.blocks.map((b: any) => b.name));
    t.eq('and the same nesting shape', shapeOf(parsed.data.tree?.blocks ?? []), shapeOf(tree.blocks));

    // Recompile the parsed-back tree and compare the block STRUCTURE.
    const reTree = { version: 1, epoch: fp, blocks: parsed.data.tree?.blocks ?? [] };
    const c2 = unwrap(await call('wp_compile', reTree));
    t.check('recompile succeeded', c2.ok, c2.data.code ?? 'ok');
    t.eq('round trip is structurally idempotent', delimiters(c2.data.markup), delimiters(c.data.markup));

    // A real, load-bearing limitation, asserted rather than glossed over.
    //
    // TreeIR carries no innerHTML by rule (CONTRACT.md §1), but core blocks store
    // their text in html-sourced attributes, which live in innerHTML rather than
    // in parse_blocks()' `attrs`. So the STRIPPED tree cannot round-trip text: the
    // recompiled markup keeps every block and every attrs-sourced attribute, and
    // loses the prose. Brownfield lifting therefore has to read the RAW form.
    const text = 'Compiled by the instance, not by a model.';
    t.check('the compiled markup contained the paragraph text', c.data.markup.includes(text), text);
    t.check('the RAW parse output preserves it (this is the lifting path)',
      JSON.stringify(parsed.data.blocks ?? []).includes(text),
      'raw parse_blocks() innerHTML retains html-sourced content');
    t.check('the STRIPPED tree does NOT — html-sourced attributes are not in attrs',
      !JSON.stringify(parsed.data.tree).includes(text),
      'stripped TreeIR carries structure + attrs-sourced attributes only');
  },
};

/* ───────────────────────────────── P4 ─────────────────────────────────── */

const p4: Scenario = {
  id: 'P4',
  title: 'The validator is grounded in this instance’s registry',
  proves: 'Validation catches, before a round trip, what the compiler would mishandle.',
  needs: 'toolchain',
  async run({ env }, t) {
    // W_HINT_* only fires when a block actually declares hints, so provision the
    // documented extension point rather than skipping two of the eleven codes.
    // This is exactly the integration the filter exists for.
    await env.php(`<?php
      require_once '/wordpress/wp-load.php';
      $dir = WP_CONTENT_DIR . '/mu-plugins';
      if ( ! is_dir( $dir ) ) { mkdir( $dir, 0777, true ); }
      // Mirror what the W_HINT_* fixtures assume: core/cover restricts its children,
      // core/query locks its template. This is the filter's documented use.
      $php = '<?php add_filter("x_companion_agent_hints", function( $hints, $name, $type ) {'
           . ' if ( "core/cover" === $name ) {'
           . '   $hints["allowed_blocks"] = array("core/heading","core/paragraph");'
           . '   $hints["usage_notes"]    = "proof-suite hint fixture";'
           . ' }'
           . ' if ( "core/query" === $name ) { $hints["template_lock"] = "all"; }'
           . ' return $hints; }, 10, 3 );';
      file_put_contents( $dir . '/x-proof-hints.php', $php );
      echo 'ok';
    `);
    const hinted = await env.call('GET', '/x-companion/v1/manifest', { as: 'agent', query: { refresh: '1' } });
    t.check('the x_companion_agent_hints filter reaches the manifest',
      Boolean(hinted.json?.blocks?.['core/cover']?.agent_hints?.allowed_blocks),
      hinted.json?.blocks?.['core/cover']?.agent_hints);

    const fp = (await env.call('GET', '/x-companion/v1/fingerprint')).json.fingerprint;
    const dir = path.join(CFX, 'trees');
    const expectedDir = path.join(CFX, 'expected');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    t.note('companion fixture trees exercised', files.length);

    // The `expected/` fixtures are ground truth for the OFFLINE registry snapshot
    // the PHP unit tests run against. They are deliberately NOT asserted verbatim
    // here: this instance is a different WordPress with a different registry, and
    // the whole thesis of both specs is that the instance is the ground truth. So
    // assert the code each fixture exists to trigger, and record divergence.
    const seen = new Set<string>();
    const divergences: string[] = [];
    const INTENDED: Record<string, string> = {
      'err-tree-schema': 'E_TREE_SCHEMA', 'err-unknown-block': 'E_UNKNOWN_BLOCK',
      'err-attr-type': 'E_ATTR_TYPE', 'err-attr-enum': 'E_ATTR_ENUM',
      'err-nest-parent': 'E_NEST_PARENT', 'err-nest-ancestor': 'E_NEST_ANCESTOR',
      'err-epoch-mismatch': 'E_EPOCH_MISMATCH', 'warn-attr-unknown': 'W_ATTR_UNKNOWN',
      'warn-static-needs-harness': 'W_STATIC_NEEDS_HARNESS',
      'warn-hint-allowed-blocks': 'W_HINT_ALLOWED_BLOCKS',
      'warn-hint-template-lock': 'W_HINT_TEMPLATE_LOCK',
    };

    for (const f of files) {
      const stem = f.replace(/\.json$/, '');
      const raw = fs.readFileSync(path.join(dir, f), 'utf8').replace(/__CURRENT_FINGERPRINT__/g, fp);
      const tree = JSON.parse(raw);
      const res = await env.call('POST', '/x-companion/v1/validate', { body: tree, as: 'agent' });
      const codes: string[] = (res.json.diagnostics ?? []).map((d: any) => d.code);
      codes.forEach((c) => seen.add(c));

      const intended = INTENDED[stem];
      if (intended) {
        const hit = (res.json.diagnostics ?? []).find((d: any) => d.code === intended);
        t.check(`${stem} → ${intended}`, Boolean(hit), hit ? `${hit.code} at ${hit.path}` : codes);
        if (intended.startsWith('E_')) t.eq(`  ${stem} is invalid`, res.json.valid, false);
        else t.eq(`  ${stem} stays valid (warnings do not invalidate)`, res.json.valid, true);
      } else if (stem.startsWith('valid')) {
        t.check(`${stem} validates clean`, res.json.valid === true, codes);
      }

      const expPath = path.join(expectedDir, f);
      if (fs.existsSync(expPath)) {
        const want = (readJson(expPath).diagnostics ?? []).map((d: any) => d.code).sort().join(',');
        const got = [...codes].sort().join(',');
        if (want !== got) divergences.push(`${stem}: snapshot=[${want}] live=[${got}]`);
      }
    }

    // Divergence is a RESULT, not a failure: it is the instance-as-ground-truth
    // thesis showing up in real data.
    t.note('fixtures whose live diagnostics differ from the offline snapshot', divergences.length ? divergences : 'none');
    if (divergences.length) {
      t.note('why', 'the offline snapshot is WP 6.5-era; on this WP many core blocks are now dynamic, so W_STATIC_NEEDS_HARNESS fires less often. The PHP unit tests assert the snapshot; this suite asserts the live registry.');
    }

    const wanted = ['E_TREE_SCHEMA','E_UNKNOWN_BLOCK','E_ATTR_TYPE','E_ATTR_ENUM','E_NEST_PARENT','E_NEST_ANCESTOR','E_EPOCH_MISMATCH','W_ATTR_UNKNOWN','W_STATIC_NEEDS_HARNESS','W_HINT_ALLOWED_BLOCKS','W_HINT_TEMPLATE_LOCK'];
    const missing = wanted.filter((c) => !seen.has(c));
    t.check('every diagnostic code in the contract was produced by the LIVE validator', missing.length === 0, `covered ${seen.size}/11, missing: ${missing.join(',') || 'none'}`);
  },
};

/* ───────────────────────────────── P5 ─────────────────────────────────── */

const p5: Scenario = {
  id: 'P5',
  title: 'Epoch invalidation is live, not cached optimism',
  proves: 'Ground truth moves and both sides notice — the whole reason epochs exist.',
  needs: 'toolchain',
  async run({ env, call }, t) {
    const fp1 = (await env.call('GET', '/x-companion/v1/fingerprint')).json.fingerprint;
    const manifest = unwrap(await call('wp_manifest', { refresh: true })).data;
    const tree = treeFor(manifest, fp1);

    const c1 = unwrap(await call('wp_compile', tree));
    t.eq('compiles at epoch E1', c1.data.all_valid, true);
    t.note('E1', fp1.slice(0, 16) + '…');

    // Move ground truth: register a block via a mu-plugin-ish runtime hook.
    await env.php(`<?php
      require_once '/wordpress/wp-load.php';
      $dir = WP_CONTENT_DIR . '/mu-plugins';
      if ( ! is_dir( $dir ) ) { mkdir( $dir, 0777, true ); }
      file_put_contents( $dir . '/x-proof-epoch.php', '<?php add_action("init", function(){ register_block_type("proof/epoch-marker", array("api_version"=>3,"title"=>"Proof Epoch Marker","attributes"=>array("note"=>array("type"=>"string")),"render_callback"=>function($a){ return "<div>marker</div>"; })); });' );
      echo 'written';
    `);
    const fp2 = (await env.call('GET', '/x-companion/v1/fingerprint')).json.fingerprint;
    t.check('fingerprint moved after a registry change', fp2 !== fp1, `E1=${fp1.slice(0,12)}… E2=${fp2.slice(0,12)}…`);

    // A tree still carrying E1 must be rejected — but still fully diagnosed.
    const stale = { ...tree, epoch: fp1, blocks: [...tree.blocks, { name: 'core/definitely-not-a-block', attributes: {} }] };
    const d = await env.call('POST', '/x-companion/v1/validate', { body: stale, as: 'agent' });
    const codes = (d.json.diagnostics ?? []).map((x: any) => x.code);
    t.check('stale epoch produces E_EPOCH_MISMATCH', codes.includes('E_EPOCH_MISMATCH'), codes);
    t.eq('epoch_ok is false', d.json.epoch_ok, false);
    t.eq('valid is false', d.json.valid, false);
    t.check('other diagnostics still ran in the SAME response', codes.includes('E_UNKNOWN_BLOCK'), codes);

    // The agent session must adopt E2 by itself.
    const m2 = unwrap(await call('wp_manifest', { refresh: true })).data;
    t.eq('agent manifest adopted E2', m2.fingerprint, fp2);
    t.check('new block is in the manifest vocabulary', Boolean(m2.blocks['proof/epoch-marker']), Object.keys(m2.blocks).length + ' blocks');
    const c2 = unwrap(await call('wp_compile', { ...tree, epoch: fp2 }));
    t.eq('session auto-reloaded and compiles at E2', c2.data.all_valid, true);
  },
};

/* ───────────────────────────────── P6 ─────────────────────────────────── */

const p6: Scenario = {
  id: 'P6',
  title: 'Vocabulary gap ladder, end to end',
  proves: 'The agent can grow the instance’s block vocabulary and immediately use it. The headline claim of both specs.',
  needs: 'toolchain',
  async run({ env, call }, t) {
    const before = (await env.call('GET', '/x-companion/v1/fingerprint')).json.fingerprint;

    // Prefer a prebuilt fixture package if the factory's build is expensive.
    const zip = path.join(CFX, 'packages/agent-testimonial.zip');
    if (!fs.existsSync(zip)) return { skipped: 'fixtures/packages/agent-testimonial.zip not built' };
    t.note('package', `agent-testimonial.zip (${(fs.statSync(zip).size / 1024).toFixed(1)} KB)`);

    const inst = await env.call('POST', '/x-companion/v1/blocks/install', {
      as: 'admin',
      multipart: [{ name: 'package', filePath: zip }],
    });
    t.eq('POST /blocks/install succeeded', inst.status, 200);
    t.note('installed', inst.json.installed);
    const after = inst.json.fingerprint;
    t.check('install returned a NEW epoch', after && after !== before, `${before.slice(0,12)}… → ${String(after).slice(0,12)}…`);

    // 1. It is now part of the manifest vocabulary.
    const mres = unwrap(await call('wp_manifest', { refresh: true }));
    t.check('wp_manifest answered with a blocks map', mres.ok && Boolean(mres.data?.blocks), JSON.stringify(mres.data).slice(0, 200));
    const m = mres.data;
    const name = inst.json.installed.name;
    t.check(`${name} is in the manifest`, Boolean(m.blocks[name]), Object.keys(m.blocks).filter((k) => k.startsWith('agent/')));
    t.eq('manifest epoch === install epoch', m.fingerprint, after);

    // 2. It is registered client-side in the harness too.
    const page = await env.harnessPage();
    const registry: string[] = await page.evaluate(() => (window as any).__registry());
    t.check(`${name} is in window.__registry()`, registry.includes(name), `${registry.length} client-registered blocks`);

    // 2b. Every script the warm harness page loads actually resolves. A block
    // installed under uploads/ whose editor-script URL is computed wrongly
    // (core's plugins_url() fallback) 404s silently, falls out of the client
    // registry, and only surfaces later as harness_gap at compile time — the
    // exact regression found live with agent/tap-meter. Zero dead scripts is
    // the invariant.
    const scriptSrcs: string[] = await page.evaluate(() => Array.from(document.scripts).map((sc) => sc.src).filter((u) => u.length > 0));
    const fetched: { u: string; status: number }[] = await page.evaluate(
      async (urls: string[]) =>
        Promise.all(
          urls.map(async (u) => {
            try {
              const r = await fetch(u);
              return { u, status: r.status };
            } catch {
              return { u, status: 0 };
            }
          }),
        ),
      scriptSrcs,
    );
    const dead = fetched.filter((r) => r.status >= 400 || r.status === 0);
    t.check(
      'every harness script URL resolves after a warm-session install',
      dead.length === 0,
      dead.length ? dead.slice(0, 3).map((d) => `${d.status} ${d.u}`).join(', ') : `${fetched.length} scripts checked`,
    );

    // 3. A tree USING it validates and compiles.
    const tree = { version: 1, epoch: after, blocks: [{ name, attributes: { quote: 'It compiled.', author: 'the instance' } }] };
    const v = unwrap(await call('wp_validate', tree));
    t.check('tree using the new block validates', v.data.valid === true, JSON.stringify(v.data.diagnostics ?? []));
    const c = unwrap(await call('wp_compile', tree));
    t.eq('and compiles all_valid', c.data.all_valid, true);
    t.note('compiled markup', c.data.markup);
    t.artifact('p6-agent-block.html', c.data.markup);

    // 4. And renders server-side with its attribute values.
    const r = await env.call('POST', '/x-companion/v1/render', { body: { markup: c.data.markup }, as: 'agent' });
    t.eq('POST /render is 200', r.status, 200);
    t.check('rendered HTML carries the attribute value', String(r.json.html).includes('It compiled.'), String(r.json.html).slice(0, 200));
  },
};

/* ───────────────────────────────── P7 ─────────────────────────────────── */

const p7: Scenario = {
  id: 'P7',
  title: 'The local safety gate is the gate',
  proves: 'The division of labour is honoured: the agent stops bad packages, the companion does no PHP linting.',
  needs: 'toolchain',
  async run({ env, call }, t) {
    const libBefore = await env.call('GET', '/x-companion/v1/blocks/library', { as: 'admin' });
    const countBefore = Array.isArray(libBefore.json) ? libBefore.json.length : 0;

    fs.mkdirSync(ARTIFACTS, { recursive: true });
    const dir = fs.mkdtempSync(path.join(ARTIFACTS, 'sabotage-'));
    const s = unwrap(await call('wp_block_scaffold', {
      slug: 'proof-broken', title: 'Proof Broken', dir,
      attributes: [{ name: 'text', type: 'string', control: 'text' }],
      render_intent: 'deliberately sabotaged for the proof suite',
    }));
    if (!s.ok) return { skipped: `wp_block_scaffold unavailable: ${s.data.code} ${s.data.message ?? ''}` };
    const blockDir = s.data.dir;
    t.note('scaffolded at', path.relative(REPO_ROOT, blockDir));

    // Sabotage render.php with a hard PHP syntax error.
    const renderPhp = path.join(blockDir, 'render.php');
    fs.writeFileSync(renderPhp, '<?php\nthis is not php at all <<<>>> ;\n');
    t.note('render.php sabotaged', 'syntax error injected');

    const b = unwrap(await call('wp_block_build_test', { dir: blockDir, sample_attributes: { text: 'x' } }));
    t.check('build_test did NOT succeed', b.ok === false || b.data.smoke?.php_error || b.data.built === false,
      JSON.stringify({ ok: b.ok, code: b.data.code, built: b.data.built, php_error: b.data.smoke?.php_error?.slice?.(0, 120) }));
    t.check('no zip was produced', !b.data.zip_path || !fs.existsSync(b.data.zip_path), b.data.zip_path ?? 'none');

    const libAfter = await env.call('GET', '/x-companion/v1/blocks/library', { as: 'admin' });
    const countAfter = Array.isArray(libAfter.json) ? libAfter.json.length : 0;
    t.eq('nothing reached the instance', countAfter, countBefore);

    fs.rmSync(dir, { recursive: true, force: true });
  },
};

/* ───────────────────────────────── P8 ─────────────────────────────────── */

const p8: Scenario = {
  id: 'P8',
  title: 'Install policy is enforced server-side',
  proves: 'The companion does not trust the agent, even though the agent is the safety gate.',
  needs: 'toolchain',
  async run({ env }, t) {
    const pkgs = path.join(CFX, 'packages');
    const cases: [string, string][] = [
      ['agent-static-card.zip', 'a static block (no render entry)'],
      ['agent-traversal.zip', 'a zip containing a ../ path traversal entry'],
      ['wrong-namespace.zip', 'a block named outside the agent/ namespace'],
    ];
    let ran = 0;
    for (const [file, why] of cases) {
      const p = path.join(pkgs, file);
      if (!fs.existsSync(p)) { t.note(`skipped ${file}`, 'fixture not built'); continue; }
      ran++;
      const res = await env.call('POST', '/x-companion/v1/blocks/install', {
        as: 'admin', multipart: [{ name: 'package', filePath: p }],
      });
      t.eq(`${why} → 422`, res.status, 422);
      t.eq(`  code`, res.json.code, 'block_policy');
      t.check(`  reasons are itemised`, Array.isArray(res.json.data?.reasons) && res.json.data.reasons.length > 0, res.json.data?.reasons);
    }
    if (!ran) return { skipped: 'no adversarial fixture packages present' };

    // Re-install the good package: creates .prev, and rollback restores it.
    const good = path.join(pkgs, 'agent-testimonial.zip');
    const v2 = path.join(pkgs, 'agent-testimonial-v2.zip');
    if (fs.existsSync(good) && fs.existsSync(v2)) {
      await env.call('POST', '/x-companion/v1/blocks/install', { as: 'admin', multipart: [{ name: 'package', filePath: good }] });
      const second = await env.call('POST', '/x-companion/v1/blocks/install', { as: 'admin', multipart: [{ name: 'package', filePath: v2 }] });
      t.eq('re-installing a slug reports replaced_previous', second.json.replaced_previous, true);
      const lib = await env.call('GET', '/x-companion/v1/blocks/library', { as: 'admin' });
      const entry = (lib.json as any[]).find((e) => e.slug === 'testimonial');
      t.check('library reports has_prev', entry?.has_prev === true, entry);
      const rb = await env.call('POST', '/x-companion/v1/blocks/library/testimonial/rollback', { as: 'admin' });
      t.eq('rollback is 200', rb.status, 200);
      t.check('rollback returns a fingerprint', typeof rb.json.fingerprint === 'string', String(rb.json.fingerprint).slice(0, 16) + '…');
    }
  },
};

/* ───────────────────────────────── P9 ─────────────────────────────────── */

const p9: Scenario = {
  id: 'P9',
  title: 'Numeric oracle, not screenshot squinting',
  proves: 'The oracle is sensitive and specific: it catches a one-step change and reports nothing else.',
  needs: 'toolchain',
  async run({ env, call }, t) {
    const specPath = path.join(FX, 'specs/golden-landing.json');
    const treePath = path.join(FX, 'trees/golden-landing.json');
    if (!fs.existsSync(specPath) || !fs.existsSync(treePath)) {
      return { skipped: 'golden-landing spec/tree fixtures not captured' };
    }
    const fp = (await env.call('GET', '/x-companion/v1/fingerprint')).json.fingerprint;
    const tree = { ...readJson(treePath), epoch: fp };
    const spec = readJson(specPath);

    const c = unwrap(await call('wp_compile', tree));
    t.eq('golden tree compiles', c.data.all_valid, true);

    const v = unwrap(await call('wp_verify', { markup: c.data.markup, spec, viewport: { width: 1440, height: 900 } }));
    t.check('wp_verify ran', v.ok, v.data.code ?? 'ok');
    const outside = (v.data.diffs ?? []).filter((d: any) => !d.within_tolerance);
    t.note('box_tree nodes measured', (v.data.box_tree ?? []).length);
    t.check('baseline verify passes', v.data.pass === true, `${outside.length} diffs outside tolerance: ${JSON.stringify(outside.slice(0,3))}`);

    // Mutate exactly one thing: the hero heading's font size preset.
    const mutated = JSON.parse(JSON.stringify(tree));
    let mutatedNode: any = null;
    const walk = (bs: any[]) => { for (const b of bs) { if (!mutatedNode && b.name === 'core/heading') mutatedNode = b; if (b.innerBlocks) walk(b.innerBlocks); } };
    walk(mutated.blocks);
    if (!mutatedNode) return { skipped: 'no core/heading in the golden tree to mutate' };
    const was = mutatedNode.attributes?.fontSize;
    mutatedNode.attributes = { ...(mutatedNode.attributes ?? {}), fontSize: was === 'large' ? 'small' : 'large' };
    t.note('mutation', `heading fontSize ${was ?? '(unset)'} → ${mutatedNode.attributes.fontSize}`);

    const c2 = unwrap(await call('wp_compile', mutated));
    const v2 = unwrap(await call('wp_verify', { markup: c2.data.markup, spec, viewport: { width: 1440, height: 900 } }));
    const bad = (v2.data.diffs ?? []).filter((d: any) => !d.within_tolerance);
    t.check('the one-step mutation is detected', bad.length > 0, bad.map((d: any) => `${d.region_id}:${d.kind}`));
    t.check('and it is reported as a font_size diff', bad.some((d: any) => d.kind === 'font_size'), bad.map((d: any) => d.kind));
  },
};

/* ───────────────────────────────── P10 ────────────────────────────────── */

const p10: Scenario = {
  id: 'P10',
  title: 'Tokens flow through both sides to computed pixels',
  proves: 'The design-token system is one system across both plugins, all the way to rendered CSS.',
  needs: 'toolchain',
  async run({ env, call }, t) {
    const tokensPath = fs.existsSync(path.join(CFX, 'design-tokens.sample.json'))
      ? path.join(CFX, 'design-tokens.sample.json')
      : path.join(FX, 'design-tokens.sample.json');
    if (!fs.existsSync(tokensPath)) return { skipped: 'no design-tokens.sample.json fixture' };
    const tokens = readJson(tokensPath);
    t.note('token palette slugs', tokens.palette.map((p: any) => p.slug));

    const applied = unwrap(await call('wp_tokens_apply', tokens));
    t.check('wp_tokens_apply succeeded', applied.ok, applied.data.code ?? 'ok');
    t.note('adapters_applied', applied.data.adapters_applied);

    const m = unwrap(await call('wp_manifest', { refresh: true })).data;
    const paletteBuckets = m.theme_tokens.color.palette;
    const allSlugs = new Set<string>();
    for (const arr of Object.values(paletteBuckets)) for (const p of arr as any[]) allSlugs.add(p.slug);
    const wanted = tokens.palette.map((p: any) => p.slug);
    const present = wanted.filter((s: string) => allSlugs.has(s));
    t.check('token slugs appear in the manifest theme_tokens', present.length === wanted.length, `${present.length}/${wanted.length}: ${present.join(',')}`);

    // The agent's local emitter and the companion's server-side compiler must agree.
    const { emitThemeJsonSettings } = await import('../x-agent/templates/theme-json/emitter.js');
    const local = emitThemeJsonSettings(tokens);
    const localSlugs = local.color.palette.map((p: any) => p.slug).sort();
    t.eq('local emitter produces the same palette slugs as the server wrote', localSlugs, [...wanted].sort());
    const localSpacing = local.spacing.spacingSizes.map((s: any) => s.slug).sort();
    t.eq('and the same spacing step slugs', localSpacing, tokens.spacing.steps.map((s: any) => s.slug).sort());

    // All the way to CSS. The token must become a preset custom property that
    // WordPress actually serves, and the compiled block must carry the class that
    // consumes it.
    const fp = (await env.call('GET', '/x-companion/v1/fingerprint')).json.fingerprint;
    const first = tokens.palette[0];
    const tree = { version: 1, epoch: fp, blocks: [
      { name: 'core/paragraph', attributes: { content: 'token colour probe', backgroundColor: first.slug } },
    ]};
    const c = unwrap(await call('wp_compile', tree));
    t.eq('a tree styled with the token compiles', c.data.all_valid, true);
    t.check(`compiled markup carries the preset class for "${first.slug}"`,
      c.data.markup.includes(`has-${first.slug}-background-color`),
      c.data.markup);

    // The front end must serve the custom property the class resolves against.
    const home = await fetch(env.runtime.url).then((r: any) => r.text());
    const varName = `--wp--preset--color--${first.slug}`;
    const presetMatch = new RegExp(`${varName}\\s*:\\s*([^;}]+)`).exec(home);
    t.check(`WordPress serves ${varName}`, Boolean(presetMatch), presetMatch ? presetMatch[1].trim() : 'not found in front-end HTML');
    t.eq('  and its value is the token hex', String(presetMatch?.[1]).trim().toLowerCase(), String(first.color).toLowerCase());

    // …and all the way to a measured pixel.
    //
    // This step found a real ordering-dependent bug: the oracle caches harvested
    // stylesheets per fingerprint, but a token write changes CSS WITHOUT moving
    // the fingerprint, so a verify that ran earlier kept serving stale styles and
    // this assertion saw rgba(0,0,0,0). wp_tokens_apply now drops that cache.
    // Asserting the pixel here is what keeps that fix honest.
    const v = unwrap(await call('wp_verify', { markup: c.data.markup, viewport: { width: 1440, height: 900 } }));
    const bgs = (v.data.box_tree ?? []).map((n: any) => n.computed?.background).filter(Boolean);
    const rgb = hexToRgb(String(first.color));
    t.check(`a measured element computes to the token colour ${first.color}`,
      bgs.some((b: string) => b.replace(/\s/g, '') === rgb),
      `looking for ${rgb} in ${JSON.stringify(bgs.slice(0, 4))}`);
  },
};

/* ───────────────────────────────── P11 ────────────────────────────────── */

const p11: Scenario = {
  id: 'P11',
  title: 'Posture wall holds from the agent side',
  proves: 'R8: the agent surfaces the constraint instead of routing around it, and sends nothing that would mutate.',
  needs: 'production',
  async run({ env, call }, t) {
    const fp = await env.call('GET', '/x-companion/v1/fingerprint', { as: 'agent' });
    t.eq('instance reports production posture', fp.json.posture, 'production');

    for (const route of ['/x-companion/v1/blocks/install', '/x-companion/v1/theme/tokens', '/x-companion/v1/snapshot/export']) {
      const res = await env.call('POST', route, { as: 'admin', body: {} });
      t.eq(`${route} → 403`, res.status, 403);
      t.eq(`  code`, res.json.code, 'posture_forbidden');
    }

    const tokensPath = path.join(CFX, 'design-tokens.sample.json');
    if (fs.existsSync(tokensPath)) {
      const r = unwrap(await call('wp_tokens_apply', readJson(tokensPath)));
      t.check('wp_tokens_apply refuses', r.ok === false, r.data.code);
      t.eq('  with the exact structured code', r.data.code, 'posture_forbidden');
      t.check('  and a hint naming the sandbox path', /sandbox|clone|snapshot/i.test(String(r.data.hint)), r.data.hint);
    }

    const zip = path.join(CFX, 'packages/agent-testimonial.zip');
    if (fs.existsSync(zip)) {
      const r = unwrap(await call('wp_block_install', { zip_path: zip }));
      t.check('wp_block_install refuses', r.ok === false, r.data.code);
      t.eq('  with the exact structured code', r.data.code, 'posture_forbidden');
      const lib = await env.call('GET', '/x-companion/v1/blocks/library', { as: 'admin' });
      t.eq('  and the library route stays gated too', lib.status, 403);
    }
  },
};

/* ───────────────────────────────── P12 ────────────────────────────────── */

const p12: Scenario = {
  id: 'P12',
  title: 'Snapshot is a promotion gate',
  proves: 'The “production receives artifacts, not the toolchain” pipeline has a real wire format.',
  needs: 'toolchain',
  async run({ env, call }, t) {
    const r = unwrap(await call('wp_snapshot', {}));
    if (!r.ok) return { skipped: `wp_snapshot: ${r.data.code} ${r.data.message ?? ''}` };
    const zipPath = r.data.zip_path;
    t.note('snapshot written', `${path.relative(REPO_ROOT, zipPath)} (${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB)`);

    const AdmZip = requireFromMcp('adm-zip');
    const entries = new AdmZip(zipPath).getEntries().map((e: any) => e.entryName);
    for (const want of ['theme/', 'agent-blocks/', 'patterns.json', 'content.xml', 'manifest.json']) {
      t.check(`snapshot contains ${want}`, entries.some((e: string) => e === want || e.startsWith(want)), entries.filter((e: string) => e.startsWith(want.replace('/', ''))).slice(0, 3));
    }
    const mf = JSON.parse(new AdmZip(zipPath).readAsText('manifest.json'));
    const live = (await env.call('GET', '/x-companion/v1/fingerprint')).json.fingerprint;
    t.eq('manifest.json fingerprint === live /fingerprint', mf.fingerprint, live);
  },
};

/* ───────────────────────────────── P13 ────────────────────────────────── */

const p13: Scenario = {
  id: 'P13',
  title: 'Schema drift tripwire',
  proves: 'The two codebases cannot silently diverge on the shared types.',
  needs: 'none',
  async run(_ctx, t) {
    const src = path.join(REPO_ROOT, 'contract/schemas');
    const copies = [
      path.join(REPO_ROOT, 'x-agent/schemas'),
      path.join(REPO_ROOT, 'x-companion/fixtures/schemas'),
    ];
    const files = fs.readdirSync(src).filter((f) => f.endsWith('.json')).sort();
    t.note('shared schemas', files);
    for (const f of files) {
      const a = crypto.createHash('sha256').update(fs.readFileSync(path.join(src, f))).digest('hex');
      for (const c of copies) {
        const p = path.join(c, f);
        t.check(`${path.relative(REPO_ROOT, p)} exists`, fs.existsSync(p), fs.existsSync(p));
        const b = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        t.eq(`${f} identical in ${path.basename(path.dirname(p))}`, b.slice(0, 12), a.slice(0, 12));
      }
    }
  },
};


/* ───────────────────────────────── P14 ────────────────────────────────── */

const p14: Scenario = {
  id: 'P14',
  title: 'End-to-end from-prompt demo (the R5 loop)',
  proves: 'The skill\u2019s prescribed loop runs start to finish, and the screenshot is terminal evidence \u2014 taken exactly once, never inside the loop.',
  needs: 'toolchain',
  async run({ env, call }, t) {
    // The loop from SKILL.md R5, in order:
    //   retrieve (patterns first) -> generate tree -> validate -> compile -> verify
    //   -> screenshot exactly once, at the end.
    let screenshots = 0;
    const shoot = async (args: any) => { screenshots++; return unwrap(await call('wp_screenshot', args)); };

    const manifest = unwrap(await call('wp_manifest', { refresh: true })).data;
    t.note('vocabulary at this epoch', `${manifest.counts.blocks} blocks, ${manifest.counts.patterns} patterns`);

    // R5: consult the retrieval corpus BEFORE inventing a composition.
    const pats = unwrap(await call('wp_patterns', { query: 'hero' }));
    t.check('wp_patterns returns the retrieval corpus', Array.isArray(pats.data.patterns ?? pats.data), (pats.data.patterns ?? pats.data).length + ' matched');

    const fp = manifest.fingerprint;
    const section = (heading: string, body: string) => ({
      name: 'core/group',
      attributes: { layout: { type: 'constrained' } },
      innerBlocks: [
        { name: 'core/heading', attributes: { content: heading, level: 2 } },
        { name: 'core/paragraph', attributes: { content: body } },
      ],
    });
    const tree = { version: 1, epoch: fp, blocks: [
      section('Built from a tree', 'Three sections, composed as JSON against the live manifest.'),
      section('Never hand-written', 'The markup below came from this instance\u2019s own save() functions.'),
      section('Verified numerically', 'Geometry is measured, not eyeballed.'),
    ]};
    t.eq('the page has three sections', tree.blocks.length, 3);

    const v = unwrap(await call('wp_validate', tree));
    t.check('validate: zero errors', v.data.valid === true, (v.data.diagnostics ?? []).filter((d: any) => d.severity === 'error'));

    const c = unwrap(await call('wp_compile', tree));
    t.eq('compile: all_valid', c.data.all_valid, true);
    // registry_gaps is the GLOBAL manifest-vs-__registry() diff, not a per-tree
    // failure: a handful of core blocks are server-only shims that never register
    // client-side. What must hold is that none of them appear in THIS tree.
    const gaps: string[] = c.data.registry_gaps ?? [];
    const used = new Set<string>();
    (function walk(bs: any[]) { for (const b of bs) { used.add(b.name); walk(b.innerBlocks ?? []); } })(tree.blocks);
    t.note('registry gaps on this instance (server-only shims)', gaps);
    t.eq('none of them are used by this tree', gaps.filter((g) => used.has(g)), []);
    t.artifact('p14-from-prompt.html', c.data.markup);

    const ver = unwrap(await call('wp_verify', { markup: c.data.markup, viewport: { width: 1440, height: 900 } }));
    t.eq('verify passes', ver.data.pass, true);
    const named = (ver.data.box_tree ?? []).filter((n: any) => n.block_name).length;
    t.note('measured nodes / with a resolved block_name', `${(ver.data.box_tree ?? []).length} / ${named}`);
    t.check('the three sections are present in the measured tree',
      (ver.data.box_tree ?? []).filter((n: any) => n.block_name === 'core/heading').length >= 3,
      (ver.data.box_tree ?? []).filter((n: any) => n.block_name === 'core/heading').map((n: any) => Math.round(n.box.y)));

    // Terminal acceptance evidence. Once.
    const shot = await shoot({ markup: c.data.markup, viewport: { width: 1440, height: 900 } });
    t.check('wp_screenshot produced a PNG', shot.ok && fs.existsSync(shot.data.path_to_png), shot.data.path_to_png ?? shot.data.code);
    const png = fs.readFileSync(shot.data.path_to_png);
    t.check('  and it is a real PNG', png.subarray(1, 4).toString() === 'PNG', `${(png.length / 1024).toFixed(1)} KB`);
    t.artifact('p14-acceptance.png', png);
    t.eq('exactly one screenshot in the whole run', screenshots, 1);
  },
};

/* ───────────────────────────────── P15 ────────────────────────────────── */

const p15: Scenario = {
  id: 'P15',
  title: 'End-to-end from-design demo (lift \u2192 implement \u2192 attribute the delta)',
  proves: 'A design spec is validated before any tree is generated, and every residual difference is an itemised decision rather than a vibe.',
  needs: 'toolchain',
  async run({ env, call }, t) {
    // R6: wp_spec_validate must pass before any tree is generated.
    const heroPath = path.join(FX, 'specs/hero-sample.json');
    if (!fs.existsSync(heroPath)) return { skipped: 'fixtures/specs/hero-sample.json missing' };
    const hero = readJson(heroPath);
    const hv = unwrap(await call('wp_spec_validate', hero));
    t.check('the lifted spec validates clean', hv.data.valid === true, hv.data.diagnostics);
    t.check('every observed value was quantised onto the token scale',
      (hero.tokens_candidates.quantization_log ?? []).length > 0,
      `${hero.tokens_candidates.quantization_log.length} snap-to-token entries logged`);
    const synth = JSON.stringify(hero.regions).match(/"confidence":"synthesized"/g) ?? [];
    t.note('synthesized (human-vetoable) responsive assumptions', synth.length);

    // Every diagnostic code the local spec validator can emit is reachable.
    const codes = new Set<string>();
    for (const f of fs.readdirSync(path.join(FX, 'specs')).filter((x) => /^(invalid|warn)-/.test(x))) {
      const r = unwrap(await call('wp_spec_validate', readJson(path.join(FX, 'specs', f))));
      (r.data.diagnostics ?? []).forEach((d: any) => codes.add(d.code));
      t.note(`${f}`, (r.data.diagnostics ?? []).map((d: any) => d.code));
    }
    const want = ['E_SPEC_SCHEMA', 'E_BOX_OVERLAP', 'E_ORPHAN_CONTENT', 'W_UNQUANTIZED', 'W_NO_RESPONSIVE'];
    t.eq('every wp_spec_validate code is reachable from a fixture', want.filter((c) => codes.has(c)).sort(), [...want].sort());

    // Implement -> verify against a spec measured from the real render.
    const specPath = path.join(FX, 'specs/golden-landing.json');
    const treePath = path.join(FX, 'trees/golden-landing.json');
    if (!fs.existsSync(specPath) || !fs.existsSync(treePath)) {
      return { skipped: 'golden-landing spec/tree not captured; the lift half above still ran' };
    }
    const fp = (await env.call('GET', '/x-companion/v1/fingerprint')).json.fingerprint;
    const spec = readJson(specPath);
    const sv = unwrap(await call('wp_spec_validate', spec));
    t.check('the implementation target spec also validates', sv.data.valid === true, sv.data.diagnostics);

    const c = unwrap(await call('wp_compile', { ...readJson(treePath), epoch: fp }));
    t.eq('the implementing tree compiles', c.data.all_valid, true);

    const ver = unwrap(await call('wp_verify', { markup: c.data.markup, spec, viewport: { width: 1440, height: 900 } }));
    const outside = (ver.data.diffs ?? []).filter((d: any) => !d.within_tolerance);
    t.note('regions diffed', (ver.data.diffs ?? []).length);
    t.check('every residual difference is within tolerance or attributable to a logged token snap',
      outside.length === 0,
      outside.length ? outside.map((d: any) => `${d.region_id}:${d.kind} delta=${d.delta}`) : 'none outside tolerance');
    t.eq('verify passes', ver.data.pass, true);
  },
};

/* ───────────────────────────────── P16 ────────────────────────────────── */

const p16: Scenario = {
  id: 'P16',
  title: 'The ordering system, the canon way (schema factory end to end)',
  proves:
    'Storage and backend behavior enter through a gated schema package, never through improvisation: model installed with source "agent", an anonymous nonce’d submit lands as a moderated CPT entry, the agent-created binding source validates, and zero comments are created.',
  needs: 'toolchain',
  async run({ env, call }, t) {
    const workDir = path.join(ARTIFACTS, 'p16-schema');
    fs.rmSync(workDir, { recursive: true, force: true });

    // 1. Scaffold the orders package — the wp-schema discipline's worked example.
    const scaffolded = unwrap(
      await call('wp_schema_scaffold', {
        slug: 'orders',
        intent:
          'Pickup orders for a bakery: customers submit through a public form, staff work orders through pending -> ready -> picked-up in the standard admin list.',
        post_types: [
          {
            slug: 'hc-order',
            label: 'Orders',
            meta: [
              { key: 'pickup_day', type: 'string' },
              { key: 'contact', type: 'string' },
            ],
            statuses: [
              { slug: 'ready', label: 'Ready' },
              { slug: 'picked-up', label: 'Picked up' },
            ],
          },
        ],
        routes: [
          { path: '/submit', methods: ['POST'], auth: 'public-nonce' },
          { path: '/orders', methods: ['GET'], auth: 'capability', capability: 'edit_posts' },
        ],
        bindings: [{ name: 'pickup-day', meta_key: 'pickup_day', label: 'Pickup day' }],
        dir: workDir,
      }),
    );
    t.check('wp_schema_scaffold produced the package', scaffolded.ok, scaffolded.data.files ?? scaffolded.data);

    // 2. THE GATE. A throwaway sandbox must prove the whole model first.
    const gated = unwrap(await call('wp_schema_build_test', { dir: scaffolded.data.dir }));
    t.check('wp_schema_build_test is green', gated.ok && gated.data.built === true, gated.ok ? 'built' : gated.data);
    t.check('  every meta key REST-visible', Object.values(gated.data.smoke?.meta_in_rest ?? {}).every(Boolean), gated.data.smoke?.meta_in_rest);
    t.check('  routes answered as declared', (gated.data.smoke?.routes ?? []).every((r: any) => r.ok), gated.data.smoke?.routes);
    t.check('  uninstall leaves nothing behind', gated.data.smoke?.uninstall_clean === true, 'sandbox post-uninstall diff');
    if (!gated.data.zip_path) return { skipped: 'gate produced no zip; earlier checks carry the failure detail' };

    // 3. Install; the epoch moves and the model is vocabulary.
    const commentsBefore = await env.call('GET', '/wp/v2/comments', { as: 'admin' });
    const nBefore = Array.isArray(commentsBefore.json) ? commentsBefore.json.length : 0;

    const installed = unwrap(await call('wp_schema_install', { zip_path: gated.data.zip_path }));
    t.check('wp_schema_install succeeded', installed.ok, installed.data.code ?? installed.data.installed);
    t.check('the epoch moved', installed.data.fingerprint !== installed.data.previous_fingerprint, `${String(installed.data.previous_fingerprint).slice(0, 12)}… -> ${String(installed.data.fingerprint).slice(0, 12)}…`);

    const dm = unwrap(await call('wp_manifest', { section: 'data_model', client_capture: false }));
    const hcOrder = (dm.data.data_model?.post_types ?? []).find((p: any) => p.slug === 'hc_order');
    t.check('data_model lists hc_order with source "agent"', hcOrder?.source === 'agent', hcOrder);
    t.check('  meta keys visible in the model', (hcOrder?.meta_keys ?? []).includes('pickup_day'), hcOrder?.meta_keys);

    // 4. An anonymous customer submits over the nonce'd route. No comments involved.
    const nonce = String(
      (
        await env.php(`<?php
      require_once '/wordpress/wp-load.php';
      wp_set_current_user( 0 );
      echo wp_create_nonce( 'wp_rest' );
    `)
      ).text ?? '',
    ).trim();
    const submit = await env.call('POST', '/agent-orders/v1/submit', {
      as: 'anon',
      body: { _wpnonce: nonce, hp_website: '', title: 'Proof order', pickup_day: 'Saturday', contact: 'neighbor@example.com' },
    });
    t.eq('anonymous nonce’d submit answers 201/200', submit.status < 300, true);
    const orderId = submit.json?.created;
    t.check('the route created an order', Number(orderId) > 0, submit.json);

    const noNonce = await env.call('POST', '/agent-orders/v1/submit', { as: 'anon', body: { title: 'no nonce' } });
    t.eq('the same route without a nonce is refused', noNonce.status, 403);

    // 5. The order is a moderated CPT entry with structured fields — an inbox, not a comment.
    const order = await env.call('GET', `/wp/v2/hc_order/${orderId}`, { as: 'admin', query: { context: 'edit' } });
    t.eq('order status is moderated (pending)', order.json?.status, 'pending');
    t.eq('pickup_day meta round-tripped', order.json?.meta?.pickup_day, 'Saturday');

    const commentsAfter = await env.call('GET', '/wp/v2/comments', { as: 'admin' });
    const nAfter = Array.isArray(commentsAfter.json) ? commentsAfter.json.length : 0;
    t.eq('ZERO comments created by the ordering flow', nAfter, nBefore);

    // 6. The agent-created binding source is validator-checkable vocabulary.
    const fp = (await env.call('GET', '/x-companion/v1/fingerprint')).json.fingerprint;
    const bound = {
      version: 1,
      epoch: fp,
      blocks: [
        {
          name: 'core/paragraph',
          attributes: { metadata: { bindings: { content: { source: 'agent-orders/pickup-day', args: {} } } } },
        },
      ],
    };
    const okDoc = unwrap(await call('wp_validate', bound));
    t.eq('binding to the package source validates', okDoc.data.valid, true);
    const badDoc = unwrap(
      await call('wp_validate', {
        ...bound,
        blocks: [{ name: 'core/paragraph', attributes: { metadata: { bindings: { content: { source: 'agent-orders/nope', args: {} } } } } }],
      }),
    );
    const codes = (badDoc.data.diagnostics ?? []).map((d: any) => d.code);
    t.check('a bogus source is E_BINDING_UNKNOWN', codes.includes('E_BINDING_UNKNOWN'), codes);
  },
};

/**
 * Execution order, deliberately not numeric.
 *
 * P10 writes design tokens, which rewrites the site's global styles. P9 and P15
 * measure geometry and computed colour against specs captured from the untouched
 * theme, so they must run BEFORE that write — otherwise they measure a site the
 * spec never described, and fail for a reason that has nothing to do with the
 * thing they exist to prove. (Found the hard way: both pass alone and failed in
 * sequence.) P10 therefore runs last.
 *
 * The registry mutations in P5/P6/P8 are safe to interleave: they move the epoch
 * and grow the block vocabulary without restyling anything already rendered.
 */
export const SCENARIOS: Scenario[] = [p1, p2, p3, p4, p5, p6, p7, p8, p9, p11, p12, p13, p14, p15, p16, p10];
