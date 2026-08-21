/**
 * `npx tsx ../tests/list-tools.ts` (from x-agent/mcp) — prints every registered
 * MCP tool with its JSON input schema, exactly as `tools/list` would return it.
 *
 * Pass `--json` for the raw `tools/list` payload, `--schemas` to include the
 * output schemas too.
 */
import { loadExternalHandlers, TOOLS, unimplementedToolNames } from '../mcp/src/registry.js';
import { describeTool } from '../mcp/src/server.js';

const EXPECTED = [
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

async function main(): Promise<void> {
  const report = await loadExternalHandlers();
  const described = TOOLS.map(describeTool);
  const args = new Set(process.argv.slice(2));

  if (args.has('--json')) {
    process.stdout.write(JSON.stringify({ tools: described }, null, 2) + '\n');
    return;
  }

  const missing = new Set(unimplementedToolNames());

  process.stdout.write(`x-agent MCP tools: ${described.length}\n`);
  process.stdout.write('='.repeat(78) + '\n\n');

  for (const t of described) {
    const name = String(t.name);
    const flag = missing.has(name) ? '  [handler pending: returns {code:"not_implemented"}]' : '';
    process.stdout.write(`${name}${flag}\n`);
    process.stdout.write(`  title: ${String(t.title)}\n`);
    process.stdout.write(`  input schema:\n`);
    process.stdout.write(indent(JSON.stringify(t.inputSchema, null, 2), 4) + '\n');
    if (args.has('--schemas')) {
      process.stdout.write(`  output schema:\n`);
      process.stdout.write(indent(JSON.stringify(t.outputSchema, null, 2), 4) + '\n');
    }
    process.stdout.write('\n');
  }

  const names = described.map((t) => String(t.name));
  const absent = EXPECTED.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !EXPECTED.includes(n));

  process.stdout.write('-'.repeat(78) + '\n');
  process.stdout.write(`declared: ${names.length}  expected: ${EXPECTED.length}\n`);
  process.stdout.write(`handlers loaded from external modules: ${report.loaded.length ? report.loaded.join(', ') : '(none)'}\n`);
  process.stdout.write(`handlers pending: ${missing.size ? [...missing].join(', ') : '(none)'}\n`);
  if (report.failed.length) process.stdout.write(`modules that failed to load: ${report.failed.map((f) => f.module).join(', ')}\n`);
  if (absent.length) {
    process.stderr.write(`MISSING TOOLS: ${absent.join(', ')}\n`);
    process.exitCode = 1;
  }
  if (extra.length) process.stdout.write(`additional tools beyond the 16: ${extra.join(', ')}\n`);
  if (!absent.length) process.stdout.write('OK: all 16 tools listed with input schemas.\n');
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n);
  return s
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

void main();
