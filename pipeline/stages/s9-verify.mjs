import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { screenOutline } from '../lib/gates.mjs';

export const id = 'S9_verify';
export const kind = 'deterministic';

export async function run(ctx) {
    const front = ctx.state.published.pages.find((p) => p.front_page);
    const url = front.link;

    // Single-PHP-worker sandboxes never reach network idle — domcontentloaded.
    const res = await ctx.call('wp_verify', { url, wait: 'domcontentloaded', nav_timeout_ms: 120000 });
    if (!res.ok) {
        throw new PipelineError(res.data.code ?? 'companion_error', `wp_verify failed: ${res.data.message}`, res.data.hint ?? '');
    }
    const verify = res.data;
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
    ctx.log(`S9: verified ${url} — outline sane, ${(verify.images ?? []).length} image(s) loaded, screenshot taken`);
}
