import { PipelineError } from '../lib/errors.mjs';

export const id = 'S7_repair';
export const kind = 'generative';

export async function run() {
    throw new PipelineError('not_implemented', 'stage S7_repair arrives with its milestone task');
}
