import { PipelineError } from '../lib/errors.mjs';

export const id = 'S6_schema_packages';
export const kind = 'gated-generative';

export async function run() {
    throw new PipelineError('not_implemented', 'stage S6_schema_packages arrives with its milestone task');
}
