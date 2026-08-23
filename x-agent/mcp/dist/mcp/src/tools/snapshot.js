import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errPostureForbidden } from '../errors.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';
const InputSchema = z.object({
    ...ConnectionArgsShape,
    out_path: z
        .string()
        .optional()
        .describe('Destination .zip path. Defaults to a timestamped file under the OS temp dir.'),
});
const OutputSchema = z.object({
    zip_path: z.string(),
    bytes: z.number(),
    fingerprint: z.string(),
    site_url: z.string(),
});
export const wpSnapshot = defineTool({
    name: 'wp_snapshot',
    title: 'Export an instance snapshot bundle',
    description: 'POST /snapshot/export streamed to disk: theme/, agent-blocks/, patterns.json, content.xml (WXR), manifest.json. This is the clone-to-sandbox and promotion-gate primitive — compare the manifest.json fingerprint inside the zip against a target instance GET /fingerprint. EXTEND TIER: refused with {code:"posture_forbidden"} on production posture.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    handler: async (input, ctx) => {
        const args = InputSchema.parse(input ?? {});
        const live = ctx.runtime.ctx(connectionArgs(input));
        const fp = await live.companion.fetchFingerprint();
        if (fp.posture === 'production')
            throw errPostureForbidden('/snapshot/export');
        const dest = args.out_path ??
            path.join(os.tmpdir(), `x-agent-snapshot-${fp.fingerprint.slice(0, 12)}-${Date.now()}.zip`);
        fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
        const res = await live.companion.snapshotExport(path.resolve(dest));
        return {
            zip_path: res.zip_path,
            bytes: res.bytes,
            fingerprint: fp.fingerprint,
            site_url: live.config.site_url,
        };
    },
});
export const tools = [wpSnapshot];
//# sourceMappingURL=snapshot.js.map