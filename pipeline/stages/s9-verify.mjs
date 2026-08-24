import { PipelineError } from '../lib/errors.mjs';

export const id = 'S9_verify';
export const kind = 'deterministic';

export async function run() {
    throw new PipelineError('not_implemented', 'stage S9_verify arrives with its milestone task');
}
