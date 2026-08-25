import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { screenOutline } from '../lib/gates.mjs';

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
    for (const img of verify.images ?? []) {
        if (img.loaded !== true || img.natural_w === 0) {
            failures.push({ code: 'image', message: `image not loaded: ${img.selector_path} (loaded=${img.loaded}, natural ${img.natural_w}x${img.natural_h})` });
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
