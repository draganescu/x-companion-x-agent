import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { screenOutline, screenBandWidths, screenBandSeams, screenTextContrast, screenSurfacePresence } from '../lib/gates.mjs';

export const id = 'S9_verify';
export const kind = 'deterministic';

export async function run(ctx) {
    // Verify the SITE ROOT: page_on_front makes it the front page, and the
    // page's own pretty URL canonical-redirects — a lane that breaks entirely
    // when any plugin notice precedes wp_redirect's headers. The root is what
    // a visitor sees; no redirect stands in front of it.
    const url = `${(ctx.state.instance.site_url ?? '').replace(/\/$/, '')}/`;

    // Verification gets a FRESH browser session. After S8's install-triggered
    // epoch reloads the warm session can be left dead-but-cached (observed:
    // wp_verify pending forever with zero chromium children), and verification
    // should not trust the mutation-heavy session anyway. wp_disconnect
    // disposes it; the next tool call warms a new one. Same Runtime — still
    // the single holder of epoch state.
    await ctx.call('wp_disconnect', {});
    ctx.log(`checking the finished site at ${url} — heading structure, every image loaded (fresh browser session)`);

    // Single-PHP-worker sandboxes never reach network idle — domcontentloaded.
    // And right after S8's mutations the lone worker can abort one navigation,
    // measuring an empty page (0 outline, 0 boxes): that is a transient, not a
    // verdict — retry once after a beat (session-log lesson).
    let verify;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const res = await ctx.call('wp_verify', { url, wait: 'domcontentloaded', nav_timeout_ms: 120000 });
        if (!res.ok) {
            throw new PipelineError(res.data.code ?? 'companion_error', `wp_verify failed: ${res.data.message}`, res.data.hint ?? '');
        }
        verify = res.data;
        const empty = (verify.a11y_outline ?? []).length === 0 && (verify.box_tree ?? []).length === 0;
        if (!empty || attempt === 2) break;
        ctx.log('measured an empty page (a transient right after publishing) — retrying once');
        await new Promise((r) => setTimeout(r, 3000));
    }
    writeFileSync(join(ctx.runDir, 'verify.json'), JSON.stringify(verify, null, 2));

    const failures = [];
    if (verify.pass === false) failures.push({ code: 'verify', message: 'wp_verify pass=false' });
    failures.push(...screenOutline(verify.a11y_outline));
    // The width audit: every top-level band — section roots and both template
    // parts — spans the viewport, and header agrees with footer. This is the
    // Layout Cascade measured in the rendered DOM, where a clamped band shows
    // as a number no markup-level screen can produce.
    failures.push(...screenBandWidths(verify.box_tree, { viewportWidth: verify.measured?.viewport?.width }));
    // …and no daylight between them: the S3 seam reset holds, or the run fails.
    failures.push(...screenBandSeams(verify.box_tree));
    // The measured ink audit: unreadable text (under 3:1 against its actual
    // ground) fails the run whatever layer painted it; the 3–4.5:1 band is
    // logged as advisory, not fatal.
    failures.push(...screenTextContrast(verify.text_contrast));
    const muddy = (verify.text_contrast ?? []).filter((f) => f.ratio >= 3);
    if (muddy.length > 0) {
        ctx.log(`advisory: ${muddy.length} text element(s) read between 3:1 and 4.5:1 — legible but muddy (details in verify.json)`);
    }
    for (const img of verify.images ?? []) {
        if (img.loaded !== true || img.natural_w === 0) {
            failures.push({ code: 'image', message: `image not loaded: ${img.selector_path} (loaded=${img.loaded}, natural ${img.natural_w}x${img.natural_h})` });
        }
    }
    // The surface presence probe: every applied background image resolved —
    // presence for surfaces, as loaded/natural_w is presence for content.
    failures.push(...screenSurfacePresence(verify.surfaces));
    // THE SURFACE RESCUE (one attempt, x-surfaces canon): when everything
    // fatal is pixel-sampled ink over an applied material, the material —
    // not the run — is what failed. The flat band underneath was never
    // touched, so the surfaces come OFF (wp_images_apply strip_surfaces),
    // the page recompiles through save(), and verification runs once more.
    // A page that cannot carry its texture ships today's flat design, loudly.
    const allSampledInk = failures.length > 0
        && failures.every((f) => f.code === 'ink_contrast' && /sampled\(/.test(f.message));
    const manifestPath = join(ctx.runDir, 'images', 'images-manifest.json');
    const front = ctx.state.published?.pages?.find((p) => p.front_page);
    if (allSampledInk && !ctx.state.surface_rescued && front && existsSync(manifestPath)) {
        ctx.state.surface_rescued = true;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const byUrl = new Map((manifest.surfaces ?? []).filter((s) => s.media_url).map((s) => [s.media_url, s.asset_id]));
        // Match each failing text to the applied background above it. The
        // probe's selector paths carry no block classes; strip them from the
        // finding's path so ancestor prefixes compare.
        const bare = (sel) => (sel ?? '').replace(/\.[A-Za-z0-9_-]+(?=:nth-child)/g, '');
        const offenders = new Set();
        for (const f of failures) {
            const sel = bare(f.message.split(' at ').pop());
            for (const probe of verify.surfaces ?? []) {
                if (byUrl.has(probe.url) && sel.startsWith(probe.selector_path)) offenders.add(byUrl.get(probe.url));
            }
        }
        // No surgical match (e.g. a cover, which probes as an <img>): every
        // asset applied to this page comes off — flat and readable beats
        // textured and blind.
        const strip = offenders.size > 0
            ? [...offenders]
            : [...new Set((manifest.surfaces ?? [])
                .filter((s) => s.media_url && (s.targets ?? []).some((t) => t.post_id === front.id))
                .map((s) => s.asset_id))];
        if (strip.length > 0) {
            ctx.state.surface_report = ctx.state.surface_report ?? { assets: [], degraded: [], refusals: [] };
            for (const id of strip) {
                ctx.state.surface_report.degraded.push({ page: front.slug, asset_id: id, reason: 'stripped by the S9 rescue: ink over the material rated under 3:1 in rendered pixels — the flat band ships' });
            }
            ctx.log(`surface rescue: ink over ${strip.join(', ')} rated unreadable — taking the material off /${front.slug}/ and re-verifying (the flat band ships)`);
            const stripped = await ctx.call('wp_images_apply', { post_id: front.id, manifest_path: manifestPath, strip_surfaces: strip });
            if (stripped.ok && stripped.data.all_valid === true) {
                return run(ctx);
            }
            ctx.log(`surface rescue could not strip cleanly (${stripped.ok ? 'compile not all_valid' : stripped.data.message}) — failing the run as measured`);
        }
    }
    if (failures.length > 0) {
        throw new PipelineError('gate_failed', `front page verification failed: ${failures.map((f) => f.message).join(' | ')}`, '', { failures, url });
    }

    // Exactly ONE screenshot in the whole run — terminal evidence, never a loop input.
    if (ctx.state.screenshot_taken) {
        throw new PipelineError('internal', 'a second wp_screenshot was attempted — the run allows exactly one');
    }
    const shot = await ctx.call('wp_screenshot', { url, out_path: join(ctx.runDir, 'screenshot.png'), wait: 'domcontentloaded', nav_timeout_ms: 120000 });
    if (!shot.ok) {
        throw new PipelineError(shot.data.code ?? 'companion_error', `wp_screenshot failed: ${shot.data.message}`);
    }
    ctx.state.screenshot_taken = true;
    ctx.state.verified = { url, headings: (verify.a11y_outline ?? []).length, images: (verify.images ?? []).length };
    ctx.log(`verified ${url} — heading structure sane, ${(verify.images ?? []).length} image(s) all loaded, screenshot saved`);
}
