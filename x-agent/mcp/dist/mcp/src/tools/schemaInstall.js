/**
 * `wp_schema_install` — `POST /schema/install`, extend tier, interfaces v2.
 *
 * Mirrors wp_block_install's three guarantees: posture is checked with a
 * cheap read BEFORE any mutating byte is sent; only wp_schema_build_test
 * zips are accepted (they exist only after a green gate); and a successful
 * install moves the epoch, so the manifest is refreshed and a warm harness
 * session is reloaded before the new fingerprint is returned.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getSession } from '../context.js';
import { errInvalidInput, errPostureForbidden } from '../errors.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';
const InputSchema = z.object({
    ...ConnectionArgsShape,
    zip_path: z.string().describe('Path to the zip produced by wp_schema_build_test.'),
});
const OutputSchema = z.object({
    installed: z.object({ slug: z.string(), version: z.string() }),
    fingerprint: z.string(),
    replaced_previous: z.boolean(),
    previous_fingerprint: z.string(),
    manifest_refreshed: z.boolean(),
    session_reloaded: z.boolean(),
});
export const wpSchemaInstall = defineTool({
    name: 'wp_schema_install',
    title: 'Install a gated schema package onto the instance',
    description: 'POST /schema/install with the zip from wp_schema_build_test. The package registers its post types, taxonomies, meta, bindings and routes on init from then on; the returned fingerprint is the NEW epoch — the manifest data_model will list the registrations with source "agent", and every subsequent tree must carry the new fingerprint. EXTEND TIER: refused with {code:"posture_forbidden"} on production posture — snapshot to a sandbox and install there.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    handler: async (input, ctx) => {
        const args = InputSchema.parse(input ?? {});
        const zipPath = path.resolve(args.zip_path);
        if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
            throw errInvalidInput(`No package at ${zipPath}.`, 'Pass the zip_path returned by wp_schema_build_test. If it returned no zip_path, the package failed its gate and must be fixed first.', { zip_path: args.zip_path });
        }
        const live = ctx.runtime.ctx(connectionArgs(input));
        const fp = await live.companion.fetchFingerprint();
        if (fp.posture === 'production')
            throw errPostureForbidden('/schema/install');
        const previous = fp.fingerprint;
        const res = await live.companion.installSchemaFromFile(zipPath);
        let manifestRefreshed = false;
        try {
            await live.manifestCache.get({ refresh: true });
            manifestRefreshed = true;
        }
        catch (e) {
            live.logger.warn(`installed schema ${res.installed.slug} but could not refresh the manifest: ${e.message}`);
        }
        let sessionReloaded = false;
        if (live.session !== undefined) {
            try {
                await getSession(live);
                sessionReloaded = true;
            }
            catch (e) {
                live.logger.warn(`installed schema ${res.installed.slug} but the harness session did not reload: ${e.message}`);
            }
        }
        return {
            installed: res.installed,
            fingerprint: res.fingerprint,
            replaced_previous: res.replaced_previous === true,
            previous_fingerprint: previous,
            manifest_refreshed: manifestRefreshed,
            session_reloaded: sessionReloaded,
        };
    },
});
export const tools = [wpSchemaInstall];
//# sourceMappingURL=schemaInstall.js.map