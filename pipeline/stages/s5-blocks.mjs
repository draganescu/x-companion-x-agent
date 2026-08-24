import { PipelineError } from '../lib/errors.mjs';

export const id = 'S5_blocks';
export const kind = 'gated-generative';

export async function run(ctx) {
    ctx.state.artifacts = ctx.state.artifacts ?? {};
    ctx.state.artifacts.blocks = ctx.state.artifacts.blocks ?? {};
    const blocks = ctx.state.brief.custom_blocks ?? [];
    if (blocks.length === 0) {
        ctx.log('S5: no custom blocks declared');
        return;
    }
    throw new PipelineError('not_implemented', 'stage S5_blocks arrives with its milestone task (M4)');
}
