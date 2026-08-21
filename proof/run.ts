/**
 * proof/run.ts — boots the instances the scenarios need, wires the REAL MCP
 * tool entrypoint to them, runs every scenario, and writes proof/REPORT.md.
 *
 * Two instances at most: one `toolchain` (where the agent may extend) and one
 * `production` (where it must not). They are booted lazily, so a filtered run
 * pays only for what it uses.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore — plain-JS helper with JSDoc types
import { boot } from '../tools/playground/boot.mjs';
// @ts-ignore
import { ProofEnv } from './lib/env.mjs';
import { SCENARIOS } from './scenarios.ts';
import { runScenarios, writeReport, InstanceKey, REPO_ROOT } from './runner.ts';
import { Runtime } from '../x-agent/mcp/src/context.js';
import { callTool } from '../x-agent/mcp/src/server.js';
import { loadExternalHandlers } from '../x-agent/mcp/src/registry.js';

const PORTS: Record<string, number> = { toolchain: 9460, production: 9461 };

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const scenarios = only.length
  ? SCENARIOS.filter((s) => only.some((o) => s.id.toLowerCase() === o.toLowerCase()))
  : SCENARIOS;

if (!scenarios.length) {
  console.error(`No scenarios matched ${JSON.stringify(only)}. Known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(2);
}

const booted = new Map<InstanceKey, any>();

async function ctxFor(kind: InstanceKey) {
  if (kind === 'none') return {};
  if (booted.has(kind)) return booted.get(kind);

  process.stdout.write(`\n── booting ${kind} instance on port ${PORTS[kind]} …\n`);
  const instance = await boot({
    profile: 'core-only',
    posture: kind,
    port: PORTS[kind],
    plugins: [path.join(REPO_ROOT, 'x-companion')],
    slot: `proof-${kind}`,
    quiet: true,
  });
  const env = new ProofEnv(instance);

  // Point the real MCP runtime at this instance via the documented env chain.
  const runtime = new Runtime({
    cwd: REPO_ROOT,
    env: {
      X_WP_URL: env.runtime.url,
      X_WP_USER: env.runtime.admin.user,
      X_WP_APP_PASSWORD: env.runtime.admin.app_password,
    },
  });
  const call = (name: string, args: unknown) => callTool(name, args, runtime);

  const ctx = { env, runtime, call, instance };
  booted.set(kind, ctx);
  process.stdout.write(`   ready: ${env.runtime.url}  (WP ${env.runtime.wp_version}, posture ${env.runtime.posture})\n`);
  return ctx;
}

async function main() {
  const report = await loadExternalHandlers({ force: true });
  if (report.missing.length) {
    console.error(`\n! ${report.missing.length} MCP tool handlers are missing: ${report.missing.join(', ')}`);
    console.error('  Scenarios needing them will fail rather than be silently skipped.\n');
  }

  const started = Date.now();
  const results = await runScenarios(scenarios, ctxFor);

  for (const [, ctx] of booted) {
    try { await ctx.env._teardown?.(); } catch {}
    try { await ctx.runtime.dispose?.(); } catch {}
    try { await ctx.instance.stop?.(); } catch {}
  }

  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;

  writeReport(results, {
    'generated': new Date().toISOString(),
    'WordPress': booted.get('toolchain')?.env?.runtime?.wp_version ?? booted.get('production')?.env?.runtime?.wp_version ?? 'n/a',
    'instances': [...booted.keys()].join(', ') || 'none',
    'duration': `${((Date.now() - started) / 1000).toFixed(1)}s`,
  });

  process.stdout.write(`\n${'─'.repeat(70)}\n`);
  process.stdout.write(`${pass} passed, ${fail} failed, ${skip} skipped  →  proof/REPORT.md\n`);
  for (const r of results.filter((x) => x.status !== 'pass')) {
    process.stdout.write(`  ${r.status.toUpperCase()}  ${r.id} ${r.title}${r.detail ? ' — ' + r.detail.split('\n')[0] : ''}\n`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
