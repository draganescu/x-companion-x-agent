/**
 * `wp_theme_install` — `POST /themes/install`, extend tier
 * (specs/theme-factory.spec.json: the ONE companion surface that spec adds).
 *
 * The same three guarantees as wp_block_install:
 * 1. POSTURE FIRST — a cheap GET /fingerprint before anything mutating is
 *    sent; production refuses with {code:'posture_forbidden'} and the zip
 *    never leaves the machine.
 * 2. NOTHING UNVERIFIED OVER THE WIRE — the zip is re-inspected against the
 *    theme install policy locally; only wp_theme_build_test produces these
 *    zips, and only after measured physics.
 * 3. THE EPOCH MOVES — activation changes theme{slug,version} and the global
 *    styles world, so the fingerprint moves. One theme-shaped difference: the
 *    route's own fingerprint is best-effort (a theme's init-time registrations
 *    exist only from the next request), so the fingerprint returned HERE is
 *    the one read back from the refreshed manifest — the steady-state epoch
 *    every subsequent tree must carry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { Ctx } from '../context.js';
import { getSession } from '../context.js';
import { errInvalidInput, errPostureForbidden, XError } from '../errors.js';
import { inspectThemePackage } from '../themeFactory.js';
import { ConnectionArgsShape, connectionArgs, defineTool } from './_shared.js';

const InputSchema = z.looseObject({
  ...ConnectionArgsShape,
  zip_path: z.string().describe('Path to the zip produced by wp_theme_build_test. No other package is accepted.'),
});

const OutputSchema = z.object({
  installed: z.object({ slug: z.string(), name: z.string(), version: z.string() }),
  fingerprint: z.string().describe('The steady-state epoch after activation (read from the refreshed manifest). Every tree after this must carry it.'),
  replaced_previous: z.boolean(),
  previous_theme: z.string().optional(),
  previous_fingerprint: z.string().optional(),
  manifest_refreshed: z.boolean().optional(),
  session_reloaded: z.boolean().optional(),
});

export const wpThemeInstall = defineTool({
  name: 'wp_theme_install',
  title: 'Install and activate a built bespoke theme',
  description:
    'POST /themes/install with the zip from wp_theme_build_test, activate it, then refresh the manifest and reload the harness session onto the new epoch. Activation moves the epoch: the fingerprint returned is the steady-state one the refreshed manifest serves. EXTEND TIER: refused with {code:"posture_forbidden"} on production posture. The theme is DELIVERABLE — named, versioned, deletable from wp-admin; nothing ever removes it at run end.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: unknown, ctx: Ctx) => {
    const args = InputSchema.parse(input ?? {});

    const zipPath = path.resolve(args.zip_path);
    if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
      throw errInvalidInput(
        `No package at ${zipPath}.`,
        'Pass the zip_path returned by wp_theme_build_test. If that tool returned no zip_path, the theme failed its gate and its ThemeSpec must be repaired first.',
        { zip_path: args.zip_path },
      );
    }

    const inspection = inspectThemePackage(zipPath);
    if (!inspection.ok) {
      throw new XError(
        'invalid_input',
        `The theme package at ${zipPath} violates the install policy: ${inspection.reasons.join('; ')}.`,
        'Re-run wp_theme_build_test rather than hand-editing a zip.',
        { zip_path: zipPath, reasons: inspection.reasons },
      );
    }

    const live = ctx.runtime.ctx(connectionArgs(input));

    // 1. Posture gate, before a single mutating byte is sent.
    const fp = await live.companion.fetchFingerprint();
    if (fp.posture === 'production') throw errPostureForbidden('/themes/install');
    const previous = fp.fingerprint;

    // 2. The install itself (the client deliberately does NOT adopt the
    //    response fingerprint — see installThemeFromFile).
    const res = await live.companion.installThemeFromFile(zipPath);

    // 3. Adopt the steady-state epoch: the refreshed manifest is authoritative.
    let manifestRefreshed = false;
    let fingerprint = res.fingerprint;
    try {
      const manifest = await live.manifestCache.get({ refresh: true });
      fingerprint = manifest.fingerprint;
      manifestRefreshed = true;
    } catch (e) {
      live.logger.warn(`installed theme ${res.installed.slug} but could not refresh the manifest: ${(e as Error).message}`);
    }

    let sessionReloaded = false;
    if (live.session !== undefined) {
      try {
        await getSession(live);
        sessionReloaded = true;
      } catch (e) {
        live.logger.warn(`installed theme ${res.installed.slug} but the harness session did not reload: ${(e as Error).message}`);
      }
    }

    const out: Record<string, unknown> = {
      installed: res.installed,
      fingerprint,
      replaced_previous: res.replaced_previous === true,
      previous_fingerprint: previous,
      manifest_refreshed: manifestRefreshed,
      session_reloaded: sessionReloaded,
    };
    if (res.previous_theme) out.previous_theme = res.previous_theme;
    return out;
  },
});

export const tools = [wpThemeInstall];
export default wpThemeInstall;
