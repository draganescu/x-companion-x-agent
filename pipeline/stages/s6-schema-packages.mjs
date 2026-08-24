import { PipelineError } from '../lib/errors.mjs';

export const id = 'S6_schema_packages';
export const kind = 'gated-generative';

export async function run(ctx) {
    ctx.state.artifacts = ctx.state.artifacts ?? {};
    ctx.state.artifacts.packages = ctx.state.artifacts.packages ?? {};
    const packages = ctx.state.brief.schema_packages ?? [];
    if (packages.length === 0) {
        ctx.log('S6: no schema packages declared');
        return;
    }
    throw new PipelineError('not_implemented', 'stage S6_schema_packages arrives with its milestone task (M4)');
}
