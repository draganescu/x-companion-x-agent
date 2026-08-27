import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright';
import { collectSurfaces, extractLayout, samplePendingGrounds } from '../mcp/src/oracle.js';

// This test resolves 'playwright' from a different node_modules than the mcp
// package does; the Page types are structurally identical for everything the
// oracle touches, so cast at the boundary.
type OraclePage = Parameters<typeof extractLayout>[0];
const oraclePage = (p: Page): OraclePage => p as unknown as OraclePage;

const browser: Browser | null = await chromium.launch().catch(() => null);

let server: Server | null = null;
let base = '';
let darkNoise: Buffer | null = null;
let lightNoise: Buffer | null = null;

/** Deterministic "noise": a checkerboard of two tones — busy enough that no
 *  flat-color reading could rate it, controlled enough to assert against. */
async function checkerPng(a: string, b: string): Promise<Buffer> {
  const page = await browser!.newPage();
  try {
    await page.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; };').catch(() => {});
    const b64 = await page.evaluate(
      ({ ca, cb }: { ca: string; cb: string }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const g = canvas.getContext('2d')!;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            g.fillStyle = (x + y) % 2 === 0 ? ca : cb;
            g.fillRect(x * 8, y * 8, 8, 8);
          }
        }
        const u = canvas.toDataURL('image/png');
        return u.slice(u.indexOf(',') + 1);
      },
      { ca: a, cb: b },
    );
    return Buffer.from(b64, 'base64');
  } finally {
    await page.close();
  }
}

beforeAll(async () => {
  if (!browser) return;
  darkNoise = await checkerPng('#1a1d21', '#3a2e24');
  lightNoise = await checkerPng('#f4efe6', '#e8e2d4');
  server = createServer((req, res) => {
    if (req.url === '/dark.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(darkNoise);
    } else if (req.url === '/light.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(lightNoise);
    } else {
      res.writeHead(404);
      res.end('gone');
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

async function fixturePage(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`
    <body style="margin:0">
      <div style="background-image:url(${base}/dark.png); width: 400px; height: 120px; padding: 10px;">
        <p id="unreadable" style="color: rgb(80, 80, 80); font-size: 20px; margin: 0;">Body text over dark noise</p>
      </div>
      <div style="background-image:url(${base}/light.png); width: 400px; height: 120px; padding: 10px;">
        <p id="readable" style="color: rgb(17, 17, 17); font-size: 20px; margin: 0;">Body text over the veiled light ground</p>
      </div>
      <div style="background-image:url(${base}/missing.png); width: 400px; height: 40px;"></div>
      <div style="background-color: rgb(240, 240, 240); width: 400px; padding: 10px;">
        <p style="color: rgb(200, 200, 200); margin: 0;">Flat lane still measured</p>
      </div>
    </body>`);
  await page.waitForLoadState('networkidle');
  return page;
}

describe.skipIf(!browser)('the pixel oracle', () => {
  it('text over imagery is PENDING, not skipped; the flat lane is unchanged', async () => {
    const page = await fixturePage();
    try {
      const extracted = await extractLayout(oraclePage(page), {});
      expect(extracted.pending_grounds.length).toBe(2);
      expect(extracted.pending_grounds[0]!.sample).toContain('dark noise');
      // The flat low-contrast paragraph still reports through the flat lane.
      expect(extracted.text_contrast.some((f) => f.sample.includes('Flat lane'))).toBe(true);
      // Nothing over imagery leaked into the flat findings.
      expect(extracted.text_contrast.some((f) => f.sample.includes('noise'))).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);

  it('samples the rendered ground with the ink hidden: dark noise fails, light ground clears', async () => {
    const page = await fixturePage();
    try {
      const extracted = await extractLayout(oraclePage(page), {});
      const findings = await samplePendingGrounds(oraclePage(page), extracted.pending_grounds);
      const dark = findings.find((f) => f.sample.includes('dark noise'));
      expect(dark).toBeDefined();
      expect(dark!.sampled).toBe(true);
      expect(dark!.ratio).toBeLessThan(3);
      expect(dark!.background).toMatch(/^sampled\(/);
      // The dark ink over the LIGHT ground must NOT be reported: if the glyphs
      // had been sampled as ground, their own dark pixels would fake a failure.
      expect(findings.some((f) => f.sample.includes('veiled light ground'))).toBe(false);
      // The page is restored: the hidden ink is visible again.
      const color = await page.evaluate(() => getComputedStyle(document.querySelector('#unreadable')!).color);
      expect(color).toBe('rgb(80, 80, 80)');
    } finally {
      await page.close();
    }
  }, 30000);

  it('stale extract-time boxes never kill the sampler — the Vienna tea-salon regression', async () => {
    const page = await fixturePage();
    try {
      const extracted = await extractLayout(oraclePage(page), {});
      // Simulate the layout shift eager-loading causes: the handed-in boxes
      // point far outside the page. The sampler re-measures and clamps, so it
      // must neither throw nor lose the finding.
      for (const p of extracted.pending_grounds) {
        p.box = { x: 40, y: 999999, w: 4000, h: 4000 };
      }
      const findings = await samplePendingGrounds(oraclePage(page), extracted.pending_grounds);
      expect(findings.some((f) => f.sample.includes('dark noise'))).toBe(true);
      // A selector that matches nothing is skipped, never a throw.
      const ghost = await samplePendingGrounds(oraclePage(page), [
        { selector_path: 'div.no-such-thing:nth-child(99)', box: { x: 0, y: 0, w: 10, h: 10 }, color: 'rgb(0, 0, 0)', sample: 'ghost' },
      ]);
      expect(ghost).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30000);

  it('probes every rendered background image for presence: 200 ok, 404 is a finding', async () => {
    const page = await fixturePage();
    try {
      const probes = await collectSurfaces(oraclePage(page));
      const byUrl = new Map(probes.map((p) => [p.url, p]));
      expect(byUrl.get(`${base}/dark.png`)?.ok).toBe(true);
      expect(byUrl.get(`${base}/light.png`)?.ok).toBe(true);
      const missing = byUrl.get(`${base}/missing.png`);
      expect(missing?.ok).toBe(false);
      expect(missing?.status).toBe(404);
    } finally {
      await page.close();
    }
  }, 30000);
});
