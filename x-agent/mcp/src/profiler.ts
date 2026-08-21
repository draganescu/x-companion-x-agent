/**
 * Optional per-tool-call profiling — the durations of what actually happens.
 *
 * Off by default. Turned on by `"profile": true` in `.x-agent.json` (the same
 * file that holds the connection), or `X_AGENT_PROFILE=1` in the environment.
 *
 * When on, every tool call appends one event to `x-agent-profile.jsonl` in the
 * working directory and rewrites `x-agent-profile.md` beside it — a report a
 * human can open at any point during a build: per-tool call counts, total,
 * average and worst durations, error counts, and the slowest individual
 * calls. The JSONL is the raw record; the markdown is the view.
 *
 * The profiler never records arguments or results — tool names, durations and
 * error codes only — so nothing sensitive can leak into the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILENAME } from './config.js';

export interface ProfileEvent {
  ts: string;
  tool: string;
  ms: number;
  ok: boolean;
  code?: string;
}

export class Profiler {
  readonly enabled: boolean;
  readonly jsonlPath: string;
  readonly mdPath: string;

  private events: ProfileEvent[] = [];

  constructor(cwd: string = process.cwd(), env: Record<string, string | undefined> = process.env) {
    let fromFile = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(cwd, CONFIG_FILENAME), 'utf8')) as { profile?: unknown };
      fromFile = parsed?.profile === true;
    } catch {
      // No config file or invalid JSON: profiling stays off unless the env asks.
    }
    this.enabled = fromFile || env.X_AGENT_PROFILE === '1';
    this.jsonlPath = path.join(cwd, 'x-agent-profile.jsonl');
    this.mdPath = path.join(cwd, 'x-agent-profile.md');

    if (this.enabled && fs.existsSync(this.jsonlPath)) {
      // Continue an existing session's record so the report spans restarts.
      try {
        this.events = fs
          .readFileSync(this.jsonlPath, 'utf8')
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as ProfileEvent);
      } catch {
        this.events = [];
      }
    }
  }

  record(tool: string, ms: number, ok: boolean, code?: string): void {
    if (!this.enabled) return;
    const event: ProfileEvent = {
      ts: new Date().toISOString(),
      tool,
      ms: Math.round(ms * 10) / 10,
      ok,
      ...(code ? { code } : {}),
    };
    this.events.push(event);
    try {
      fs.appendFileSync(this.jsonlPath, JSON.stringify(event) + '\n');
      fs.writeFileSync(this.mdPath, this.render());
    } catch {
      // Profiling must never break a tool call.
    }
  }

  private render(): string {
    const byTool = new Map<string, { calls: number; total: number; max: number; errors: number }>();
    for (const e of this.events) {
      const s = byTool.get(e.tool) ?? { calls: 0, total: 0, max: 0, errors: 0 };
      s.calls += 1;
      s.total += e.ms;
      s.max = Math.max(s.max, e.ms);
      if (!e.ok) s.errors += 1;
      byTool.set(e.tool, s);
    }
    const rows = [...byTool.entries()].sort((a, b) => b[1].total - a[1].total);
    const total = this.events.reduce((acc, e) => acc + e.ms, 0);
    const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

    const L: string[] = [];
    L.push('# x-agent profile report');
    L.push('');
    L.push(`| calls | time in tools | span |`);
    L.push('|---|---|---|');
    const first = this.events[0]?.ts ?? '—';
    const last = this.events[this.events.length - 1]?.ts ?? '—';
    L.push(`| ${this.events.length} | ${fmt(total)} | ${first} → ${last} |`);
    L.push('');
    L.push('| tool | calls | total | avg | max | errors |');
    L.push('|---|---|---|---|---|---|');
    for (const [tool, s] of rows) {
      L.push(`| \`${tool}\` | ${s.calls} | ${fmt(s.total)} | ${fmt(s.total / s.calls)} | ${fmt(s.max)} | ${s.errors || ''} |`);
    }
    L.push('');
    L.push('## Slowest calls');
    L.push('');
    L.push('| when | tool | duration | outcome |');
    L.push('|---|---|---|---|');
    for (const e of [...this.events].sort((a, b) => b.ms - a.ms).slice(0, 10)) {
      L.push(`| ${e.ts} | \`${e.tool}\` | ${fmt(e.ms)} | ${e.ok ? 'ok' : `error${e.code ? ` (${e.code})` : ''}`} |`);
    }
    L.push('');
    L.push(`Raw events: \`${path.basename(this.jsonlPath)}\` (one JSON object per call; no arguments or results are recorded).`);
    L.push('');
    return L.join('\n');
  }
}
