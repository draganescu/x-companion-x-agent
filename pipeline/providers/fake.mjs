// Fixture-replay provider for deterministic tests (spec: pipeline/providers/fake.mjs).
// Keyed by task_type + label — wpforge's dryModel label trick — because payload
// hashes vary with instance fingerprints while labels are stable across runs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineError } from '../lib/errors.mjs';

const DEFAULT_DIR = fileURLToPath(new URL('../fixtures/fake', import.meta.url));

export function create({ options = {} } = {}) {
    const dir = options.fixtures_dir ?? DEFAULT_DIR;
    return {
        id: 'fake',
        async complete(taskType, _prompt, _payload, { label }) {
            const file = join(dir, `${taskType}.${String(label).replaceAll('/', '-')}.json`);
            let raw;
            try {
                raw = readFileSync(file, 'utf8');
            } catch {
                throw new PipelineError('fixture_missing', `no fixture for ${taskType}:${label} at ${file}`,
                    'Add the fixture or route this task to a real provider.');
            }
            const { text, usage } = JSON.parse(raw);
            return { text, usage: usage ?? { input_tokens: 0, output_tokens: 0 } };
        },
    };
}
