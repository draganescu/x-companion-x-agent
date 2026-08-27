// Builds a scratch working directory for a theme-factory accept run: its own
// .x-agent.json (pointing at the accept instance, NEVER the repo root's
// connection) and a pipeline.config.json routing every task to the fake
// provider. Prints the scratch path.
// Usage: node _theme-scratch.mjs <runtime-descriptor.json>
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const descriptorPath = process.argv[2];
if (!descriptorPath) {
    console.error('usage: node _theme-scratch.mjs <runtime.json>');
    process.exit(2);
}
const runtime = JSON.parse(readFileSync(descriptorPath, 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'tf-accept-'));

writeFileSync(join(scratch, '.x-agent.json'), `${JSON.stringify({
    url: runtime.url,
    user: runtime.admin.user,
    app_password: runtime.admin.app_password,
}, null, 4)}\n`, { mode: 0o600 });

const fixturesDir = fileURLToPath(new URL('../../fixtures/fake', import.meta.url));
const tasks = Object.fromEntries(['brief', 'tokens', 'tree', 'block', 'schema', 'repair', 'theme']
    .map((t) => [t, { provider: 'fake', model: 'fixture', options: { fixtures_dir: fixturesDir } }]));
writeFileSync(join(scratch, 'pipeline.config.json'), `${JSON.stringify({ tasks, concurrency: 3, budget_hard_cap: 80 }, null, 4)}\n`);

console.log(scratch);
