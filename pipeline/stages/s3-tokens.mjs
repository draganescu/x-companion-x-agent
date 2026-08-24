import { PipelineError } from '../lib/errors.mjs';

export const id = 'S3_tokens';
export const kind = 'generative';

export async function run() {
    throw new PipelineError('not_implemented', 'stage S3_tokens arrives with its milestone task');
}
