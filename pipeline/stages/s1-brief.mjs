import { PipelineError } from '../lib/errors.mjs';

export const id = 'S1_brief';
export const kind = 'generative';

export async function run() {
    throw new PipelineError('not_implemented', 'stage S1_brief arrives with its milestone task');
}
