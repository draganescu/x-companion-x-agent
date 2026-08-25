#!/usr/bin/env node
// CLI entry: node pipeline/run.mjs "<prompt>" [--config pipeline.config.json]
//            [--resume <run_dir>] [--until <STAGE_ID>]
// Prints the budget after stage S1 and refuses to continue past it (spec file_layout).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPipelineConfig, readProviderKeys } from './lib/config.mjs';
import { createProviders } from './providers/index.mjs';
import { createLlm } from './lib/llm.mjs';
import { createToolchain } from './lib/toolchain.mjs';
import { BudgetMeter, Ledger } from './budget.mjs';
import { writeReport } from './lib/report.mjs';
import { fmtClock, fmtDur } from './lib/clock.mjs';
import * as s1 from './stages/s1-brief.mjs';
import * as s2 from './stages/s2-read-instance.mjs';
import * as s3 from './stages/s3-tokens.mjs';
import * as s4 from './stages/s4-sections.mjs';
import * as s5 from './stages/s5-blocks.mjs';
import * as s6 from './stages/s6-schema-packages.mjs';
import * as s7 from './stages/s7-repair.mjs';
import * as s8 from './stages/s8-publish.mjs';
import * as s9 from './stages/s9-verify.mjs';

const DEFAULT_STAGES = [s1, s2, s3, s4, s5, s6, s7, s8, s9];

// What each stage means in the user's terms. Stage ids (S1_brief…) stay the
// vocabulary of state.json, --until and the spec; the log speaks plainly.
const STAGE_INFO = {
    S1_brief: { title: 'Planning the site', doing: 'one model call turns your prompt into the full plan — pages, sections, custom blocks, data model — and fixes the call budget' },
    S2_read_instance: { title: 'Reading the site', doing: 'listing the blocks, patterns and theme settings the connected WordPress actually has' },
    S3_tokens: { title: 'Designing the look', doing: 'palette, typography and spacing derived from the plan and applied to the theme' },
    S4_sections: { title: 'Writing the sections', doing: 'one model call per section, in parallel; every result is validated against the site before it may ship' },
    S5_blocks: { title: 'Building custom blocks', doing: 'scaffold, model-written code, then a build and smoke test in a throwaway WordPress — the site is untouched' },
    S6_schema_packages: { title: 'Building the data model', doing: 'post types, fields and REST routes, proven (install, probe, clean uninstall) in a throwaway WordPress' },
    S7_repair: { title: 'Repairing failures', doing: 'anything that failed its gate gets exactly one repair attempt; a second failure is substituted, never improvised' },
    S8_publish: { title: 'Publishing', doing: 'installing what was built, compiling pages with the site\'s own editor code, publishing, generating images' },
    S9_verify: { title: 'Verifying', doing: 'measuring the live front page and taking the one screenshot' },
};

function timestamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function runPipeline({ prompt, configPath, resumeDir, until, cwd = process.cwd(), stages = DEFAULT_STAGES, skipToolchain = false }) {
    const config = loadPipelineConfig(configPath ?? join(cwd, 'pipeline.config.json'));
    const keys = readProviderKeys(cwd);
    const providers = await createProviders({ config, keys });

    const runDir = resumeDir ?? join(cwd, 'runs', timestamp());
    for (const d of ['', 'trees', 'blocks', 'packages', 'images', 'sections', 'pages']) {
        mkdirSync(join(runDir, d), { recursive: true });
    }
    const statePath = join(runDir, 'state.json');
    const state = resumeDir && existsSync(statePath)
        ? JSON.parse(readFileSync(statePath, 'utf8'))
        : { completed: [] };
    delete state.failure; // a resumed run gets a fresh verdict
    if (prompt) state.prompt = prompt;
    else prompt = state.prompt ?? '';

    const startedRun = Date.now();
    const log = (m) => console.error(`[x-pipeline +${fmtClock(Date.now() - startedRun)}] ${m}`);
    const budget = new BudgetMeter({ hard_cap: config.budget_hard_cap });
    if (state.budget) budget.setCeiling(state.budget.ceiling); // resume: the ceiling is already fixed
    const ledger = new Ledger(runDir); // appends to an existing ledger.jsonl, never rewrites
    // The ceiling was fixed for the whole run, so the spend has to carry across
    // resumes with it — otherwise a resumed run gets a fresh allowance and the
    // report understates what the bill actually was.
    if (ledger.entries.length > 0) {
        budget.rehydrate(ledger.entries);
        log(`resume: ${ledger.entries.length} prior call(s) carried over from the ledger`);
    }
    const toolchain = skipToolchain ? null : await createToolchain({ cwd, providerKeys: keys });
    const ctx = {
        prompt, runDir, config,
        call: toolchain ? toolchain.call : null,
        llm: createLlm({ providers, promptsDir: config.prompts_dir, budget, ledger, log }),
        budget, ledger, state, log,
    };

    // A silently-drained event loop must never masquerade as success: hold a
    // keepalive handle for the whole run and flag any drain loudly.
    const keepalive = setInterval(() => {}, 60_000);
    const drained = () => log('BUG: the event loop drained mid-run (an unsettled promise lost its last handle)');
    process.on('beforeExit', drained);
    try {
        for (const [i, stage] of stages.entries()) {
            const info = STAGE_INFO[stage.id] ?? { title: stage.id, doing: '' };
            const step = `[${i + 1}/${stages.length}]`;
            if (state.completed.includes(stage.id)) {
                log(`${step} ${info.title} — already done in this run's artifacts, skipping (resume)`);
                continue;
            }
            log(`${step} ${info.title}${info.doing ? ` — ${info.doing}` : ''}`);
            const startedStage = Date.now();
            await stage.run(ctx);
            state.completed.push(stage.id);
            writeFileSync(statePath, JSON.stringify(state, null, 2));
            log(`${step} ${info.title} — done in ${fmtDur(Date.now() - startedStage)}`);
            if (until && stage.id === until) break;
        }
        return { runDir, state, ms: Date.now() - startedRun };
    } catch (e) {
        state.failure = { code: e.code ?? 'internal', message: e.message, hint: e.hint ?? '' };
        writeFileSync(statePath, JSON.stringify(state, null, 2));
        throw e;
    } finally {
        clearInterval(keepalive);
        process.removeListener('beforeExit', drained);
        ledger.flush();
        writeReport(runDir, { state, budget, ledger });
        if (toolchain) await toolchain.dispose();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const opts = { prompt: undefined, configPath: undefined, resumeDir: undefined, until: undefined };
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--config') opts.configPath = args[++i];
        else if (args[i] === '--resume') opts.resumeDir = args[++i];
        else if (args[i] === '--until') opts.until = args[++i];
        else if (opts.prompt === undefined) opts.prompt = args[i];
    }
    if (!opts.prompt && !opts.resumeDir) {
        console.error('usage: node pipeline/run.mjs "<prompt>" [--config pipeline.config.json] [--resume <run_dir>] [--until <STAGE_ID>]');
        process.exit(2);
    }
    if (!opts.prompt && opts.resumeDir) {
        const st = JSON.parse(readFileSync(join(opts.resumeDir, 'state.json'), 'utf8'));
        opts.prompt = st.prompt ?? '';
    }
    runPipeline(opts).then(({ runDir, ms }) => {
        console.error(`[x-pipeline] done in ${fmtDur(ms)} — artifacts in ${runDir}`);
    }).catch((e) => {
        console.error(JSON.stringify({ code: e.code ?? 'internal', message: e.message, hint: e.hint ?? '' }, null, 2));
        process.exit(1);
    });
}
