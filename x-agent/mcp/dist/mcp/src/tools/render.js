import { z } from 'zod';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';
const InputSchema = z.object({
    ...ConnectionArgsShape,
    markup: z.string().describe('Serialized block markup, normally the `markup` field returned by wp_compile.'),
});
const OutputSchema = z.object({
    html: z.string(),
    enqueued_styles: z.array(z.string()).describe('Absolute URLs of stylesheets enqueued during the render; [] when not determinable.'),
});
export const wpRender = defineTool({
    name: 'wp_render',
    title: 'Server-render block markup',
    description: 'POST /render — runs do_blocks() inside a faux main-query guard so dynamic blocks produce their real front-end output. This is the oracle input for dynamic-block output and the source of the stylesheet URLs wp_verify needs. Pass markup produced by wp_compile, never hand-written markup.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    handler: async (input, ctx) => {
        const args = InputSchema.parse(input ?? {});
        const live = ctx.runtime.ctx(connectionArgs(input));
        return live.companion.render(args.markup);
    },
});
export const tools = [wpRender];
//# sourceMappingURL=render.js.map