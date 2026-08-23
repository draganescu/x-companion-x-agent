/**
 * Shared plumbing for CORE tool modules. Session-track modules may import this
 * too — nothing here is private.
 */
import { z } from 'zod';
/** Connection arguments accepted by every tool (config chain: args win). */
export const ConnectionArgsShape = {
    url: z.string().optional().describe('Site URL override. Falls back to .x-agent.json then X_WP_URL.'),
    user: z.string().optional().describe('WordPress user override. Falls back to .x-agent.json then X_WP_USER.'),
    app_password: z
        .string()
        .optional()
        .describe('WordPress Application Password override. Never logged or echoed. Falls back to .x-agent.json then X_WP_APP_PASSWORD.'),
};
export const ConnectionArgsSchema = z.object(ConnectionArgsShape);
export function connectionArgs(input) {
    const parsed = ConnectionArgsSchema.safeParse(input ?? {});
    return parsed.success ? parsed.data : {};
}
export function defineTool(def) {
    return def;
}
//# sourceMappingURL=_shared.js.map