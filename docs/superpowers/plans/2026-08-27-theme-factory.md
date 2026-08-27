# X Theme Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `specs/theme-factory.spec.json` — on `--bespoke --new-site` runs, one metered LLM call authors a ThemeSpec (a parameter object, never files) and a deterministic scaffolder compiles it into a named, admin-legible block theme that installs and activates BEFORE S2 reads the instance; plus the Font Library lane: Google Fonts fetched agent-side, installed through core `wp/v2/font-families` + `wp/v2/font-faces` REST, served locally — on ANY toolchain run, independent of `--bespoke`.

**Architecture:** A new gated-generative stage `S1T_theme` between S1 and S2 (skipped entirely without `state.bespoke`), backed by three new MCP tools mirroring the block factory (`wp_theme_scaffold` deterministic templating, `wp_theme_build_test` in a throwaway sandbox on its own port, `wp_theme_install` sequential through ONE new companion route `POST /x-companion/v1/themes/install`, extend-tier, posture-gated). The skeleton (`stacked | split | rail`) is dictated once by the ThemeSpec and rides into every S4 payload (the axis precedent) and S9's pane-aware audits. Fonts: `pipeline/lib/fonts.mjs` resolves `source: {provider:'google'}` families, downloads into a hash-pinned agent-side cache, uploads via the S8 rest() lane immediately after `wp_tokens_apply` in S3; S9 fails the run when a sourced family's rendered font-family silently fell back to its stack.

**Tech Stack:** pipeline: plain ESM `.mjs`, `node:test`, in-repo draft-07 subset validator, no new npm deps (fonts via global `fetch`/`FormData`/`Blob`, Node ≥ 20). Toolchain: TypeScript in `x-agent/mcp` (zod, adm-zip, @wp-playground/cli — all already present). Companion: PHP, one new route in the existing REST class. Live acceptance via `tools/playground/boot.mjs` Playgrounds on dedicated ports.

**Spec:** `specs/theme-factory.spec.json` (amends `specs/pipeline.spec.json` and `specs/agent-plugin.spec.json`; read all three — on conflict the base specs win, except the two amendments the theme spec records: the one companion route and the widened tokens contract).

## Global Constraints

Copied from the spec — every task's requirements implicitly include these:

- "The model authors ONE artifact here: ThemeSpec, validated against theme-spec.schema.json. No model call ever writes a theme file, a template, or a line of theme.json — the scaffolder compiles those from the spec deterministically, or the run has a bug."
- "Stage order is the load-bearing wall: scaffold -> build test -> install -> activate all complete BEFORE S2 runs" — zero special cases downstream except skeleton-aware S4/S9.
- "Never bypass a gate to make the theme land. A ThemeSpec that fails its contract gets the one schema-retry; a theme that fails wp_theme_build_test gets the one S7-style repair of its SPEC (not its files), recompiled whole; a second failure aborts the run at preflight depth."
- Theme generation runs ONLY when `--bespoke` AND `--new-site` are both present — never inferred, never on a connected site. `--bespoke` without `--new-site` fails preflight naming the rule. Resume keeps the mode with the run (`state.bespoke`, the `state.brochure` precedent).
- The theme ships STRUCTURE only: no pattern corpus, no block styles, no font declarations. Fonts belong to the Font Library; patterns and block styles belong to S4/S5.
- "No page-view hotlinking of font CDNs, ever" — fonts are fetched agent-side at build time; the instance never calls out, at install time or page view.
- "No new companion surface beyond the single theme-install route, and no theme mutation lane: a theme installs whole and activates, or it does not ship."
- "No theme removal at run end: the theme IS deliverable — named, licensed, explicable from wp-admin" (deliverable-purity governs the companion, never the theme).
- Font downloads are never model calls and never metered; they appear in the report, not the ledger. Every cached family stores its license file beside its woff2s.
- Budget: `base = 1 (brief) + T + 1 (tokens) + F + S + B + P; ceiling = 2 * base + I. T = 1 iff bespoke. F = 2 + (1 if the skeleton declares a rail)`.
- The font lane is NOT gated by `--bespoke` — a sourced family installs on any toolchain-posture run; connected-site runs without either flag stay byte-identical to pre-spec behavior.
- `pipeline.config.json` gains a `theme` task entry `{provider, model, effort}` — required at preflight only when `--bespoke` is passed; high effort recommended.
- WordPress ≥ 6.5 on the target (the Font Library floor). Node ≥ 20.
- Skeleton enum is exactly `stacked | split | rail` — it "grows by field evidence, never speculatively"; record every skeleton-enum temptation in PROGRESS.
- Determinism: same ThemeSpec => byte-identical scaffolded theme (pure templating); fake-provider replay of a ThemeSpec fixture => byte-identical theme zips; font cache is hash-pinned, cache hit is a no-op; `--resume` after S1T replays the theme zip + fingerprint from the run dir with zero calls and zero reinstalls.
- House rules: 4-space indentation; `ghe` (never `gh`) for GitHub operations; no ajv (in-repo draft-07 subset validator); pipeline stays plain `.mjs` importing `x-agent/mcp/dist`; JSON Schemas are draft-07 `additionalProperties:false`; vendored schema copies must stay byte-identical, pinned by test.
- Progress protocol: `PROGRESS.theme-factory.json`, same schema as the other ledgers (milestones + decisions[]); record every skeleton temptation, every place the theme was tempted to carry design, every font-lane fallback fired.

## The ThemeSpec contract (what the one metered call authors)

```
{
  identity:  { name, slug, description },              // 'Salon Regale Theme' — real, named, deletable from wp-admin
  skeleton:  'stacked' | 'split' | 'rail',
  measure:   { contentSize, wideSize },                // px/ch/rem, contentSize < wideSize; R9 passes it through as law
  physics:   { blockGap, rootPadding: {top,right,bottom,left}, useRootPaddingAwareAlignments: true, appearanceTools: true, fluidTypography: true },
  presets:   { shadows[], gradients[], duotones[], custom{} },   // slug-addressable, slug-unique
  // templates and parts are NOT authored — the roster is fixed:
  // templates: index, page, page-no-title (GUARANTEED), canvas (bare); parts: header, footer, + rail iff skeleton==='rail'
}
```

Mechanical cross-checks beside schema validation (the spec gate): skeleton in enum, `contentSize < wideSize` with both in px/ch/rem, preset slugs unique. One schema-retry, metered.

---

## Toolchain facts the implementer must know (verified 2026-08-27)

**None of the theme factory exists yet** — grep for `wp_theme_`, `themes/install`, `ThemeSpec`, `skeleton` across `x-agent/`, `x-companion/`, `pipeline/`, `contract/` returns zero implementation hits. Everything below is the EXISTING machinery the new code mirrors.

### x-agent MCP tool anatomy (the block factory as the mold)

- A tool file (`x-agent/mcp/src/tools/blockScaffold.ts`) is a thin shell: zod `InputSchema`/`OutputSchema` + `export const wpBlockScaffold = defineTool({name, title, description, inputSchema, outputSchema, handler, local?: true})` + `export const tools = [...]`. All real work lives in `factory.ts` (blocks) / `schemaFactory.ts` (schema packages). **The theme factory gets its own `x-agent/mcp/src/themeFactory.ts` — do not extend `factory.ts` or `_shared.ts`** (`_shared.ts` is 36 lines: `ConnectionArgsShape`, `connectionArgs()`, `defineTool()` — nothing else belongs there).
- Registration: `x-agent/mcp/src/registry.ts` — add `import { tools as themeScaffoldTools } from './tools/themeScaffold.js'` (imports near L80–94) and spread into `export const TOOLS: ToolDef[]` (L299–316, beside `schemaScaffoldTools`/`schemaBuildTestTools`/`schemaInstallTools` at L311–313). That's ALL registration takes. `local: true` on a tool means the handler gets a stub Ctx (no live connection) — right for scaffold and build_test, wrong for install.
- Imports inside `.ts` sources use `.js` extensions (`'../themeFactory.js'`). Build: `cd x-agent/mcp && npm run build` (tsc → `dist/mcp/src/**` + `dist/templates/**`); strict + `noUncheckedIndexedAccess`; optional keys are assigned via conditional spread, never `undefined` assignment.
- Scaffold mold (`factory.ts`): `templateDir()` L234 walks up for `templates/dynamic-block/`; `interpolate(template, vars)` L270 does single-pass `{{key}}` substitution and THROWS on an unfilled placeholder; `assertSlug` L295 refuses traversal/uppercase/reserved; existing-dir refusal unless `force`; post-write re-parse assertion. Theme templates live in a new `x-agent/templates/block-theme/`.
- Build-test mold (`factory.ts`): `freePort(preferred?)` L1347 probes a range (blocks default `[9440,9449]` via `X_AGENT_SMOKE_PORT_RANGE`); `SMOKE_RUNNER_SOURCE` L1437 is a child-process script that calls `@wp-playground/cli`'s `runCLI({command:'server', port, mount:[{hostPath, vfsPath}], blueprint:{steps:[...]}})`, supports **arbitrary named PHP probes** (`SmokeConfig.probes: Record<string,string>`, runner L1487–1492 — the seam `schemaFactory.ts` already uses), and has a Playwright pass (headless chromium, `page.goto(url, {waitUntil:'networkidle'})`, one `page.evaluate`) where `getComputedStyle`/`document.fonts` are directly reachable — **this is where the theme build gate MEASURES physics**. `resolvePlaygroundCli()` L1322; `run()` L1231; `loadAdmZip()` L222; `packageBlock(dir, zipPath, rootName?)` L1200 (deterministic sorted zip walk). Env knobs: `X_AGENT_SMOKE_PHP` (default '8.3'), `X_AGENT_SMOKE_WP` (default 'latest').
- Install mold (`blockInstall.ts` L55–120): local `inspectPackage` re-check → posture gate (`fetchFingerprint(); posture==='production'` → `errPostureForbidden`) → `live.companion.installBlockFromFile(zipPath)` → `live.manifestCache.get({refresh:true})` → reload warm session ONLY if one exists (`if (live.session !== undefined) await getSession(live)`) → return `{installed, fingerprint, ...}`. "Sequential from the single runner" is the caller's discipline, not the tool's.
- Companion client (`companion.ts`): `NAMESPACE='x-companion/v1'`; `installBlockFromFile` L641 / `installSchemaFromFile` L680 are two copies of a hand-rolled multipart POST (field name `package`, `Content-Type: application/zip`) — **a third copy is the moment to extract a shared `installPackage(route, zipPath)` private helper used by all three**; sets `this._fingerprint` from the response and clears `this._manifest`. `assertToolchain(route)` L636 is the client-side posture guard.
- Manifest: `wp_manifest` does NOT return theme identity today. `manifest.theme_tokens.layout.{contentSize,wideSize}` carries the measure (from `wp_get_global_settings()`). The theme slug+version already feed the fingerprint (`class-manifest.php::active_theme()` L730). **M2's "wp_manifest returns the theme's name" needs a `theme: {slug, name, version}` key added to `class-manifest.php::build()` (L549–583), the zod `ManifestSchema` (`schemas.ts` L130–162), and the mock-companion fixtures.**
- Tokens: `wp_tokens_apply` input = flattened DesignTokens fields; handler re-parses `DesignTokensSchema`. The `families[]` item shape is `.strict()` in **three schema copies that must stay byte-identical (pinned by test)** — `contract/schemas/design-tokens.schema.json`, `x-agent/schemas/design-tokens.schema.json`, `x-companion/fixtures/schemas/design-tokens.schema.json` — plus the zod `TypographySchema` (`schemas.ts` L193–210) and the emitter types (`x-agent/templates/theme-json/emitter.ts` L32–36). The companion's `class-theme-tokens.php::compile()` (L279–304) keeps only `slug/name/fontFamily` — it may keep IGNORING `source`, but its schema copy must not REJECT it.
- Snapshot: the zip already carries the active theme (`SNAPSHOT_ENTRIES` includes `theme/`; `copy_recursive(get_stylesheet_directory(),...)`) — M6's snapshot clause holds mechanically.
- Oracle (`oracle.ts`): `extractLayout(page, nameByClass)` L338 is one big `page.evaluate`; per-node `computed` emitted at L463 is `{display, gap, fontSize, color, background}` — **add `fontFamily` there** and a top-level `fonts` result (from `document.fonts`), then widen `verify.ts` `OutputSchema` (`box_tree[].computed` L65–71). For font truth use `wp_verify({url})` mode (render-shell mode lacks the template wrapper chain).
- Fingerprint discipline: computed ONLY companion-side (`fingerprint_inputs()` includes `theme{slug,version}`, `global_styles`, active `plugins[]`); `switch_theme` already hooks `bust_cache` (`class-manifest.php` L81). A theme activation moves the epoch for free; the route must return `X_Companion_Manifest::fingerprint(true)` computed AFTER activation.

