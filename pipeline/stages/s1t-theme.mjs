// S1T_theme — the ground becomes an artifact (specs/theme-factory.spec.json).
//
// Bespoke runs only: one metered `theme` call authors a ThemeSpec (a parameter
// object, never files), the deterministic scaffolder compiles it, a throwaway
// sandbox MEASURES its physics, and the theme installs + activates BEFORE S2
// reads the instance — so the manifest, R9's pass-through, the ink menus and
// every downstream gate operate on the bespoke world with zero special cases.
//
// The repair economy is S7's, at preflight depth: a ThemeSpec that fails its
// contract gets the one schema-retry (maxAttempts 2); a theme that fails the
// build gate gets ONE repair of its SPEC (never its files), recompiled whole;
// a second failure aborts the run — there is no site to build without its
// ground. The pipeline never improvises a theme.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';
import { validateSchema } from '../lib/schema.mjs';
import { themeSpecChecks } from '../lib/theme-spec.mjs';
import { renderStyleNote } from '../lib/styles.mjs';
import { SKELETON_VOCABULARY } from '../lib/skeleton.mjs';

const contract = JSON.parse(readFileSync(new URL('../../contract/schemas/theme-spec.schema.json', import.meta.url), 'utf8'));

export const id = 'S1T_theme';
export const kind = 'gated-generative';

function repairNote(prevSpec, failure, measured) {
    return [
        '',
        'REPAIR — your previous ThemeSpec compiled into a theme that FAILED its build gate. Repair the SPEC (the files are never yours): keep every choice that was not implicated, change exactly what the diagnostics demand, and return the whole corrected ThemeSpec.',
        `The failing spec:\n${JSON.stringify(prevSpec, null, 2)}`,
        `The verbatim diagnostics:\n${JSON.stringify({ failure, measured: measured ?? null }, null, 2)}`,
    ].join('\n');
}

async function toolOrPreflight(ctx, name, args, doing) {
    const res = await ctx.call(name, args);
    if (!res.ok) {
        throw new PipelineError('preflight_failed', `no ground, no site: ${doing} failed — ${res.data.message ?? res.data.code}`,
            res.data.hint ?? '', { tool: name, ...res.data });
    }
    return res.data;
}

export async function run(ctx) {
    if (ctx.state.bespoke !== true) {
        ctx.log("inherited theme — the instance's own theme remains the law");
        return;
    }

    const brief = ctx.state.brief;
    const payload = {
        identity_note: JSON.stringify({ identity: brief.identity, art_direction: brief.art_direction }, null, 2),
        pages_note: brief.pages.map((p) => `- ${p.title}: ${p.sections.map((s) => s.role).join(', ')}`).join('\n'),
        combo_note: renderStyleNote(brief.style),
        skeleton_vocabulary: SKELETON_VOCABULARY,
        contract_note: { note: 'Your output must validate against this JSON Schema (theme-spec.schema.json):', schema: contract },
        repair_note: '',
    };
    const validate = (v) => [...validateSchema(contract, v), ...themeSpecChecks(v)];

    // One metered call fixes the ground (its schema-retry is the default
    // maxAttempts 2). The 2x ceiling headroom covers the one spec repair.
    let { value: spec } = await ctx.llm.generate({ task_type: 'theme', label: 'theme', payload, validate });

    const compile = async (theSpec) => {
        const scaffold = await toolOrPreflight(ctx, 'wp_theme_scaffold',
            { spec: theSpec, dir: join(ctx.runDir, 'theme'), force: true }, 'the theme scaffold');
        const build = await toolOrPreflight(ctx, 'wp_theme_build_test', { dir: scaffold.dir }, 'the theme sandbox');
        return { scaffold, build };
    };

    let { scaffold, build } = await compile(spec);
    if (build.built !== true) {
        ctx.log(`the theme failed its build gate (${build.failure?.message ?? 'no diagnostics'}) — one spec repair, then the run has no ground`);
        ({ value: spec } = await ctx.llm.generate({
            task_type: 'theme',
            label: 'theme/repair',
            maxAttempts: 1,
            payload: { ...payload, repair_note: repairNote(spec, build.failure, build.measured) },
            validate,
        }));
        ({ scaffold, build } = await compile(spec));
        if (build.built !== true) {
            throw new PipelineError('preflight_failed',
                'no ground, no site: the bespoke theme failed its build gate twice',
                'The ThemeSpec and its repair both compiled into a theme the sandbox refused. Read the diagnostics; the run aborts at preflight depth rather than improvise a theme.',
                { failure: build.failure, measured: build.measured ?? null });
        }
    }

    const install = await toolOrPreflight(ctx, 'wp_theme_install', { zip_path: build.zip_path }, 'the theme install');

    // The rail skeleton declares a third furniture part: F goes 2 -> 3 and the
    // ceiling is re-issued (the --no-images post-hoc precedent, bounded to +1).
    // Idempotent across a resume that somehow re-enters: F is set, not added.
    if (spec.skeleton === 'rail' && ctx.state.budget) {
        const plan = ctx.state.budget;
        if (plan.F !== 3) {
            plan.F = 3;
            plan.base += 1;
            plan.ceiling = 2 * plan.base + plan.I;
            ctx.budget.setCeiling(plan.ceiling);
            ctx.log(`the skeleton declares a rail: F=3, the ceiling is now ${plan.ceiling}`);
        }
    }

    writeFileSync(join(ctx.runDir, 'theme', 'theme-spec.json'), JSON.stringify(spec, null, 2));
    ctx.state.theme = {
        slug: install.installed.slug,
        name: install.installed.name,
        skeleton: spec.skeleton,
        measure: spec.measure,
        ...(scaffold.rail_width ? { rail_width: scaffold.rail_width } : {}),
        fingerprint: install.fingerprint,
        zip: build.zip_path,
    };
    ctx.state.fingerprint = install.fingerprint;
    ctx.log(`the ground is bespoke: "${install.installed.name}" (${spec.skeleton}) at ${spec.measure.contentSize}/${spec.measure.wideSize} — fingerprint ${install.fingerprint.slice(0, 8)}`);
}
