import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetMeter, Ledger } from '../budget.mjs';
import { createLlm } from '../lib/llm.mjs';
import { create as createFake } from '../providers/fake.mjs';
import * as s1 from '../stages/s1-brief.mjs';
import { crossChecks } from '../lib/brief-checks.mjs';

const fixtureBrief = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));
const PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));

function makeCtx({ provider }) {
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-s1-'));
    const budget = new BudgetMeter({});
    const ledger = new Ledger(runDir);
    const providers = new Map([['brief', { provider, model: 'fixtures' }]]);
    const logs = [];
    return {
        prompt: 'A one-page bakery site',
        runDir, budget, ledger,
        llm: createLlm({ providers, promptsDir: PROMPTS_DIR, budget, ledger }),
        state: {},
        log: (m) => logs.push(m),
        logs,
    };
}

test('S1 with the fake provider: brief.json written, the fan-out planned, the ceiling NOT yet fixed', async () => {
    const ctx = makeCtx({ provider: createFake({}) });
    await s1.run(ctx);
    assert.ok(existsSync(join(ctx.runDir, 'brief.json')));
    assert.deepEqual(JSON.parse(readFileSync(join(ctx.runDir, 'brief.json'), 'utf8')), fixtureBrief);
    // S, B, P and I come from the brief; M comes from the kit, so the ceiling is
    // fixed one stage later. Announcing a ceiling here would be announcing a guess.
    assert.deepEqual(ctx.state.budget_plan, { S: 3, B: 1, P: 1, I: 2 });
    assert.equal(ctx.state.budget, undefined);
    assert.equal(ctx.budget.ceiling, null);
    assert.ok(ctx.logs.some((l) => /3 section\(s\), 1 custom block\(s\), 1 data package\(s\), 2 image\(s\)/.test(l)));
    assert.ok(ctx.logs.some((l) => /ceiling is fixed once the design kit/.test(l)));
});

test('a cross-check violation burns the one schema-retry, then a clean brief passes', async () => {
    const bad = structuredClone(fixtureBrief);
    bad.navigation.items.push({ label: 'Ghost', page_slug: 'not-a-page' });
    const outputs = [JSON.stringify(bad), JSON.stringify(fixtureBrief)];
    const provider = { id: 'scripted', complete: async () => ({ text: outputs.shift(), usage: { input_tokens: 1, output_tokens: 1 } }) };
    const ctx = makeCtx({ provider });
    await s1.run(ctx);
    assert.equal(ctx.budget.spent, 2);
    assert.deepEqual(ctx.ledger.entries.map((e) => e.outcome), ['schema_failed', 'ok']);
});

test('crossChecks catches each mechanical rule', () => {
    const base = structuredClone(fixtureBrief);
    assert.deepEqual(crossChecks(base), []);

    const noFront = structuredClone(fixtureBrief);
    delete noFront.pages[0].front_page;
    assert.ok(crossChecks(noFront).some((i) => /front_page/.test(i.message)));

    const badBlockRef = structuredClone(fixtureBrief);
    badBlockRef.pages[0].sections[2].uses_custom_block = 'ghost-block';
    assert.ok(crossChecks(badBlockRef).some((i) => /ghost-block/.test(i.message)));

    const dupSection = structuredClone(fixtureBrief);
    dupSection.pages[0].sections[1].id = 'hero';
    assert.ok(crossChecks(dupSection).some((i) => /duplicate section id/.test(i.message)));

    const badFooter = structuredClone(fixtureBrief);
    badFooter.footer.items[0].page_slug = 'gone';
    assert.ok(crossChecks(badFooter).some((i) => /gone/.test(i.message)));
});

test('crossChecks: two accent bands on one page fail; a gallery without array intents fails', () => {
    const twoAccents = structuredClone(fixtureBrief);
    twoAccents.pages[0].sections[0].design.band = 'accent';   // signup already accent
    assert.ok(crossChecks(twoAccents).some((i) => /accent band/.test(i.message)));

    const gallery = structuredClone(fixtureBrief);
    gallery.pages[0].sections[1].role = 'gallery';            // string intent, not array
    assert.ok(crossChecks(gallery).some((i) => /empty frame/.test(i.message)));
});
