/**
 * proof/runner.ts — the interop proof harness.
 *
 * Not a unit-test runner. Its job is to demonstrate, against a REAL WordPress
 * instance, that x-companion and x-agent are actually working together — and to
 * write down what it observed, so a human can check the claim without re-running
 * anything.
 *
 * Design notes:
 *  - Scenarios are grouped by the instance they need, so each Playground
 *    instance boots once rather than once per scenario (a boot is ~10s).
 *  - Every scenario records STEPS, each carrying a real observed value. A pass
 *    with no observations is suspicious, not a pass: "it didn't throw" is not
 *    evidence.
 *  - The agent side is driven through the REAL MCP entrypoint (callTool), not
 *    through internal helpers. If it works here, it works in Claude Code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROOF_ROOT = __dirname;
export const REPO_ROOT = path.resolve(__dirname, '..');
export const ARTIFACTS = path.join(PROOF_ROOT, 'artifacts');

export type InstanceKey = 'toolchain' | 'production' | 'none';

export interface Step { what: string; observed: string; ok: boolean }

export class ProofFailure extends Error {}

export function render(v: unknown): string {
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + ' …' : v;
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 300 ? s.slice(0, 300) + ' …' : s;
  } catch { return String(v); }
}

function sizeOf(c: string | Buffer): string {
  const n = typeof c === 'string' ? Buffer.byteLength(c) : c.length;
  return n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

export class Recorder {
  steps: Step[] = [];

  /** Record an observation. `observed` must be a real value, never a restatement. */
  note(what: string, observed: unknown): void {
    this.steps.push({ what, observed: render(observed), ok: true });
  }

  /** Record an assertion together with the value that satisfied it. */
  check(what: string, condition: boolean, observed: unknown): void {
    this.steps.push({ what, observed: render(observed), ok: condition });
    if (!condition) throw new ProofFailure(`${what}\n    observed: ${render(observed)}`);
  }

  eq(what: string, actual: unknown, expected: unknown): void {
    const ok = render(actual) === render(expected);
    this.steps.push({ what, observed: ok ? render(actual) : `${render(actual)}   (expected ${render(expected)})`, ok });
    if (!ok) throw new ProofFailure(`${what}\n    actual:   ${render(actual)}\n    expected: ${render(expected)}`);
  }

  artifact(name: string, contents: string | Buffer): string {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    const p = path.join(ARTIFACTS, name);
    fs.writeFileSync(p, contents);
    this.steps.push({ what: 'artifact written', observed: `proof/artifacts/${name} (${sizeOf(contents)})`, ok: true });
    return p;
  }
}

export interface Scenario {
  id: string;
  title: string;
  proves: string;
  needs: InstanceKey;
  /** Return {skipped} to skip with a reason instead of failing on an absent precondition. */
  run(ctx: any, t: Recorder): Promise<void | { skipped: string }>;
}

export interface Result {
  id: string; title: string; proves: string; needs: InstanceKey;
  status: 'pass' | 'fail' | 'skip';
  detail?: string; steps: Step[]; ms: number;
}

const meta = (s: Scenario) => ({ id: s.id, title: s.title, proves: s.proves, needs: s.needs });

export async function runScenarios(
  scenarios: Scenario[],
  getCtx: (k: InstanceKey) => Promise<any>,
): Promise<Result[]> {
  const results: Result[] = [];
  for (const s of scenarios) {
    const t = new Recorder();
    const started = Date.now();
    process.stdout.write(`\n${s.id}  ${s.title}\n`);
    try {
      const ctx = await getCtx(s.needs);
      const out = await s.run(ctx, t);
      const ms = Date.now() - started;
      if (out && typeof out === 'object' && 'skipped' in out) {
        results.push({ ...meta(s), status: 'skip', detail: out.skipped, steps: t.steps, ms });
        process.stdout.write(`   SKIP  ${out.skipped}\n`);
      } else {
        results.push({ ...meta(s), status: 'pass', steps: t.steps, ms });
        for (const st of t.steps) process.stdout.write(`   ✓ ${st.what}  →  ${st.observed}\n`);
        process.stdout.write(`   PASS  (${t.steps.length} observations, ${ms}ms)\n`);
      }
    } catch (e: any) {
      for (const st of t.steps) process.stdout.write(`   ${st.ok ? '✓' : '✗'} ${st.what}  →  ${st.observed}\n`);
      const detail = e instanceof ProofFailure ? e.message : `${e?.stack || e}`;
      results.push({ ...meta(s), status: 'fail', detail, steps: t.steps, ms: Date.now() - started });
      process.stdout.write(`   FAIL  ${detail.split('\n')[0]}\n`);
    }
  }
  return results;
}

const escapePipes = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function writeReport(results: Result[], env: Record<string, string>): string {
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;

  const L: string[] = [];
  L.push('# Interop proof report');
  L.push('');
  L.push('Generated by `proof/run-all.sh`. Every row below was produced by running the two');
  L.push('plugins against each other on a real WordPress instance — see `proof/PROOF-PLAN.md`');
  L.push('for what each scenario is meant to establish and why it was chosen.');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(env)) L.push(`| ${k} | ${v} |`);
  L.push(`| result | **${pass} passed, ${fail} failed, ${skip} skipped** of ${results.length} |`);
  L.push('');
  L.push('| scenario | status | proves |');
  L.push('|---|---|---|');
  for (const r of results) {
    const badge = r.status === 'pass' ? '**pass**' : r.status === 'fail' ? '**FAIL**' : 'skip';
    L.push(`| ${r.id} ${escapePipes(r.title)} | ${badge} | ${escapePipes(r.proves)} |`);
  }
  L.push('');
  L.push('---');
  L.push('');
  for (const r of results) {
    L.push(`## ${r.id} — ${r.title}`);
    L.push('');
    L.push(`**Proves:** ${r.proves}  `);
    L.push(`**Instance:** ${r.needs}  •  **Status:** ${r.status}  •  **${r.ms} ms**`);
    L.push('');
    if (r.steps.length) {
      L.push('| observation | value |');
      L.push('|---|---|');
      for (const s of r.steps) L.push(`| ${s.ok ? '✓' : '✗'} ${escapePipes(s.what)} | \`${escapePipes(s.observed)}\` |`);
      L.push('');
    }
    if (r.detail) { L.push('```'); L.push(r.detail.slice(0, 2000)); L.push('```'); L.push(''); }
  }
  const md = L.join('\n') + '\n';
  fs.writeFileSync(path.join(PROOF_ROOT, 'REPORT.md'), md);
  // Also emit the structured form, so anything that renders this run (the HTML
  // report, a CI summary) reads real data instead of re-parsing prose.
  fs.writeFileSync(
    path.join(PROOF_ROOT, 'results.json'),
    JSON.stringify({ env, totals: { pass, fail, skip, total: results.length }, results }, null, 2) + '\n',
  );
  return md;
}
