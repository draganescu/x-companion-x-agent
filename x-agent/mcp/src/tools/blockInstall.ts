/**
 * `wp_block_install` — `POST /blocks/install` (CONTRACT.md §5), extend tier.
 *
 * THREE THINGS THIS TOOL GUARANTEES
 * ---------------------------------
 * 1. POSTURE FIRST. The posture is read with a cheap, non-mutating
 *    `GET /fingerprint` *before* anything is sent. On a `production` instance
 *    the call fails with `{code:'posture_forbidden'}` and the zip never leaves
 *    the machine. (The companion's own `permission_callback` would refuse it
 *    too, but "refused at the far end" is not the same promise as "never sent".)
 *
 * 2. NOTHING UNVERIFIED GOES OVER THE WIRE. The zip is re-read and checked
 *    against the whole install policy locally first, so a 422 `block_policy` is
 *    never how you find out. Only `wp_block_build_test` produces these zips, and
 *    it only produces one after a real Playground smoke test.
 *
 * 3. THE EPOCH MOVES, SO EVERYTHING MOVES WITH IT. A successful install changes
 *    the block registry, which changes the fingerprint. The manifest is
 *    refreshed immediately and the warm harness session is reloaded onto the new
 *    epoch (via the session provider's `onEpochChange` hook — tolerated when
 *    absent, since the session track is a separate module). The returned
 *    `fingerprint` is the epoch every subsequent TreeIR must carry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { Ctx } from '../context.js';
import { getSession } from '../context.js';
import { errInvalidInput, errPostureForbidden, XError } from '../errors.js';
import { inspectPackage } from '../factory.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';

const InputSchema = z.looseObject({
  ...ConnectionArgsShape,
  zip_path: z.string().describe('Path to the zip produced by wp_block_build_test. No other package is accepted.'),
});

const OutputSchema = z.object({
  installed: z.object({ slug: z.string(), name: z.string(), version: z.string() }),
  fingerprint: z.string().describe('The new epoch. Every TreeIR you compile or validate after this must carry it.'),
  replaced_previous: z.boolean(),
  previous_fingerprint: z.string().optional(),
  manifest_refreshed: z.boolean().optional(),
  session_reloaded: z.boolean().optional(),
});

export const wpBlockInstall = defineTool({
  name: 'wp_block_install',
  title: 'Install a built block onto the instance',
  description:
    'POST /blocks/install with the zip from wp_block_build_test, then refresh the manifest and reload the harness session onto the new epoch. The returned fingerprint is the epoch every subsequent tree must carry. EXTEND TIER: refused with {code:"posture_forbidden"} on production posture — snapshot to a sandbox and install there. The posture is checked before anything is sent, so a production instance receives no request that could mutate it.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});

    const zipPath = path.resolve(args.zip_path);
    if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
      throw errInvalidInput(
        `No package at ${zipPath}.`,
        'Pass the zip_path returned by wp_block_build_test. If that tool returned no zip_path, the block failed its smoke test and must be fixed first.',
        { zip_path: args.zip_path },
      );
    }

    // Local policy check: never spend a request on a package we already know
    // the companion will answer 422 block_policy for.
    const inspection = inspectPackage(zipPath);
    if (!inspection.ok) {
      throw new XError(
        'invalid_input',
        `The package at ${zipPath} violates the install policy: ${inspection.reasons.join('; ')}.`,
        'CONTRACT.md §5 pins the policy. Re-run wp_block_build_test rather than hand-editing a zip.',
        { zip_path: zipPath, reasons: inspection.reasons },
      );
    }

    const live = ctx.runtime.ctx(connectionArgs(input));

    // 1. Posture gate, before a single mutating byte is sent.
    const fp = await live.companion.fetchFingerprint();
    if (fp.posture === 'production') throw errPostureForbidden('/blocks/install');
    const previous = fp.fingerprint;

    // 2. The install itself.
    const res = await live.companion.installBlockFromFile(zipPath);

    // 3. Adopt the new epoch everywhere before returning it.
    let manifestRefreshed = false;
    try {
      await live.manifestCache.get({ refresh: true });
      manifestRefreshed = true;
    } catch (e) {
      live.logger.warn(`installed ${res.installed.name} but could not refresh the manifest: ${(e as Error).message}`);
    }

    // Only reload a session that already exists — never launch a browser as a
    // side effect of installing a block. `getSession` fires the provider's
    // onEpochChange when the fingerprint has moved, which is exactly what a warm
    // harness page needs.
    let sessionReloaded = false;
    if (live.session !== undefined) {
      try {
        await getSession(live);
        sessionReloaded = true;
      } catch (e) {
        live.logger.warn(`installed ${res.installed.name} but the harness session did not reload: ${(e as Error).message}`);
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

export const tools = [wpBlockInstall];
export default wpBlockInstall;