### x-companion route anatomy

- Loader: `x_companion_load()` globs `includes/class-*.php` and calls `::init()` — **adding `class-theme-library.php` (→ `X_Companion_Theme_Library`) is auto-loaded, no list to edit**.
- Routes: `class-rest.php` — add `'themes_install'` to `const DISPATCHED_ROUTES` (L68–80); add a `register_rest_route($ns, '/themes/install', {methods: CREATABLE, callback: route_themes_install, permission_callback: $ext})` (mirror `register_schema_routes()` L459–484); the callback shims to `self::dispatch('themes_install', $request)`; the implementing class hooks `add_filter('x_companion_route_themes_install', ..., 10, 2)`.
- `permission_extend()` (L164–182) puts the POSTURE check ahead of the capability check — production returns 403 `{code:'posture_forbidden'}` even to an administrator. `X_COMPANION_POSTURE` defaults to `'production'`.
- Install-route mold (`class-block-library.php::route_install()` L332–468): multipart file field `package` → `analyze_package()` (size cap 5MB, `is_safe_entry()` traversal guards, exactly one top-level dir, required-file checks) → staged unzip → activate → `reregister` → `{installed:{...}, fingerprint: new_epoch(), replaced_previous}`; failures roll back; `policy_error()` → 422 with `data.reasons[]`; ALL fs ops through `WP_Filesystem` (Plugin Check compliance); `is_managed_path()` fences deletions — **the theme installer needs its own fence rooted at `get_theme_root()`**. Theme differences: unzip to `get_theme_root()`, activate via `switch_theme($stylesheet)`, validate `style.css` header + `theme.json` parses + declared templates exist.

### Test conventions

