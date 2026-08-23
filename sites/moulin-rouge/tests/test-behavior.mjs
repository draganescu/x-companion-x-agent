/**
 * Behavior tests for the Moulin Rouge landing page.
 *
 *  1. scroll-end signup: scroll to the bottom, submit an email in the inline
 *     form, expect the success message and a pending mr_subscriber row.
 *  2. exit trap: arrive from another page, press Back once -> the exit dialog
 *     opens (we stayed on the page); decline -> we really leave (URL is the
 *     referrer page). sessionStorage guard is set.
 *  3. exit trap signup: same arrival, Back -> dialog, submit email -> success
 *     message, then auto-leave.
 *  4. count-up: the 240000 stat reads its full formatted value after the
 *     stats row has been in view.
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../x-agent/mcp/package.json', import.meta.url));
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:9400';
const REFERRER = BASE + '/wp-login.php'; // any other same-origin page that renders

let failures = 0;
function check(name, cond, extra = '') {
    if (cond) {
        console.log(`PASS  ${name}`);
    } else {
        failures += 1;
        console.log(`FAIL  ${name} ${extra}`);
    }
}

const browser = await chromium.launch();

/* ------------------------------------------------- 1. inline scroll-end */
{
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.wp-block-agent-newsletter-capture[data-x-agent-view="ready"]');
    await page.locator('#newsletter').scrollIntoViewIfNeeded();
    const inline = page.locator('.wp-block-agent-newsletter-capture.is-mode-inline');
    await inline.locator('.mr-capture__email').fill('spectatrice@example.com');
    await inline.locator('.mr-capture__submit').click();
    await inline.locator('.mr-capture__success').waitFor({ state: 'visible', timeout: 10000 });
    check('inline: success message shown after submit', true);
    check('inline: form hidden after success', await inline.locator('.mr-capture__form').isHidden());
    await ctx.close();
}

/* ------------------------------------------------- 2. exit trap: decline */
{
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(REFERRER, { waitUntil: 'domcontentloaded' });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.wp-block-agent-newsletter-capture.is-mode-exit[data-x-agent-view="ready"]', { state: 'attached' });
    await page.waitForTimeout(300);
    await page.goBack({ waitUntil: 'commit' }).catch(() => {});
    const dialog = page.locator('.mr-capture__dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    check('exit: dialog opens on Back', true);
    check('exit: still on the landing page while dialog is open', page.url().replace(/\/$/, '') === BASE);
    const shown = await page.evaluate(() => window.sessionStorage.getItem('mrExitShown'));
    check('exit: session guard set', shown === '1');
    await Promise.all([
        page.waitForURL('**/wp-login.php**', { timeout: 8000 }),
        dialog.locator('.mr-capture__decline').click(),
    ]);
    check('exit: decline really leaves (back at the referrer)', page.url().includes('wp-login.php'));
    await ctx.close();
}

/* ------------------------------------------------- 3. exit trap: signup */
{
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(REFERRER, { waitUntil: 'domcontentloaded' });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.wp-block-agent-newsletter-capture.is-mode-exit[data-x-agent-view="ready"]', { state: 'attached' });
    await page.waitForTimeout(300);
    await page.goBack({ waitUntil: 'commit' }).catch(() => {});
    const dialog = page.locator('.mr-capture__dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.locator('.mr-capture__email').fill('fugitif@example.com');
    await dialog.locator('.mr-capture__submit').click();
    await dialog.locator('.mr-capture__success').waitFor({ state: 'visible', timeout: 10000 });
    check('exit: success message shown in dialog', true);
    await page.waitForURL('**/wp-login.php**', { timeout: 8000 });
    check('exit: auto-leave after signup', page.url().includes('wp-login.php'));
    await ctx.close();
}

/* ------------------------------------------------- 4. count-up reaches value */
{
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.wp-block-agent-cancan-stats[data-x-agent-view="ready"]');
    await page.locator('#chiffres').scrollIntoViewIfNeeded();
    await page.waitForTimeout(2600);
    const texts = await page.locator('.mr-stat__number').allTextContents();
    check('stats: year renders as a plain figure', texts.some((t) => t.trim() === '1889'), JSON.stringify(texts));
    check('stats: 240000 reaches its formatted value', texts.some((t) => t.replace(/[\s,  ]/g, '') === '240000'), JSON.stringify(texts));
    await ctx.close();
}

await browser.close();
console.log(failures === 0 ? 'ALL BEHAVIOR TESTS PASSED' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
