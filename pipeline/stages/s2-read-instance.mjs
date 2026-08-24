import { PipelineError } from '../lib/errors.mjs';

export const id = 'S2_read_instance';
export const kind = 'deterministic';

export async function run() {
    throw new PipelineError('not_implemented', 'stage S2_read_instance arrives with its milestone task');
}
