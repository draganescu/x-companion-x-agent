// tf-m3's pipeline driver: a fake-provider bespoke run to S1T against the
// accept instance, from a SCRATCH cwd (its own .x-agent.json — the repo root's
// connection is never touched). Usage:
//   node tf-m3-run.mjs <scratch-cwd> [resume-run-dir]
// Prints RUN_DIR=<path> on success.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = process.argv[2];
const resumeDir = process.argv[3];
if (!scratch) {
    console.error('usage: node tf-m3-run.mjs <scratch-cwd> [resume-run-dir]');
    process.exit(2);
}

const { runPipeline } = await import(join(repo, 'pipeline', 'run.mjs'));
const { runDir } = await runPipeline({
    prompt: 'a cozy neighborhood bakery site',
    configPath: join(scratch, 'pipeline.config.json'),
    ...(resumeDir ? { resumeDir } : {}),
    until: 'S1T_theme',
    bespoke: true,
    cwd: scratch,
});
console.log(`RUN_DIR=${runDir}`);
process.exit(0);
