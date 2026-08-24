import { PipelineError } from '../lib/errors.mjs';

export const id = 'S8_publish';
export const kind = 'deterministic';

export async function run() {
    throw new PipelineError('not_implemented', 'stage S8_publish arrives with its milestone task');
}