- x-agent: vitest from `x-agent/mcp` (`npm test`); offline suites import pure functions straight from `../mcp/src/*.js` (`factory.test.ts` is the 704-line model: mkdtemp workspace, zip read-back assertions); tool-surface tests drive `callTool(name, args, runtime)` against `tests/mock-companion/`; live suites are opt-in via env (`X_AGENT_FACTORY_LIVE=1`) + a setup script booting dedicated-port Playgrounds (9440–9449 belongs to the block factory suite — pick a fresh range for themes).
- x-companion: `tests/run-all.sh`; offline PHP tests over `tests/bootstrap-lite.php` (a WP stand-in — it already stubs `WP_Theme`); live `php tests/test-install.php --runtime tools/.runtime/<slot>.json` is the model for a theme-install suite.
- pipeline: `node --test pipeline/tests/*.test.mjs`; fake provider replays fixtures; accept scripts in `pipeline/tests/accept/` boot dedicated Playground slots (9410 pipeline-accept; NEVER touch the owner's persistent 9400 instance).

---

## Pipeline facts the implementer must know (verified 2026-08-27)

- **CLI flags**: `parseArgs(argv, {booleans})` at `cli.mjs:34-48`; the build branch declares its booleans at `cli.mjs:467-469` — append `'bespoke'` there + a HELP line at `cli.mjs:63-69`. The `--new-site` mutual-exclusion preflight precedent is `cli.mjs:402-414` (throw `PipelineError('preflight_failed', message, hint)`); the `--bespoke`-without-`--new-site` rule goes there. Handoff: `runPipeline({..., brochure: !!flags.brochure, ...})` at `cli.mjs:416-426` gains `bespoke: !!flags.bespoke`.
- **Stage registration**: `run.mjs:15-25` `const DEFAULT_STAGES = [s1, s2, ...]` — positional order only; splice `s1t` between `s1` and `s2`. Stage module contract: `export const id = 'S1T_theme'; export const kind = 'gated-generative'; export async function run(ctx) {}`. `STAGE_INFO` (`run.mjs:29-39`) gains an `S1T_theme` entry. `ctx = {prompt, runDir, config, call, llm, budget, ledger, state, log}` (`run.mjs:81-86`); `ctx.rest` exists only as a test seam in s8.
- **Mode persistence**: `run.mjs:56-67` — one-way `if (bespoke) state.bespoke = true;` (never `= flag`) so `--resume` keeps the mode. Signature at `run.mjs:47` gains `bespoke = false`.
- **Resume**: purely `state.completed.includes(stage.id)` (`run.mjs:94-108`); a completed S1T is never re-entered — that IS the "zero new calls, zero reinstalls" clause. A non-bespoke S1T self-skips like `s5-blocks.mjs:32-35` (log one line, return) and still lands in `completed`.
- **Run dir**: `run.mjs:52-55` mkdirs `['', 'trees', ...]` — add `'theme'`.
- **Budget**: `computeBudget(brief)` at `budget.mjs:16-26` currently `F = 2; base = 1 + 1 + F + S + B + P; ceiling = 2*base + I`. Widen to `computeBudget(brief, { bespoke = false, rail = false } = {})` → `T = bespoke ? 1 : 0`, `F = 2 + (rail ? 1 : 0)`, `base = 1 + T + 1 + F + S + B + P`. Sole caller `s1-brief.mjs:80`; the `--no-images` post-hoc mutation precedent (`s1-brief.mjs:81-87`) is the model for the RAIL BUMP: S1 fixes the ceiling with F=2 (skeleton unknown); S1T, on a rail ThemeSpec, sets `budget.F=3; budget.base+=1; budget.ceiling=2*budget.base+budget.I`, calls `ctx.budget.setCeiling(...)` again, rewrites `state.budget`, re-prints the line. Check `BudgetMeter.setCeiling` (`budget.mjs:40-48`) tolerates a re-set; loosen if not. Ceiling print sites: `s1-brief.mjs:90-91` (add `T=` when bespoke), `report.mjs:24` (add T term), `report.mjs:7` `PREDICTED` gains `theme: (b) => b.T ?? 0`.
- **The metered-call lane**: `ctx.llm.generate({task_type, label, payload, validate, template?, maxAttempts = 2})` (`llm.mjs:34`) — budget.spend before EVERY attempt; ledger.record after every attempt (`outcome: 'ok'|'invalid_json'|'schema_failed'`); retry prompt = base + `CONTRACT FAILURE` block; after maxAttempts throws `contract_failed`. `maxAttempts: 2` IS the one schema-retry. S7 repair uses `maxAttempts: 1`.
- **Task routing**: `createProviders` (`providers/index.mjs:9-34`) iterates `TASK_TYPES` from `lib/config.mjs:9` — an unlisted `tasks.theme` config entry is silently ignored, but LISTING it makes it required for every run (`loadPipelineConfig`, `config.mjs:38-63`). **Decision (spec demands a real `theme` task entry, required only under `--bespoke`)**: add `export const OPTIONAL_TASK_TYPES = ['theme']` in `config.mjs`; `loadPipelineConfig` validates a `theme` entry's SHAPE when present but never requires it; `createProviders` iterates `[...TASK_TYPES, ...OPTIONAL_TASK_TYPES]` (its existing `if (!entry) continue;` handles absence); the `--bespoke` preflight in `cli.mjs` asserts `config.tasks.theme` exists, else `preflight_failed` naming the task; `defaultBuildConfig` (`site.mjs:85-91`) writes a `theme` entry (strongest model, `effort: 'high'`) so `--new-site --bespoke` works out of the box. Ripple check: `tests/cli.test.mjs:49-61`, `tests/run.test.mjs:11`.
- **Prompt templates**: frontmatter `task_type:` must equal the filename stem; `required: [a-z_ fields]`; `{{placeholder}}` is `[a-z_]+` only; non-string payload values render as `JSON.stringify(v, null, 2)` (how `contract_note` ships a schema into the prompt, `s3-tokens.mjs:39`); optional content ships `''`, never omitted (`mode_note` precedent `s1-brief.mjs:61`). Style cues via `renderStyleNote(style)` (`lib/styles.mjs:154`) or raw `loadStyles()` cues.
- **Fake provider**: fixture file `pipeline/fixtures/fake/<task>.<label>.json` shaped `{text, usage}`; keyed by task+label. The ThemeSpec fixture is `theme.theme.json`. Capture: env `X_PIPELINE_CAPTURE`.
- **Schema home**: `contract/schemas/` = crosses the pipeline↔tools boundary (theme-spec does; it feeds `wp_theme_scaffold`); `pipeline/schemas/` = pipeline-internal (brief only). Validation via `validateSchema` (`lib/schema.mjs`) which supports ONLY: `type` (incl. integer), `oneOf`, `const`, `enum`, `pattern`, `minLength`, `minimum`, `maximum`, `minItems`, `maxItems`, `items`, `required`, `properties`, `additionalProperties` — **no `$ref`/`allOf`/`anyOf`/`format`; write theme-spec.schema.json inside this subset or the contract is decorative.**
- **S3 hook + the key-strip trap**: `wp_tokens_apply` dry-run at `s3-tokens.mjs:76`, real apply at `:103`, gate `:104-114`, artifacts+fingerprint `:115-119`. `wp_tokens_apply`'s own zod input REJECTS unknown keys — the sizes strip at `s3-tokens.mjs:49-59` is the precedent: **families must get the same strip (`{slug,name,fontFamily}` to the tool; `source` stays in the run-dir `tokens.json` for the font lane)** unless the zod contract is widened to accept `source` (it will be — but strip-vs-pass is decided in the font task). `contract/schemas/design-tokens.schema.json:102-125` families items are `additionalProperties:false` — `source` fails validation today; all three copies + zod + emitter move together. `prompts/tokens.md:41-42` says "system stacks (no font files)" — that sentence changes.
- **S4 skeleton seam**: resume-safe site-wide decisions resolve once with a fallback — `const axis = brief.axis ?? {...}` (`s4-sections.mjs:31`); the skeleton analogue is `const skeleton = ctx.state.theme?.skeleton ?? 'stacked'` (old run dirs resume unchanged). Section payload literal at `:82-104` (axis at `:91-96`), furniture payload at `:192-209` — both gain a `skeleton` key; `prompts/tree.md` + `prompts/furniture.md` gain `{{skeleton}}` + required entry. Furniture fan-out at `:264-268` gains `...(skeleton === 'rail' ? [limiter(() => runFurniture('rail'))] : [])`; `PART_NOTES` (`:176-179`) gains a `rail` entry; the `bandColors(part === 'footer' ? 'contrast' : 'base')` call at `:205` gains a rail arm; `headerShape()` (`:180-190`) is the mold for a rail shape gate. Furniture rides `task_type: 'tree'` + `template: 'furniture'` — the template-override seam (`llm.mjs:41`).
- **S8**: `rest = ctx.rest ?? createRest(readConnection(process.cwd()))` (`s8-publish.mjs:33`); `tools/lib/rest-client.mjs` already does Basic auth + **multipart** (`{multipart: [{name, filePath}|{name, value}]}`, `rest-client.mjs:126-142`) — `rest('POST', '/wp/v2/font-families/<id>/font-faces', {multipart})` works today with zero plumbing. `page-no-title` is set per page unconditionally (`s8-publish.mjs:123-135`). Template-part writes at `:168-179` (header/footer) — rail publishing generalizes this loop. The image pass (`:306-318`) is the ONLY non-llm ledger writer — **fonts must never write the ledger** (M5: "the ledger contains no font entries"); the report is fed from `state.fonts` instead.
- **S9**: verification is `ctx.call('wp_verify', {url: siteRoot, wait:'domcontentloaded', ...})` after `wp_disconnect` (fresh session), retry-once-on-empty (`s9-verify.mjs:22-40`); audits are pure `failures.push(...screenX(...))` (`:43-68`) — the font audit is one more pushed screen. `screenBandWidths` (`gates.mjs:307-324`): "full" = `viewportWidth - CLAMP_SLACK(48)`; the `parts.length >= 2` header/footer width-agreement check REJECTS a rail by design — needs a skeleton arm. `bandStructures` (`gates.mjs:292-305`) finds parts by `core/template-part` and bands as direct-child groups of `core/post-content`. `screenBandSeams` (`gates.mjs:337-351`, tolerance 4px) y-sorts all bands — under `split`, side-by-side panes would fake seams: seam audit must run per-pane column. `box_tree[].computed` = `{display, gap, fontSize, color, background}` — NO fontFamily (pinned at `oracle.ts:60-66`, `:461-466`, `verify.ts:65-71`, `registry.ts:163`) — the font check is a cross-package oracle amendment.
- **Tests**: `node --test pipeline/tests/*.test.mjs` from repo root; hand-built ctx fakes (`tests/s3-tokens.test.mjs:41-63` is the mold: scripted provider inside a REAL `createLlm` + real prompt templates — **a stage test fails unless `prompts/theme.md` exists with matching `required`**); stage-order/resume tests via synthetic stage modules + `runPipeline({stages, skipToolchain: true})` (`tests/run.test.mjs:19-20`); s8 injects `ctx.rest`. Accept scripts `pipeline/tests/accept/*.sh`, `set -euo pipefail`, cd to repo root, end `echo "… ACCEPTED"`.

---

## File Structure (new and touched)

```
contract/schemas/theme-spec.schema.json          NEW — the ThemeSpec contract (draft-07, validator subset)
x-agent/schemas/theme-spec.schema.json           NEW — vendored byte-identical copy (pin test)
x-agent/templates/block-theme/                   NEW — static theme skeleton: style.css, templates/*.html, parts/*.html
x-agent/mcp/src/themeFactory.ts                  NEW — scaffold/buildAndTest/inspect/package (mirror of factory.ts, theme-shaped)
x-agent/mcp/src/tools/themeScaffold.ts           NEW — wp_theme_scaffold (local: true)
x-agent/mcp/src/tools/themeBuildTest.ts          NEW — wp_theme_build_test (local: true)
x-agent/mcp/src/tools/themeInstall.ts            NEW — wp_theme_install
x-agent/mcp/src/registry.ts                      MOD — import + spread the three theme tool arrays
x-agent/mcp/src/companion.ts                     MOD — shared installPackage() helper + installThemeFromFile()
x-agent/mcp/src/schemas.ts                       MOD — TypographySchema families.source; ManifestSchema.theme
x-agent/mcp/src/oracle.ts                        MOD — computed.fontFamily + fonts[] from document.fonts
x-agent/mcp/src/tools/verify.ts                  MOD — OutputSchema widened (computed.fontFamily, fonts[])
x-agent/templates/theme-json/emitter.ts          MOD — ThemeJsonFontFamily tolerates source (strips it from theme.json output)
x-agent/tests/theme-factory.test.ts              NEW — offline scaffold/policy/zip tests (factory.test.ts mold)
x-agent/tests/mock-companion/                    MOD — POST /themes/install + manifest.theme fixture
x-companion/includes/class-theme-library.php     NEW — POST /themes/install (auto-loaded by filename convention)
x-companion/includes/class-rest.php              MOD — DISPATCHED_ROUTES + register + shim
x-companion/includes/class-manifest.php          MOD — build() gains theme:{slug,name,version}
x-companion/fixtures/schemas/design-tokens.schema.json  MOD — families.source (byte-identical to contract copy)
x-companion/tests/test-themes.php                NEW — live install/policy/activation suite (test-install.php mold)
contract/schemas/design-tokens.schema.json       MOD — families.source
contract/schemas/manifest.schema.json            MOD — theme identity
pipeline/stages/s1t-theme.mjs                    NEW — the stage
pipeline/prompts/theme.md                        NEW — the one template (payload: brief summary, combo cues, skeleton vocab, contract, repair_note)
pipeline/lib/fonts.mjs                           NEW — resolve/download/cache/install; report record out
pipeline/lib/config.mjs                          MOD — OPTIONAL_TASK_TYPES = ['theme']
pipeline/providers/index.mjs                     MOD — iterate required+optional
pipeline/lib/site.mjs                            MOD — defaultBuildConfig writes tasks.theme
pipeline/cli.mjs                                 MOD — --bespoke flag, preflight rule, pass-through, HELP
pipeline/run.mjs                                 MOD — stage splice, STAGE_INFO, state.bespoke, 'theme' dir
pipeline/budget.mjs                              MOD — T + rail-aware F
pipeline/stages/s1-brief.mjs                     MOD — computeBudget(brief, {bespoke}), T in the printed line
pipeline/stages/s3-tokens.mjs                    MOD — families strip + font-lane hook + state.fonts
pipeline/stages/s4-sections.mjs                  MOD — skeleton in payloads, rail furniture call
pipeline/stages/s8-publish.mjs                   MOD — rail part write; split pane assembly
pipeline/stages/s9-verify.mjs                    MOD — skeleton-aware band audit args + font screen
pipeline/lib/gates.mjs                           MOD — pane-aware screenBandWidths/screenBandSeams + screenFontFamilies
pipeline/lib/report.mjs                          MOD — T in ceiling line, PREDICTED.theme, ## Fonts section
pipeline/prompts/tokens.md                       MOD — sourced-families guidance replaces "no font files"
pipeline/prompts/tree.md + furniture.md          MOD — {{skeleton}}
pipeline/fixtures/fake/theme.theme.json          NEW — ThemeSpec replay fixture
pipeline/tests/*.test.mjs                        NEW/MOD — per task below
pipeline/tests/accept/tf-m*.sh                   NEW — acceptance scripts per milestone
PROGRESS.theme-factory.json                      NEW — milestones + decisions ledger
```

---

## Design decisions locked by this plan (each recorded in PROGRESS.theme-factory.json decisions[] when implemented)

1. **`theme` is an OPTIONAL task type** (`OPTIONAL_TASK_TYPES` in `lib/config.mjs`): shape-validated when present, required by `--bespoke` preflight only. The spec demands a real `tasks.theme` entry; the codebase demands TASK_TYPES members be universally required; this is the reconciliation.
2. **The rail budget bump happens in S1T**, after the skeleton is known: F 2→3, base+1, `setCeiling` re-issued, `state.budget` rewritten, line re-printed. S1's printed ceiling is provisional only in the F term, and only on bespoke runs. (The `--no-images` post-hoc mutation and the removed-M7 "budget moment" history are the precedents; this one is bounded to +1.)
3. **ThemeSpec.physics carries only what varies** (`blockGap`, `rootPadding`); `useRootPaddingAwareAlignments: true`, `appearanceTools: true`, fluid typography ON are scaffolder constants — "the theme carries only what a section call CANNOT decide", and a constant is code's to decide.
4. **The measure sanity check compares contentSize < wideSize only when units match**; mismatched units fail with "use the same unit for both" (px/ch/rem are not mechanically commensurable).
5. **Theme repair rides `task_type: 'theme'` with `maxAttempts: 1`** and a `repair_note` payload field (empty string on the authoring call, the `mode_note` convention) — no new prompt file, no new task type, the S7 economy (one repair, then abort as `preflight_failed`).
6. **Split panes**: the section MODEL declares `metadata.pane: 'primary'|'secondary'` on the section root (payload documents both panes; S4 code-gates that the declaration exists and is legal when skeleton is split); S8 deterministically wraps sections into two pane `core/group`s (classNames `x-pane-primary` / `x-pane-secondary`) inside one full-width flex row group; S9 audits bands against their pane's measured box, seams per pane column.
7. **Rail width is a scaffolder constant** (a `--wp--custom--rail-width` custom value the rail templates consume), reported by `wp_theme_scaffold` in its output and recorded in `state.theme.rail_width`; S9 audits the rail part against it. The ThemeSpec does not author it (contract stays structure-only).
8. **S8's furniture write loop generalizes** from hardcoded header/footer to every passed furniture artifact (rail included, `area: 'rail'`) — behavior for non-rail runs byte-identical.
9. **Fonts install between the tokens dry-run gate and the real `wp_tokens_apply`** — SETTLED by verified core behavior: creating font posts + uploading files puts a font in the Library only; nothing renders until the family (WITH its `fontFace` array pointing at the uploaded files) is present in merged global settings. Activation therefore rides the single tokens write: fonts.mjs installs faces via core REST, the pipeline enriches the tool-bound `families[]` with pipeline-constructed `fontFace` arrays, and `wp_tokens_apply` carries them into the user global-styles record (the "widened tokens contract" amendment — the companion's `compile()` passes `fontFace` through). The model NEVER authors `fontFace` (an S3 code check rejects it); it authors only `source`. Deviation from the spec's "immediately after wp_tokens_apply" wording recorded with this rationale.
10. **The scaffolder's .html templates are static per-skeleton fixtures** in `x-agent/templates/block-theme/` — structural markup only (template-part refs, group wrappers, post-title/post-content). R1 ("no hand-written markup") governs model output; deterministic code shipping static structural template files is exactly how core themes ship. The poisoned-spec test asserts model-authored strings surface ONLY in `style.css` + `theme.json` identity/description fields.
11. **theme.json version 3** (needs WP ≥ 6.6; the spec's 6.5 floor is the FONT floor) — bespoke themes only ever land on fresh Playgrounds running `latest`, and the build-test sandbox runs `latest` (recorded). Verified key paths: `settings.layout.{contentSize,wideSize}`; blockGap is tri-state — `settings.spacing.blockGap: true` (UI + output) with the VALUE at `styles.spacing.blockGap`; root padding = `styles.spacing.padding` + `settings.useRootPaddingAwareAlignments: true` (direct child of settings); `settings.appearanceTools: true`; `settings.typography.fluid: true`; presets at `settings.shadow.presets` / `settings.color.gradients` / `settings.color.duotone` / `settings.custom`; `customTemplates[].postTypes` defaults to `["page"]`; `templateParts[].area`. The bespoke theme defines NO fontSizes/spacingSizes (the tokens lane owns those), so v3's defaultFontSizes/defaultSpacingSizes merge change is moot.
12. **A `rail` template-part area requires PHP**: default allowed areas are exactly `uncategorized|header|footer` in every 6.x; an unknown `area` silently coerces to `uncategorized` with a `wp_trigger_error`. The scaffolder therefore emits a `functions.php` (rail skeleton ONLY) whose sole content registers the area via the `default_wp_template_part_areas` filter (`{area:'rail', area_tag:'aside', ...}`). Static template file, zero model input; stacked/split themes ship no PHP at all.
13. **Font lane mechanics (all verified live/against core source)**: Google css2 endpoint with the legacy-Firefox UA (`Firefox/39.0`) returns ONE complete woff2 per weight, no unicode-range (the google-webfonts-helper technique); the gstatic URL's `/v<NN>/` segment is the version pin for the cache dir (`tools/.runtime/fonts/<slug>@v<NN>/`); license id from `https://fonts.google.com/metadata/fonts/<Family>` (strip a leading `)]}'` guard conditionally) with the license TEXT from `raw.githubusercontent.com/google/fonts/main/<ofl|apache|ufl>/<slugnospaces>/OFL.txt` (best-effort; failures degrade to a recorded `license: 'unknown'`, never a run failure). WP side: `POST /wp/v2/font-families` with `font_family_settings` as a STRINGIFIED-JSON field (`{name, slug, fontFamily}`, additionalProperties:false) + `theme_json_version: 3`; faces via nested `POST /wp/v2/font-families/<id>/font-faces` as multipart — part `font_face_settings` (stringified JSON `{fontFamily, fontStyle, fontWeight, fontDisplay:'swap', src:'file-0'}`) + binary part `file-0`; every file part MUST be referenced from `src`; duplicate family slug → 400 `rest_duplicate_font_family` (check `?slug=` first and reuse); faces have NO update route (delete+recreate); everything needs `edit_theme_options` (the admin app password the rest() lane already holds); files land in `wp-content/uploads/fonts/`.
14. **The S9 font-fallback poison** (M5 clause 2) is "re-apply tokens with the activation stripped", not "delete the font post": activation lives as embedded `fontFace` src URLs in the user global-styles record, so deleting `wp_font_family` posts does not stop rendering — the honest equivalent of the spec's poison is removing the `fontFace` entries from global styles so the browser falls back to the stack. Recorded as a deviation with rationale.

## Execution notes

- Work on branch `theme-factory` in the main checkout (recorded PROGRESS.pipeline decision: worktrees can't share `x-agent/mcp/dist`, `tools/node_modules`, `tools/.runtime`).
- Commit per task (`git add` named files; message `theme-factory: <what>`), 4-space indent everywhere, `.js` import extensions in TS, conditional spread for optional TS keys.
- After every x-agent change: `cd x-agent/mcp && npm run build` before any pipeline test that goes through `dist/`.
- Unit suites: `cd x-agent/mcp && npx vitest run` | `node --test pipeline/tests/*.test.mjs` | `php x-companion/tests/test-manifest.php` etc.
- Live acceptance boots Playgrounds on dedicated ports; NEVER touch the owner's persistent instance on 9400. Theme build-test sandbox port range: 9480-9489 (blocks own 9440-9449, schema 9460-9469 by pipeline decision).
- The companion mount discipline (deliverable-purity) applies to live tests: test scripts boot their own instances with `--plugin ./x-companion`; never REST-delete a live mount.

---

### Task 1: The ThemeSpec contract — `contract/schemas/theme-spec.schema.json` + vendored copy + checks

**Files:**
- Create: `contract/schemas/theme-spec.schema.json`
- Create: `x-agent/schemas/theme-spec.schema.json` (byte-identical)
- Create: `pipeline/lib/theme-spec.mjs` (`themeSpecChecks(spec)` — the mechanical cross-checks)
- Create: `pipeline/tests/theme-spec.test.mjs`
- Modify: `x-agent/tests/schemas.test.ts` (extend the vendored-copy byte-identity pin to the new pair)
- Create: `PROGRESS.theme-factory.json` (milestones M1..M6 `pending`, decisions[] seeded with decisions 1-11 above as they land)

**Interfaces:**
- Produces: the draft-07 contract (validator-subset only — no $ref/anyOf/allOf/format) and `themeSpecChecks(spec) -> [{path, message}]`.
- Consumed by: Task 2's zod mirror, Task 8's stage `validate:`.

**The contract (write exactly this shape):**

```json
{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "ThemeSpec",
    "description": "The parameter object a bespoke block theme is compiled from. The model authors THIS and nothing else; the scaffolder owns every byte on disk.",
    "type": "object",
    "required": ["version", "identity", "skeleton", "measure", "physics", "presets"],
    "additionalProperties": false,
    "properties": {
        "version": { "const": 1 },
        "identity": {
            "type": "object",
            "required": ["name", "slug", "description"],
            "additionalProperties": false,
            "properties": {
                "name": { "type": "string", "minLength": 3 },
                "slug": { "type": "string", "pattern": "^[a-z][a-z0-9-]{1,48}$" },
                "description": { "type": "string", "minLength": 10 }
            }
        },
        "skeleton": { "enum": ["stacked", "split", "rail"] },
        "measure": {
            "type": "object",
            "required": ["contentSize", "wideSize"],
            "additionalProperties": false,
            "properties": {
                "contentSize": { "type": "string", "pattern": "^[0-9]+(\\.[0-9]+)?(px|ch|rem)$" },
                "wideSize": { "type": "string", "pattern": "^[0-9]+(\\.[0-9]+)?(px|ch|rem)$" }
            }
        },
        "physics": {
            "type": "object",
            "required": ["blockGap", "rootPadding"],
            "additionalProperties": false,
            "properties": {
                "blockGap": { "type": "string", "pattern": "^[0-9]+(\\.[0-9]+)?(px|rem|em)$" },
                "rootPadding": {
                    "type": "object",
                    "required": ["top", "right", "bottom", "left"],
                    "additionalProperties": false,
                    "properties": {
                        "top": { "type": "string" }, "right": { "type": "string" },
                        "bottom": { "type": "string" }, "left": { "type": "string" }
                    }
                }
            }
        },
        "presets": {
            "type": "object",
            "required": ["shadows", "gradients", "duotones", "custom"],
            "additionalProperties": false,
            "properties": {
                "shadows": { "type": "array", "maxItems": 8, "items": { "type": "object", "required": ["slug", "name", "shadow"], "additionalProperties": false, "properties": { "slug": { "type": "string", "pattern": "^[a-z0-9-]+$" }, "name": { "type": "string" }, "shadow": { "type": "string", "minLength": 3 } } } },
                "gradients": { "type": "array", "maxItems": 8, "items": { "type": "object", "required": ["slug", "name", "gradient"], "additionalProperties": false, "properties": { "slug": { "type": "string", "pattern": "^[a-z0-9-]+$" }, "name": { "type": "string" }, "gradient": { "type": "string", "minLength": 10 } } } },
                "duotones": { "type": "array", "maxItems": 8, "items": { "type": "object", "required": ["slug", "name", "colors"], "additionalProperties": false, "properties": { "slug": { "type": "string", "pattern": "^[a-z0-9-]+$" }, "name": { "type": "string" }, "colors": { "type": "array", "minItems": 2, "maxItems": 2, "items": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" } } } } },
                "custom": { "type": "object" }
            }
        }
    }
}
```

`themeSpecChecks(spec)` (pure, `lib/schema.mjs` issue shape): (a) measure units match → numeric contentSize < wideSize, else `{path:'/measure', message}` naming the two values (mismatched units → "use the same unit for both"); (b) preset slugs unique within each of shadows/gradients/duotones → path names the duplicate; (c) `identity.slug` not one of the reserved WP theme dirs (`twenty*` prefix) and not `x-companion`.

- [ ] **Step 1: Write `pipeline/tests/theme-spec.test.mjs`** — a valid fixture spec passes `validateSchema(contract, spec)` + `themeSpecChecks`; an unknown skeleton (`"floating"`) fails schema NAMING the enum values in the validator's message (M1 acceptance clause 2); `contentSize: "1400px", wideSize: "900px"` fails the cross-check; duplicate shadow slugs fail; mismatched units (`70ch` vs `1200px`) fail with the units message. Run: expect FAIL (no schema, no lib).
- [ ] **Step 2: Write the two schema files (identical bytes) + `pipeline/lib/theme-spec.mjs`.** Run: `node --test pipeline/tests/theme-spec.test.mjs` → PASS.
- [ ] **Step 3: Extend `x-agent/tests/schemas.test.ts`** byte-identity pin: `contract/schemas/theme-spec.schema.json` === `x-agent/schemas/theme-spec.schema.json`. Run vitest → PASS.
- [ ] **Step 4: Create `PROGRESS.theme-factory.json`**; commit all.

### Task 2: The scaffolder — `x-agent/templates/block-theme/` + `themeFactory.ts` scaffold + `wp_theme_scaffold` (milestone M1)

**Files:**
- Create: `x-agent/templates/block-theme/style.css` (`{{name}}`, `{{slug}}`, `{{description}}` header, `Version: 1.0.0`, `License: GPL-2.0-or-later`, `Requires at least: 6.5`)
- Create: `x-agent/templates/block-theme/templates/{index,page,page-no-title,canvas}.html` — static structural markup (header/footer template-part refs + main group + post-title/post-content; canvas = post-content only)
- Create: `x-agent/templates/block-theme/templates/rail/{index,page,page-no-title}.html` — rail overlay: main row group with the content column + `<!-- /wp:template-part {"slug":"rail","tagName":"aside"} -->` sized by `var(--wp--custom--rail-width)`
- Create: `x-agent/templates/block-theme/parts/{header,footer,rail}.html` — minimal placeholders (S4/S8 furniture replaces content at publish)
- Create: `x-agent/templates/block-theme/functions-rail.php` — rail skeleton ONLY (emitted as `functions.php`): registers the `rail` area via `default_wp_template_part_areas` (`area_tag: 'aside'`); custom areas silently coerce to `uncategorized` without this (decision 12). Static file, `{{textdomain}}` only.
- Create: `x-agent/mcp/src/themeFactory.ts` — `export interface ThemeSpec`, `export const ThemeSpecSchema` (zod mirror of the contract), `export function scaffoldTheme(spec: ThemeSpec, opts: {dir?: string, force?: boolean}): {dir, slug, name, files: string[], rail_width?: string}`, `export function buildThemeJson(spec): object`, `export const RAIL_WIDTH = '20rem'`
- Create: `x-agent/mcp/src/tools/themeScaffold.ts` — `wp_theme_scaffold` (`local: true`; input `{spec: ThemeSpec, dir?, force?}`; output `{dir, slug, name, files, rail_width?}`)
- Modify: `x-agent/mcp/src/registry.ts` (import + spread `themeScaffoldTools`)
- Create: `x-agent/tests/theme-factory.test.ts` (offline; `factory.test.ts` mold: mkdtemp workspace)

**Interfaces:**
- Consumes: Task 1's contract (zod mirror must accept exactly what the JSON schema accepts — pin with a shared valid/invalid fixture pair).
- Produces: a complete theme dir. `buildThemeJson(spec)` emits (theme.json v3): `settings.layout.{contentSize,wideSize}` from measure; `styles.spacing.blockGap` + `settings.spacing.blockGap` from physics; `styles.spacing.padding` from rootPadding + `settings.useRootPaddingAwareAlignments: true`; `settings.appearanceTools: true`; `settings.typography.fluid: true`; `settings.shadow.presets`, `settings.color.gradients`, `settings.color.duotone` from presets; `settings.custom` from presets.custom (+ `railWidth: RAIL_WIDTH` iff skeleton rail); `customTemplates: [{name:'page-no-title', title:'Page (no title)', postTypes:['page']}, {name:'canvas', title:'Canvas', postTypes:['page']}]`; `templateParts: [{name:'header', area:'header', title:'Header'}, {name:'footer', area:'footer', title:'Footer'}]` + rail part iff rail. Stable key order, `JSON.stringify(obj, null, '\t')` — byte-determinism.

- [ ] **Step 1: Write failing tests** in `theme-factory.test.ts`:
    - a fixture ThemeSpec (stacked) scaffolds → files exactly `[style.css, theme.json, templates/index.html, templates/page.html, templates/page-no-title.html, templates/canvas.html, parts/header.html, parts/footer.html]`; scaffolding twice into two dirs → byte-identical trees (M1 clause 1);
    - skeleton `rail` → `parts/rail.html` present + rail templates used + `rail_width === '20rem'`; `stacked` → no rail file (M1 clause 2);
    - zod `ThemeSpecSchema` rejects unknown skeleton naming the enum;
    - **poisoned-spec test** (M1 clause 3): every string field of the spec set to a unique sentinel (`XPOISON-name`, `XPOISON-desc`, …) → grep every scaffolded file: sentinels appear ONLY in `style.css` + `theme.json`, and only the identity/description/preset-value sentinels at that;
    - slug guards: traversal (`../x`), uppercase, reserved → structured throw.
- [ ] **Step 2: Run** vitest → FAIL (module absent).
- [ ] **Step 3: Implement** templates + `themeFactory.ts` (reuse `interpolate`, `assertSlug`-style guards — import from `factory.js` where exported, else local equivalents) + tool shell + registry spread.
- [ ] **Step 4: Run** vitest → PASS. `npm run build` clean.
- [ ] **Step 5: Commit**; tick M1 progress (evidence: test names).

### Task 3: The build gate — `wp_theme_build_test` with measured physics (milestone M2, sandbox half)

**Files:**
- Modify: `x-agent/mcp/src/themeFactory.ts` — add `buildAndTestTheme(input): Promise<ThemeBuildResult>` + `packageTheme` + `inspectThemePackage`
- Create: `x-agent/mcp/src/tools/themeBuildTest.ts` — `wp_theme_build_test` (`local: true`)
- Modify: `x-agent/mcp/src/registry.ts`
- Modify: `x-agent/tests/theme-factory.test.ts` (offline: packaging/inspect); Create: `x-agent/tests/live/theme-factory.test.ts` + `x-agent/tests/live/theme-setup.sh` (opt-in, `X_AGENT_THEME_LIVE=1`, ports 9480-9489)

**Interfaces:**
- Input `{dir, port?, timeout_ms?}`; output `{built, smoke: {activated, templates_resolved: string[], page_no_title_present, front_html_ok, php_error?}, measured?: {root_gap_px, root_padding, content_width_px, expected_content_px, wide_width_px, viewport_px}, zip_path?, failure?: {code:'build_failed'|'smoke_failed', message, hint}}`.
- Mechanics (SMOKE_RUNNER mold, `factory.ts` L1437-1529): port from `freePort` over `X_AGENT_THEME_SMOKE_PORT_RANGE` default `[9480,9489]`; playground `runCLI` mounting `{hostPath: dir, vfsPath: '/wordpress/wp-content/themes/<slug>'}` with blueprint steps `[{step:'activateTheme', themeFolderName: slug}]`; PHP probes (the `SmokeConfig.probes` seam): active stylesheet === slug, `get_block_template('<slug>//page-no-title')` non-null (M2 clause 2 poisons this), each roster template resolves, create+publish a physics page (two paragraphs + one `align:full` group + one `align:wide` group), echo permalink; Playwright pass: goto permalink; evaluate → root children vertical gaps of `.wp-site-blocks` (`root_gap_px`, must be 0±1), computed root padding vs declared, paragraph width vs declared contentSize resolved to px in-page (temp div `width: <declared>`), full group ≈ viewport, wide group ≈ wideSize resolved. Gate in the tool: any measured physics off → `built:false, failure:{code:'smoke_failed', ...}` naming the number. Zip only on pass.

- [ ] **Step 1: Offline failing tests**: `packageTheme` zip has single root dir === slug, deterministic bytes for same input; `inspectThemePackage` rejects >5MB / traversal entries / missing style.css / missing templates/index.html, naming reasons. Run → FAIL.
- [ ] **Step 2: Implement packaging/inspection**; vitest offline PASS.
- [ ] **Step 3: Live test** (gated): scaffold fixture spec → `buildAndTestTheme` → `built:true`, `measured.root_gap_px === 0`, content clamped (M2 clause 1); poisoned spec (delete page-no-title from the scaffolded dir before the call) → failure NAMING the template (M2 clause 2). Implement runner + tool; run live suite → PASS.
- [ ] **Step 4: `npm run build`; commit.**

### Task 4: The companion route — `POST /x-companion/v1/themes/install` (milestone M2, instance half)

**Files:**
- Create: `x-companion/includes/class-theme-library.php` (`X_Companion_Theme_Library`)
- Modify: `x-companion/includes/class-rest.php` (`DISPATCHED_ROUTES` + `register_theme_routes()` + `route_themes_install()` shim)
- Create: `x-companion/tests/test-themes.php` (live, `test-install.php` mold); Modify: `x-companion/tests/run-all.sh` (wire it) + `x-companion/fixtures/packages/build.sh` (build a valid + a poisoned theme zip fixture)

**Interfaces:**
- Route: extend tier (`permission_extend` — posture 403 ahead of capability), multipart field `package`. Behavior: `analyze_theme_package` (≤5MB, safe entries, exactly one root dir = slug, `style.css` with `Theme Name:` header, `theme.json` parses if present, `templates/index.html` exists, every `templates/*.html` + `parts/*.html` non-empty) → staged unzip under `get_theme_root() . '/.agent-staging-<slug>-<rand>'` → move to `get_theme_root() . '/<slug>'` (existing same-slug theme moved to backup first, restored on failure) → `switch_theme($slug)` → verify `get_stylesheet() === $slug` → response `{installed: {slug, name, version}, fingerprint: X_Companion_Manifest::fingerprint(true), replaced_previous}`. Policy violations → 422 `{code:'invalid_theme_package', data.reasons[]}`. All fs via `WP_Filesystem`; own `is_managed_theme_path()` fence (only `<slug>` it staged + `.agent-staging-*` under the theme root). `switch_theme` already busts the manifest cache (`class-manifest.php` L81); compute the returned fingerprint AFTER activation.
- The ONE pledge-breaking surface — the class docblock records it, citing the spec (`core REST cannot upload themes`).

- [ ] **Step 1: Fixtures + failing live test**: valid zip installs+activates and moves the fingerprint; re-install same slug → `replaced_previous: true`; poisoned zip (no `templates/index.html`) → 422 naming the file; production-posture instance → 403 `posture_forbidden` (boot second instance, `test-install.php` does the same).
- [ ] **Step 2: Implement** class + rest wiring. Run `php x-companion/tests/test-themes.php --runtime tools/.runtime/<slot>.json` → PASS. `bin/plugin-check.sh` still clean.
- [ ] **Step 3: Commit.**

### Task 5: Manifest theme identity + `wp_theme_install` + the companion client (milestone M2, agent half)

**Files:**
- Modify: `x-companion/includes/class-manifest.php` (`build()` gains `'theme' => array('slug','name','version')` from `active_theme()` + `wp_get_theme()->get('Name')`)
- Modify: `contract/schemas/manifest.schema.json` + `x-agent/schemas/manifest.schema.json` (optional `theme` object — optional so old fixtures stay valid)
- Modify: `x-agent/mcp/src/schemas.ts` (`ManifestSchema` + `theme: z.object({slug, name, version}).strict().optional()`)
- Modify: `x-agent/mcp/src/companion.ts` — extract `private async installPackage(route: string, zipPath: string): Promise<{fingerprint: string, [k:string]: unknown}>` from the two existing copies; add `installThemeFromFile(zipPath)` → `POST /themes/install`
- Create: `x-agent/mcp/src/tools/themeInstall.ts` — `wp_theme_install {zip_path}` mirroring `blockInstall.ts` L55-120 exactly: `inspectThemePackage` → posture gate → `installThemeFromFile` → manifest refresh → conditional session reload → `{installed, fingerprint, previous_fingerprint, manifest_refreshed, session_reloaded}`
- Modify: `x-agent/mcp/src/registry.ts`; `x-agent/tests/mock-companion/index.ts` (+`POST /themes/install` bumping the fingerprint) + `fixtures.ts` (manifest gains `theme`)
- Modify: `x-agent/tests/theme-factory.test.ts` (tool-surface test via `callTool` against the mock)

- [ ] **Step 1: Failing tests**: mock-companion `wp_theme_install` happy path returns NEW fingerprint ≠ previous; refuses on mock production posture with `posture_forbidden`; `wp_manifest` output now carries `theme.name` (mock fixture). Multipart refactor: existing block/schema install tests still green (regression pin).
- [ ] **Step 2: Implement**; vitest PASS; PHP offline manifest test (`test-manifest.php`) extended for the `theme` key → PASS.
- [ ] **Step 3: `npm run build`; commit**; tick M2 progress with live evidence from Tasks 3-5.

### Task 6: Pipeline plumbing — `--bespoke`, optional `theme` task, budget T (milestone M3, plumbing half)

**Files:**
- Modify: `pipeline/lib/config.mjs` (`OPTIONAL_TASK_TYPES = ['theme']`; `loadPipelineConfig` shape-validates optional entries when present)
- Modify: `pipeline/providers/index.mjs` (iterate `[...TASK_TYPES, ...OPTIONAL_TASK_TYPES]`)
- Modify: `pipeline/lib/site.mjs` (`defaultBuildConfig` writes `tasks.theme = {provider, model, effort: 'high'}`)
- Modify: `pipeline/cli.mjs` (boolean `'bespoke'` at L468; HELP; preflight at the L402-414 block: `--bespoke` without `--new-site` → `preflight_failed` "\-\-bespoke summons a bespoke theme for a NEW site only — it is valid only alongside --new-site"; when bespoke, assert `config.tasks.theme` present naming the task; pass `bespoke: !!flags.bespoke`)
- Modify: `pipeline/run.mjs` (signature, `state.bespoke`, `'theme'` run-dir, STAGE_INFO `S1T_theme`)
- Modify: `pipeline/budget.mjs` (`computeBudget(brief, {bespoke, rail})` per Pipeline facts; `BudgetMeter.setCeiling` re-issuable)
- Modify: `pipeline/stages/s1-brief.mjs` (call site + `T=` in the printed line when bespoke)
- Modify: `pipeline/lib/report.mjs` (PREDICTED.theme, ceiling sentence gains `+ T=` term)
- Tests: extend `pipeline/tests/{budget,cli,config,run}.test.mjs`

- [ ] **Step 1: Failing tests**: `computeBudget(brief, {bespoke:true})` ceiling = old+2 (T in base, doubled); `{bespoke:true, rail:true}` → F=3; `computeBudget(brief)` byte-equal to today's (regression); config: `theme` entry absent → loads fine; malformed `theme` entry (missing model) → `preflight_failed`; cli preflight: bespoke-without-new-site throws naming the rule (unit-test the extracted check or via parseArgs+build guard); run.mjs: `state.bespoke` persists and a resume without the flag keeps it (synthetic-stages test).
- [ ] **Step 2: Implement; `node --test` PASS; commit.**

### Task 7: The stage — `pipeline/prompts/theme.md` + `pipeline/stages/s1t-theme.mjs` (milestone M3)

**Files:**
- Create: `pipeline/prompts/theme.md` — frontmatter `task_type: theme`, `required: [identity_note, pages_note, combo_note, skeleton_vocabulary, contract_note, repair_note]`. Body: the mission (you author the parameter object for the GROUND — the theme everything stands on; structure only, no patterns, no block styles, no fonts), the skeleton vocabulary verbatim from the spec (stacked/split/rail with "the UI style's cues argue the skeleton"), measure guidance ("an editorial serif argues ~70ch; a luxury canvas argues wide" — the 645px era ends here), physics guidance (own the blockGap; root padding is the site's breathing), presets guidance (slug-addressable vocabulary the tree lane may legally spend; author only what the combo argues for), `{{contract_note}}` with the schema, `{{repair_note}}` last.
- Create: `pipeline/stages/s1t-theme.mjs`:
    ```
    id 'S1T_theme', kind 'gated-generative'
    run(ctx):
      if (!ctx.state.bespoke) { ctx.log('inherited theme — the instance\'s own theme remains the law'); return; }
      payload = { identity_note (brief identity + art_direction), pages_note (per page: title + section roles), combo_note (renderStyleNote + BOTH rosters' cue entries), skeleton_vocabulary, contract_note {note, schema}, repair_note: '' }
      spec = llm.generate({task_type:'theme', label:'theme', payload, validate: v => [...validateSchema(contract, v), ...themeSpecChecks(v)]})   // maxAttempts 2 = the schema retry
      scaffold = call('wp_theme_scaffold', {spec, dir: join(runDir,'theme'), force:true}) → throw preflight_failed on !ok
      build = call('wp_theme_build_test', {dir: scaffold.dir}) 
      if !build.data.built → ONE repair: llm.generate({task_type:'theme', label:'theme/repair', maxAttempts:1, payload:{...same, repair_note: REPAIR_NOTE(prevSpec, build.data.failure/measured)}}) → re-scaffold (force) → re-build-test; second failure → throw PipelineError('preflight_failed', 'no ground, no site: the bespoke theme failed its build gate twice', hint, {failure})
      install = call('wp_theme_install', {zip_path: build.data.zip_path}) → throw on !ok
      if skeleton === 'rail' → the budget bump (decision 2), re-print line
      write runDir/theme/theme-spec.json; state.theme = {slug, name, skeleton, measure: spec.measure, rail_width, fingerprint: install.data.fingerprint, zip: build.data.zip_path}; state.fingerprint = install.data.fingerprint
      log('the ground is bespoke: "<name>" (<skeleton>) at <contentSize>/<wideSize> — fingerprint <fp>')
    ```
- Modify: `pipeline/run.mjs` (splice `s1t` into DEFAULT_STAGES between s1 and s2)
- Create: `pipeline/fixtures/fake/theme.theme.json` (a full valid ThemeSpec `{text, usage}` — stacked, 70ch/1080px measure, one shadow+gradient preset)
- Create: `pipeline/tests/s1t-theme.test.mjs` (s3-tokens.test.mjs ctx mold)

- [ ] **Step 1: Failing tests**: non-bespoke ctx → zero llm calls, zero tool calls, one log line (M3 clause 1's stage half); bespoke happy path → exactly 1 ledger `theme` entry, tool calls `[wp_theme_scaffold, wp_theme_build_test, wp_theme_install]` in order, `state.theme` populated, fingerprint adopted; build-test fails once → repair call (`maxAttempts:1`) + re-scaffold + second build-test → success; build fails twice → `preflight_failed` thrown, 2 theme ledger entries; rail spec → `budget.F === 3` and ceiling bumped (M3 clause 2); resume: `state.completed` containing S1T_theme never re-enters (synthetic-stage run.test addition — M3 clause 3).
- [ ] **Step 2: Implement; `node --test` PASS.**
- [ ] **Step 3: Ledger-diff regression** (M3 clause 1): run the fake-provider pipeline twice via the existing determinism harness path (`runPipeline({stages, skipToolchain:true})` fixture run or accept script), once on this branch, once against the pre-spec behavior — assert a non-bespoke run's ledger is byte-identical (timestamps excepted). Cheapest honest form: `pipeline/tests/s1t-theme.test.mjs` asserts the non-bespoke stage writes nothing to ledger/budget, plus the accept script diff in Task 12.
- [ ] **Step 4: Commit; tick M3.**

### Task 8: Skeleton into S4 — payloads, rail furniture, prompts (milestone M4, authoring half)

**Files:**
- Modify: `pipeline/stages/s4-sections.mjs` — `const skeleton = ctx.state.theme?.skeleton ?? 'stacked'`; `skeleton` + `pane_note` keys in section payload (pane_note documents primary/secondary when split, `''` otherwise) and `skeleton` in furniture payload; split section gate: root `metadata.pane` ∈ {primary, secondary} required when split (a `screenPaneDeclaration` pushed into the existing validate array); rail: `PART_NOTES.rail` ("a persistent side rail — compact navigation/contact/list furniture, designed for a narrow column"), fan-out arm, `bandColors('base')` for rail, `railShape(v)` gate (one root group, no full-bleed alignment demand — the rail owns its column)
- Modify: `pipeline/prompts/tree.md` + `pipeline/prompts/furniture.md` — `{{skeleton}}` + `{{pane_note}}` (tree only) + required entries
- Modify: `pipeline/tests/s4-sections.test.mjs`

- [ ] **Step 1: Failing tests**: stacked ctx (no state.theme) → payloads carry `skeleton: 'stacked'`, prompts render (template required-fields satisfied), NO rail call (fan-out length = sections+2); rail ctx → fan-out includes `furniture/rail` labeled call and `state.artifacts.furniture.rail` written (M4 clause 2's authoring half); split ctx → a section tree without `metadata.pane` fails its gate naming the field, with pane passes.
- [ ] **Step 2: Implement; PASS; commit.**

### Task 9: Skeleton into S8 — rail part publish + split pane assembly (milestone M4, publish half)

**Files:**
- Modify: `pipeline/stages/s8-publish.mjs` — furniture part write loop generalizes over `state.artifacts.furniture` entries (header/footer today, + rail with `area:'rail'`); split assembly: before compile, wrap the page's section trees into the deterministic pane frame (one `core/group` `align:'full'`, `layout:{type:'flex', flexWrap:'nowrap', verticalAlignment:'top'}`, children: two `core/group`s classNames `x-pane-primary`/`x-pane-secondary`, `layout:{type:'default'}`, sections routed by their `metadata.pane`, brief order preserved) — pure function `assembleSplitPage(sectionTrees)` in `pipeline/lib/gates.mjs`-adjacent new home `pipeline/lib/skeleton.mjs` so it unit-tests without S8
- Create: `pipeline/lib/skeleton.mjs` — `assembleSplitPage(trees) -> tree[]`, `SKELETON_VOCABULARY` (the prompt text, shared with s1t), `paneOf(tree)`
- Modify: `pipeline/tests/s8-s9-publish.test.mjs`

- [ ] **Step 1: Failing tests**: `assembleSplitPage` with trees declaring primary/primary/secondary → one full flex root, two panes, order preserved, classNames right; s8 with a rail furniture artifact writes a third template part with `area:'rail'` (ctx.rest capture assert); stacked run's s8 rest calls byte-identical to before (regression pin on the recorded call list — M4 clause 3's publish half).
- [ ] **Step 2: Implement; PASS; commit.**

### Task 10: Skeleton into S9 — pane-aware audits (milestone M4, verify half)

**Files:**
- Modify: `pipeline/lib/gates.mjs` — `screenBandWidths(boxTree, {viewportWidth, skeleton = 'stacked', railWidth})`: stacked = today byte-for-byte; split = bands audited against their PANE's box width (locate pane boxes by `x-pane-*` in selector_path; a band spanning ~viewport when its pane is narrower FAILS — the fixture assertion of M4 clause 1), header/footer agreement unchanged, panes exempt from the full-viewport demand; rail = rail part audited against `railWidth` ±8 and EXEMPT from the header/footer width-agreement pair (which otherwise stays); `screenBandSeams(boxTree, {skeleton})`: split → seams audited per pane column (y-sort within each pane + the furniture row), stacked/rail unchanged
- Modify: `pipeline/stages/s9-verify.mjs` — pass `{skeleton: ctx.state.theme?.skeleton ?? 'stacked', railWidth: ctx.state.theme?.rail_width}` into both screens
- Modify: `pipeline/tests/gates.test.mjs` (fixture box trees per skeleton)

- [ ] **Step 1: Failing tests**: split fixture (two panes 60/40, bands spanning their panes) → clean, same fixture judged with a viewport-width expectation → fails (proving the pane-awareness is load-bearing, M4 clause 1); band overflowing its pane → `band_width` failure naming the pane; rail fixture (rail 320px beside content) → clean under rail skeleton, `band_width` failure under stacked (regression direction); rail ≠ declared width → failure; stacked fixtures → outputs byte-identical to today (M4 clause 3).
- [ ] **Step 2: Implement; PASS; commit; tick M4** (fixture-level; live evidence rides Task 15).

### Task 11: The widened tokens contract — `families[].source` + `families[].fontFace` across every copy

**Files:**
- Modify: `contract/schemas/design-tokens.schema.json` — families items gain optional `source: {provider: const "google", family: string minLength 1, weights: array minItems 1 items integer 100..900}` and optional `fontFace: array items {fontFamily, fontStyle, fontWeight: string, src: array of string minItems 1}` — ALL inside the validator subset (no anyOf; `src` is array-only because the pipeline constructs it)
- Modify: `x-agent/schemas/design-tokens.schema.json` + `x-companion/fixtures/schemas/design-tokens.schema.json` (byte-identical — the existing pin test enforces)
- Modify: `x-agent/mcp/src/schemas.ts` `TypographySchema` (zod mirrors of both fields, `.strict()`)
- Modify: `x-agent/templates/theme-json/emitter.ts` — `ThemeJsonFontFamily` gains optional `fontFace`; `emitThemeJsonSettings` passes `fontFace` through to `typography.fontFamilies` entries and DROPS `source` (agent-side-only); `diffAgainstThemeTokens` ignores `source`
- Modify: `x-companion/includes/class-theme-tokens.php` `compile()` families branch — pass a sanitized `fontFace` through (fontFamily/fontStyle/fontWeight strings, src array of esc_url_raw'd strings); keep ignoring `source`
- Modify: `pipeline/prompts/tokens.md` — replace "system stacks (no font files)" with: fontFamily remains the full fallback stack AND the rendered promise; a family MAY carry `source: {provider:'google', family, weights}` when the combo argues real typography; never author `fontFace` (pipeline-owned)
- Modify: `pipeline/lib/tokens.mjs` `tokenChecks` — model-authored `fontFace` is an issue ("fontFace is pipeline-owned — declare source instead"); `source.family` must be non-empty and weights sane
- Tests: `x-agent/tests/schemas.test.ts` (zod accepts source'd family; byte-identity pins now cover the widened copies), `pipeline/tests/s3-tokens.test.mjs` (tokenChecks rejects model fontFace), companion `test-tokens.php` (fontFace round-trips into the global-styles write)

- [ ] **Step 1: Failing tests → Step 2: implement all copies together → all three suites PASS → commit.**

### Task 12: The font lane — `pipeline/lib/fonts.mjs` (download + cache + Font Library install)

**Files:**
- Create: `pipeline/lib/fonts.mjs`
- Create: `pipeline/tests/fonts.test.mjs` (offline: `fetchImpl` + `rest` both stubbed)

**Interfaces (all injectable for tests):**
```
export const FF39_UA = 'Mozilla/5.0 (Windows NT 6.3; rv:39.0) Gecko/20100101 Firefox/39.0';
export function parseCss2Faces(css) -> [{weight, style, url}]            // regex over @font-face blocks
export function gstaticVersion(url) -> 'v20'                              // /s/<fam>/v20/… segment
export async function resolveGoogleFamily({family, weights}, {fetchImpl, log}) -> {family, version, license, faces}
    // css2 (FF39 UA) → faces; metadata/fonts/<Family> (strip ^)]}' guard) → license id; license fetch failures → 'unknown' + log, never throw
export async function ensureCached(resolved, {cacheDir, fetchImpl, log}) -> {dir, files:[{weight, style, path, bytes, sha256}], cache:'hit'|'miss'}
    // dir = <cacheDir>/<slug>@<version>/ ; meta.json records sha256s — a hit re-verifies hashes; LICENSE.txt written beside woff2s (or LICENSE-UNKNOWN.txt note)
export async function installFontFamilies({families, rest, cacheDir, fetchImpl, log}) -> {entries, fontFacesBySlug}
    // families = tokens families WITH source. Per family: resolve → cache → GET /wp/v2/font-families?slug= (reuse id on hit) or POST create
    //   {font_family_settings: JSON.stringify({name, slug, fontFamily}), theme_json_version: 3}
    // → GET nested font-faces (skip weights already present) → per missing weight POST multipart
    //   {multipart: [{name:'font_face_settings', value: JSON.stringify({fontFamily: source.family, fontStyle:'normal', fontWeight: String(w), fontDisplay:'swap', src:'file-0'})}, {name:'file-0', filePath}]}
    // → collect returned font_face_settings.src (uploaded URL) → fontFacesBySlug entries {fontFamily, fontStyle, fontWeight, src:[url]}
    // entries (the REPORT record): {slug, family, version, license, weights, bytes, cache, family_id}
export function enrichFamilies(families, fontFacesBySlug) -> families with fontFace added on sourced entries (source itself NOT included — the tool payload strips it)
```
Failure discipline: a font-lane failure is a RUN failure (`PipelineError('font_failed', ...)`) — "a tokens family with a source is a PROMISE"; but license-text fetch specifically degrades (decision 13). No ledger writes anywhere. Downloads only on cache miss (determinism clause).

- [ ] **Step 1: Failing tests** (stub fetch serving a canned css2 body + metadata + woff2 bytes; stub rest recording calls): parseCss2Faces extracts 2 weights; cache miss downloads + writes LICENSE + meta.json, second call is a `hit` with ZERO fetch calls (M5 cache clause); install creates family once (slug-reuse path asserted with a stubbed existing family), one multipart POST per missing weight with `font_face_settings` as a STRING part and the file part named in src; `enrichFamilies` output carries fontFace and never source; corrupted cache (bad sha256) re-downloads.
- [ ] **Step 2: Implement; PASS; commit.**

### Task 13: The S3 hook — install, enrich, apply, record (milestone M5, pipeline half)

**Files:**
- Modify: `pipeline/stages/s3-tokens.mjs` — after the dry-run gate, before the real apply: `const sourced = (raw.typography?.families ?? []).filter(f => f.source);` if any: `const rest = ctx.rest ?? createRest(readConnection(process.cwd())); const {entries, fontFacesBySlug} = await installFontFamilies({families: sourced, rest, cacheDir: join(process.cwd(),'tools/.runtime/fonts'), log: ctx.log});` → tool-bound families = strip `source`, merge `fontFace` via `enrichFamilies` → real `wp_tokens_apply` → `ctx.state.fonts = entries` → `tokens.json` written as the RAW contract-valid tokens (source preserved — S9 reads it); the families strip mirrors the sizes strip (`s3-tokens.mjs:49-59`)
- Modify: `pipeline/lib/report.mjs` — `## Fonts` section from `state.fonts` (family, version, license, weights, bytes, cache hit/miss); nothing when empty
- Modify: `pipeline/tests/s3-tokens.test.mjs`

- [ ] **Step 1: Failing tests**: sourced-family tokens → font lane invoked BEFORE the apply call (ctx.call order asserted), apply payload families carry fontFace and NOT source, `state.fonts` recorded, ledger has exactly the 1 tokens entry (no font entries — M5 clause 3), tokens.json on disk still carries source; sourceless tokens → zero rest calls, behavior byte-identical (regression); font-lane throw → run fails `font_failed` before any apply.
- [ ] **Step 2: Implement; PASS; report section renders; commit.**

### Task 14: The rendered promise — oracle fonts + `screenFontFamilies` (milestone M5, verify half)

**Files:**
- Modify: `x-agent/mcp/src/oracle.ts` — `ComputedBits` + the L461-466 collection gain `fontFamily`; `extractLayout`'s evaluate additionally returns `fonts: [{family, status}]` from `document.fonts` (await `document.fonts.ready` with a 3s race first)
- Modify: `x-agent/mcp/src/tools/verify.ts` — `computed.fontFamily` + top-level `fonts` in `OutputSchema`; `x-agent/mcp/src/registry.ts` L163 mirror
- Modify: `pipeline/lib/gates.mjs` — `export function screenFontFamilies({box_tree, fonts}, sourcedFamilies)`: per sourced family NAME: some `fonts[]` entry `family === name && status === 'loaded'` AND some box_tree node whose `computed.fontFamily` FIRST entry (quotes stripped) === name; else `{code:'font', message:'sourced font "<name>" never rendered — the promise fell back to the stack (an uninstalled font is an unloaded image)'}`
- Modify: `pipeline/stages/s9-verify.mjs` — read `tokens.json`, collect `source.family` names, push `...screenFontFamilies(verify, sourced)`
- Tests: `pipeline/tests/gates.test.mjs` fixtures; `x-agent/tests/` schema pin for the widened verify output

- [ ] **Step 1: Failing tests**: fixture verify data with loaded font + matching computed → clean; `status:'unloaded'` → font failure naming the family; loaded in document.fonts but NO box_tree node rendering it → failure (the silent-stack case); zero sourced families → screen returns `[]` (byte-identical S9 for sourceless runs).
- [ ] **Step 2: Implement (oracle + zod + gates + s9); `npm run build`; both suites PASS; commit; tick M5 unit-level.**

### Task 15: Acceptance scripts + live evidence (milestones M1-M6 acceptance)

**Files:**
- Create: `pipeline/tests/accept/tf-m1.sh` — offline: theme-spec tests + scaffold determinism (two scaffolds byte-diffed) + poisoned-spec grep; `echo "TF-M1 ACCEPTED"`
- Create: `pipeline/tests/accept/tf-m2.sh` — live (Playground on the pipeline-accept slot 9410 + theme sandbox range): fixture ThemeSpec → scaffold → `wp_theme_build_test` (built:true, measured physics printed + asserted) → `wp_theme_install` → fingerprint moved + `wp_manifest` returns the bespoke measure and theme name; the page-no-title poison → build gate failure naming the template
- Create: `pipeline/tests/accept/tf-m3.sh` — fake-provider `--bespoke --new-site` run to `--until S1T_theme`: ceiling line includes T=1 (grep); `--bespoke` without `--new-site` exits naming the rule; non-bespoke fake run's `ledger.json` diffed byte-identical vs a `main`-checkout reference run (timestamps excepted); `--resume` after S1T → zero new ledger entries, zero installs (companion log/fingerprint stable)
- Create: `pipeline/tests/accept/tf-m4.sh` — the pipeline unit fixtures (gates + s4 + s8 suites) + a fake-provider split-skeleton run through S4 with pane declarations in the fixtures
- Create: `pipeline/tests/accept/tf-m5.sh` — live: tokens fixture with a sourced Google family → S3 path (cache miss then hit asserted on a second run) → front page: every `@font-face` src under `uploads/fonts`, ZERO `fonts.googleapis.com|fonts.gstatic.com` occurrences in served HTML+CSS (curl grep — the mechanical no-hotlink assertion), S9 green; then the activation-strip poison → S9 fails naming the font; report lists family+version+license; `grep -c '"task_type": "font"' ledger.json` = 0
- Create: `pipeline/tests/accept/tf-m6.sh` — the whole promise: one prompt + `--new-site --bespoke` (real provider from pipeline.config.json) → named theme in wp-admin (REST themes list), bespoke measure in manifest, skeleton-matching structure, verified site, report clean; same prompt WITHOUT `--bespoke` → TT5-grounded build unchanged; `wp_snapshot` zip contains `theme/<slug>/`
- Modify: `PROGRESS.theme-factory.json` — evidence per milestone as scripts go green

- [ ] **Step 1: Write scripts (each `set -euo pipefail`, repo-root cd, dedicated slots, cleanup traps).**
- [ ] **Step 2: Run tf-m1, tf-m3, tf-m4 (no live spend); run tf-m2, tf-m5 against a fresh Playground; tf-m6 needs a real provider key — run if keys are present in `.x-agent.json`, else record as pending-live in PROGRESS with everything else green.**
- [ ] **Step 3: Commit; update PROGRESS milestones.**

### Task 16: Ship — docs, self-review, PR

- [ ] Update `pipeline/README.md` (the `--bespoke` mode, the font lane, one paragraph each) + `FLOW.md` (theme install route in the posture-wall list) + `x-companion` README route table if present.
- [ ] Full-suite gate: `cd x-agent/mcp && npm run build && npx vitest run` · `node --test pipeline/tests/*.test.mjs` · companion offline PHP tests · `git status` clean of strays.
- [ ] superpowers:verification-before-completion — evidence before claims.
- [ ] `ghe`-based PR: push `theme-factory`, open PR against `main` titled after the spec's commit voice ("the ground becomes an artifact — …"), body: what landed per milestone, the recorded decisions/deviations (1-14), test evidence, the one pledge-breaking companion surface called out.

## Self-review (spec coverage)

- ThemeSpec contract + gates → Tasks 1, 7. Scaffolder determinism + poison → Task 2. Build gate measured physics + page-no-title poison → Task 3. Companion route + posture → Task 4. Install + epoch + manifest name/measure → Task 5. `--bespoke` rules + budget T + resume → Tasks 6, 7. Skeleton into S4 payloads + rail furniture F=3 → Tasks 6 (budget), 7 (bump), 8. Split panes publish → Task 9. Pane-aware S9 + rail width + stacked byte-identity → Task 10. Widened tokens contract → Task 11. Agent-side download/cache/license → Task 12. Ledger-free install + report → Task 13. Rendered-promise verify → Task 14. Milestone acceptances M1-M6 → Task 15. Non-goals honored: no pattern corpus/block styles in the theme (templates are structural only, Task 2), no model-authored theme files (poison test), no CDN hotlink (tf-m5 grep), one companion surface (Task 4 docblock), no theme removal at run end (nothing removes it), theme generation never inferred (Task 6 preflight).
- Type consistency spot-check: `state.theme = {slug, name, skeleton, measure, rail_width?, fingerprint, zip}` consumed by s4 (`skeleton`), s8 (furniture loop unchanged — reads artifacts), s9 (`skeleton`, `rail_width`); `state.fonts` consumed by report + (names only) tf-m5. `wp_theme_scaffold` output `{dir, slug, name, files, rail_width?}` consumed by s1t; `wp_theme_build_test` `{built, smoke, measured, zip_path, failure}` consumed by s1t + tf-m2.
