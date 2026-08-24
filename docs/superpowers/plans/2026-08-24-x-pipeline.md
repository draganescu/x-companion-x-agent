# X Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `specs/pipeline.spec.json` — a deterministic, LLM-powered site compiler (`pipeline/`) over the existing x-agent MCP toolchain: fixed stages S1–S9, a call budget fixed after the brief, per-task provider routing, every artifact validated against a contract schema and shipped only through the existing wp_* gates.

**Architecture:** A plain-ESM `pipeline/` directory at repo root (no build step) that imports the compiled toolchain (`x-agent/mcp/dist/mcp/src/*.js`) and calls tool handlers in-process via `callTool(name, args, runtime)` with ONE `Runtime` instance per run (single holder of epoch state). Generative work goes through one `LlmProvider` interface (`complete(task_type, prompt, payload, opts) -> {text, usage}`); deterministic work groups the wp_* tools. Every stage reads inputs from and writes outputs to `runs/<ts>/`; `--resume` replays completed stages from disk.

**Tech Stack:** Node >= 20, plain `.mjs` ESM, `node --test` (node:test) for pipeline unit tests, no new npm dependencies (zod/playwright/etc. stay inside `x-agent/mcp`; providers use raw `fetch`). Live acceptance via `tools/playground/boot.mjs` Playground instances, following the `proof/` runner precedent.

**Spec:** `specs/pipeline.spec.json` (amends `specs/agent-plugin.spec.json`; sits beside `specs/canon-factory.spec.json` — read all three; base specs win on conflict).

## Global Constraints

Copied from the spec — every task's requirements implicitly include these:

- "Never bypass a gate to make a stage green. A stage that cannot pass wp_validate / wp_block_build_test / wp_schema_build_test fails with diagnostics in the run report."
- "Every provider call goes through the one LlmProvider interface. No provider SDK import outside pipeline/providers/."
- "Temperature and model ids are config, never hardcoded in a stage."
- "The budget module is consulted BEFORE every generative call; exceeding the ceiling is a thrown structured error, not a warning."
- Budget formula: `base = 1 (brief) + 1 (tokens) + S + B + P; ceiling = 2 * base + I`. Fixture check: S=3,B=1,P=1,I=2 → ceiling `2*(2+3+1+1)+2 = 16`.
- "There is no free-text output anywhere in the pipeline." Every generative task is (prompt template, JSON payload) → JSON (or file map for block/schema) validated against its contract. One schema-retry per call, metered.
- "No LLM-authored markup, ever" — models emit TreeIR and factory files; markup exists only as wp_compile output.
- "No provider-specific prompts: one template per task_type."
- "No hidden retries and no soft budgets: every call is in the ledger, the ceiling is hard."
- "No pipeline-owned state on the instance: runs/<ts>/ on disk is the only pipeline memory." Deliverable-purity applies.
- Prompts are excerpts of the skills (`x-agent/skills/wp-blocks/SKILL.md`, `x-agent/skills/wp-schema/SKILL.md`); a prompt file that contradicts its skill is a bug.
- `pipeline.config.json`: `{tasks: {<task_type>: {provider, model, temperature?}}, concurrency?, budget_hard_cap?}`. Missing task entries fail at preflight, not mid-run.
- Provider keys ride in `.x-agent.json` (`cerebras_api_key`, `anthropic_api_key`, `openai_api_key`), each optional, each registered as a secret on resolution.
- Indentation: 4 spaces (user rule). Repo git remote operations use `ghe`, not `gh`.
- The stage list and stage kinds are fixed by the spec: S1_brief (generative), S2_read_instance (deterministic), S3_tokens (generative), S4_sections (generative, S concurrent calls), S5_blocks (gated-generative, B), S6_schema_packages (gated-generative, P), S7_repair (generative, ≤1/failed artifact), S8_publish (deterministic + I image calls), S9_verify (deterministic).

## Toolchain facts the implementer must know (verified 2026-08-24)

**In-process tool invocation** (the spec's recorded decision — no fork, no second server):

```js
import { Runtime } from '../x-agent/mcp/dist/mcp/src/context.js';
import { callTool } from '../x-agent/mcp/dist/mcp/src/server.js';
import { loadExternalHandlers } from '../x-agent/mcp/dist/mcp/src/registry.js';

await loadExternalHandlers();               // MANDATORY once per process, BEFORE first call.
                                            // Without it wp_compile, wp_verify, wp_screenshot,
                                            // wp_block_scaffold, wp_block_build_test,
                                            // wp_block_install return {code:'not_implemented'}.
const runtime = new Runtime({ cwd });       // ONE per run — the single holder of epoch state.
const res = await callTool(name, args, runtime);
// res: { content: [{type:'text', text}], structuredContent?, isError? }
// success: !res.isError, JSON.parse(res.content[0].text) is the tool result
// failure:  res.isError,  JSON.parse(res.content[0].text) is {code, message, hint, ...extra}
await runtime.disconnect();                 // teardown (session, factory, client)
```

- `Runtime` resolves config per-field: tool args → `.x-agent.json` in `cwd` (NO upward walk) → env (`X_WP_URL`, `X_WP_USER`, `X_WP_APP_PASSWORD`). The pipeline deliberately uses `cwd: process.cwd()` so the standard repo-root `.x-agent.json` chain applies (spec: "Connection via the standard .x-agent.json chain") — unlike `proof/`, which isolates cwd.
- Error codes from tools: `https_required | posture_forbidden | harness_gap | epoch_mismatch | companion_unreachable | companion_error | invalid_input | build_failed | schema_policy | smoke_failed | not_implemented | internal`.
- **Diagnostics are NOT errors**: `wp_validate` returns success with `{valid, epoch_ok, diagnostics[]}` — gate on `data.valid` + mechanical screening, never on `isError`.
- **Asymmetric factory failures**: `wp_block_build_test` reports failure as a SUCCESS result `{built:false, failure:{code,message,hint}, ...}` with no `zip_path`; `wp_schema_build_test` THROWS (arrives as `isError:true` envelope, extra carries `smoke`/`build_log`). S5 and S6 need different failure detection.
- Diagnostics codes enum: `E_ATTR_ENUM, E_ATTR_TYPE, E_BINDING_UNBINDABLE, E_BINDING_UNKNOWN, E_EPOCH_MISMATCH, E_NEST_ANCESTOR, E_NEST_PARENT, E_TREE_SCHEMA, E_UNKNOWN_BLOCK, W_ATTR_UNKNOWN, W_HINT_ALLOWED_BLOCKS, W_HINT_TEMPLATE_LOCK, W_STATIC_NEEDS_HARNESS, W_STYLE_UNKNOWN`.
- `wp_tokens_apply` input is the four DesignTokens sections SPREAD at top level (`{palette, spacing, typography, layout, css?, dry_run?}`), NOT nested; output `{applied, dry_run, fingerprint, theme_json_preview, diff_against_instance: ThemeTokenDiff[], css_rejected?}` where `ThemeTokenDiff = {group, slug, kind:'missing_on_instance'|'value_differs', expected, actual}`.
- `manifest.theme_tokens` = `wp_get_global_settings()` subset `{color, spacing:{spacingSizes, spacingScale}, typography, layout:{contentSize, wideSize}}`. DesignTokens shape is `{palette:[{slug,name,color,role?}], spacing:{scale_unit, steps:[{slug,size}]}, typography, layout:{contentSize, wideSize}}` (see `sites/moulin-rouge/trees/tokens.json` for a real pass-through example).
- `wp_images_generate` input `{post_id, rest_base?, style?, model?, out_dir?, dry_run?}`, output `{found, generated, manifest_path?, images[], failures?}`; makes the Gemini calls internally (3 transport retries are NOT budget calls). `wp_images_apply {post_id, manifest_path?}` → `{uploaded, swapped, skipped, all_valid, link}`.
- `wp_block_scaffold` input `{slug, title, attributes?, render_intent, dir?, description?, version?, force?, interactivity?: 'none'|'view-script'|'interactivity-api', stylesheet?: bool}` → `{dir, ...}`. `wp_block_build_test {dir, sample_attributes?}` → `{built, smoke:{registered, rendered_html, php_error?, front?:{console_errors?, style_enqueued?, view_ready?, block_present?}}, style_warnings?:[{line,literal,text}], zip_path?, failure?}`.
- `wp_schema_scaffold` input `{slug, intent, post_types:[{slug,label,supports?,meta?,taxonomies?,public?,rewrite_slug?}], routes?, bindings?, force?}` → `{dir, slug, files, warnings}` (warnings = URL-map collisions → per spec these fail PREFLIGHT before any LLM call). `wp_schema_build_test {dir}` → `{built, smoke:{booted, types_registered, meta_in_rest, taxonomies_registered, routes, bindings_registered, uninstall_clean, php_error?}, zip_path?}` or throws.
- `wp_verify` input `{url? | markup?, wait?: 'load'|'domcontentloaded'|'networkidle', nav_timeout_ms?, viewport?, spec?...}`; on a single-PHP-worker Playground use `wait:'domcontentloaded'`. Returns `box_tree`, `a11y_outline: [{role,name,level?}]`, `images[]` (loaded state + natural size), `pass`.
- `wp_screenshot {url|markup, viewport?, out_path?, wait?, nav_timeout_ms?}` → full page by default.
- The Gemini image client (`x-agent/mcp/src/images/gemini.ts`) is the spec's reference LlmProvider shape: constructed with `{apiKey, model}`, one method, `{data, mimeType, ms}` back, internal transport retries, no opinions.
- Playground boot: `node tools/playground/boot.mjs --profile core-only --posture toolchain --port <p> --plugin ./x-companion` writes `tools/.runtime/core-only-toolchain.json` (mode 0600) with `{url, admin:{user, app_password, login_pass}, ...}`. Use a dedicated `slot` when the default slot may be in use. `tools/playground/stop.mjs --port <p>` stops it.
- Secrets: `registerSecret(value)` from `x-agent/mcp/dist/mcp/src/errors.js` adds to the process-wide redaction set — the pipeline registers the three provider keys itself (keeps "companion gains NO new surface" and one redaction layer).
- `x-agent/mcp` is `"type":"module"`; dist inherits it; imports inside dist resolve zod/playwright from `x-agent/mcp/node_modules`. Prerequisite: `cd x-agent/mcp && npm ci && npm run build` and `cd tools && npm i` must have been run once.
- House schema style: JSON Schema draft-07, `additionalProperties:false`; NO ajv (transitive only) — the repo precedent for validating against JSON Schemas without ajv is the tiny inline validator in `x-agent/tests/schemas.test.ts`.

## File Structure

```
pipeline/
    run.mjs                    # CLI entry: node pipeline/run.mjs "<prompt>" [--config p] [--resume dir] [--until STAGE]
    budget.mjs                 # computeBudget(brief), BudgetMeter, Ledger (spec names this file)
    lib/
        errors.mjs             # PipelineError {code, message, hint, extra}
        hash.mjs               # canonicalJson(), sha256()
        limit.mjs              # pLimit(n) — thunk-based semaphore (wpforge-inspired, ~20 lines)
        schema.mjs             # minimal draft-07 subset validator (house rule: no ajv)
        config.mjs             # pipeline.config.json load + preflight; .x-agent.json provider keys
        prompts.mjs            # template load (frontmatter: task_type, required) + render
        llm.mjs                # createLlm(): budget->provider->parse->contract->one metered schema-retry->ledger
        toolchain.mjs          # createToolchain(): Runtime + loadExternalHandlers + call() shim
        gates.mjs              # screenTreeDiagnostics(), blockGate(), schemaGate() — shared by S4/S5/S6/S7
        rest.mjs               # thin authed core-REST helper for S8 (pages, settings, navigation, template parts)
        report.mjs             # report.md writer
    providers/
        fake.mjs               # fixture-replay provider (deterministic tests; label-keyed like wpforge dryModel)
        anthropic.mjs          # raw fetch, Messages API
        openai.mjs             # raw fetch, chat completions
        cerebras.mjs           # raw fetch, OpenAI-compatible
    prompts/
        brief.md tokens.md tree.md block.md schema.md repair.md
    schemas/
        brief.schema.json      # the one NEW contract this spec introduces
    stages/
        s1-brief.mjs s2-read-instance.mjs s3-tokens.mjs s4-sections.mjs
        s5-blocks.mjs s6-schema-packages.mjs s7-repair.mjs s8-publish.mjs s9-verify.mjs
    fixtures/                  # fake-provider fixtures + brief fixtures for tests
    tests/
        *.test.mjs             # node --test unit tests (no instance, no network)
        accept/
            m1.sh m2.sh m3.sh m4.sh m5.sh m6-determinism.sh m6-swap.sh   # milestone acceptance
runs/                          # gitignored per-run artifact dirs
PROGRESS.pipeline.json         # progress protocol ledger (same schema as PROGRESS.canon-factory.json)
pipeline/config.example.json   # committed example; live pipeline.config.json is gitignored
```

Stage modules export `{id, kind, run(ctx)}` and nothing else (spec rule) — all shared logic lives in `pipeline/lib/`.

**Stage context (`ctx`)** built by `run.mjs`, one object threaded through all stages:

```js
ctx = {
    prompt,          // the user prompt, verbatim
    runDir,          // runs/<ts>/
    config,          // parsed pipeline.config.json
    call,            // (name, args) => {ok, data}   — in-process wp_* shim
    llm,             // async generate({task_type, label, payload, validate, maxAttempts?}) => {value, attempts}
    budget,          // BudgetMeter
    ledger,          // Ledger
    state,           // mutable, persisted to runs/<ts>/state.json after every stage:
                     //   {completed: [stageIds], brief?, budget?, fingerprint?, instance?,
                     //    sections?: [{id, page, ...}], artifacts?: {trees:{}, blocks:{}, packages:{}},
                     //    published?: {page_ids, nav_id}}
    log,             // (msg) => console.error(`[x-pipeline] ${msg}`)
}
```

**Testing seam:** unit tests build `ctx` by hand with a scripted `call` and the fake provider; the real `run.mjs` always binds `call` to `callTool` — gates are never bypassed in a real run. Live acceptance scripts run the real pipeline against a real Playground.

## Execution notes

- Work on branch `pipeline` off `main` (precedent: `canon-factory` branch). Invoke superpowers:using-git-worktrees at execution start; if isolation is impractical (Playground slots + committed dist + node_modules), branch-in-place on a clean tree is the fallback — record the decision in PROGRESS.pipeline.json.
- TDD throughout: every task writes its failing test first (`node --test pipeline/tests/<file>.test.mjs`), then implements, then commits. Commit format: `git commit -m "pipeline: <what>"`.
- PROGRESS.pipeline.json: copy the top-level shape of `PROGRESS.canon-factory.json` (read it first); append to `decisions[]` for every budget-formula decision and every place a stage was tempted to retry beyond its bound (the spec's temptation log).
- Live acceptance boots its own Playground on port 9410 with `slot pipeline-accept` so it never collides with dev instances on 9400.

---

### Task 1: Plumbing — errors, hash, limit, repo wiring

**Files:**
- Create: `pipeline/lib/errors.mjs`
- Create: `pipeline/lib/hash.mjs`
- Create: `pipeline/lib/limit.mjs`
- Create: `pipeline/package.json`
- Create: `PROGRESS.pipeline.json`
- Modify: `.gitignore` (append `runs/` and `pipeline.config.json`; create the file if the repo has none)
- Test: `pipeline/tests/plumbing.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `class PipelineError extends Error {code: string, hint: string, extra: object}`; `canonicalJson(value) -> string` (recursively key-sorted, `JSON.stringify` semantics); `sha256(text) -> string` (hex); `pLimit(max) -> (thunk) => Promise` (thunk-based semaphore — pass thunks, never live promises).

- [ ] **Step 1: Write the failing test**

```js
// pipeline/tests/plumbing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineError } from '../lib/errors.mjs';
import { canonicalJson, sha256 } from '../lib/hash.mjs';
import { pLimit } from '../lib/limit.mjs';

test('PipelineError carries code, hint, extra', () => {
    const e = new PipelineError('budget_exceeded', 'over', 'stop', { spent: 17 });
    assert.equal(e.code, 'budget_exceeded');
    assert.equal(e.message, 'over');
    assert.equal(e.hint, 'stop');
    assert.deepEqual(e.extra, { spent: 17 });
    assert.ok(e instanceof Error);
});

test('canonicalJson sorts keys recursively; sha256 is stable', () => {
    const a = canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 });
    assert.equal(a, b);
    assert.equal(sha256('x'), '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
});

test('pLimit runs at most n thunks concurrently and preserves results', async () => {
    const limit = pLimit(2);
    let active = 0, peak = 0;
    const job = (v) => async () => {
        active += 1; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1; return v;
    };
    const out = await Promise.all([1, 2, 3, 4, 5].map((v) => limit(job(v))));
    assert.deepEqual(out, [1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
});

test('pLimit propagates rejections without jamming the queue', async () => {
    const limit = pLimit(1);
    await assert.rejects(limit(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await limit(async () => 'ok'), 'ok');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test pipeline/tests/plumbing.test.mjs`
Expected: FAIL — `Cannot find module .../lib/errors.mjs`

- [ ] **Step 3: Implement the three modules**

```js
// pipeline/lib/errors.mjs
export class PipelineError extends Error {
    constructor(code, message, hint = '', extra = {}) {
        super(message);
        this.name = 'PipelineError';
        this.code = code;
        this.hint = hint;
        this.extra = extra;
    }
}
```

```js
// pipeline/lib/hash.mjs
import { createHash } from 'node:crypto';

function sortValue(v) {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v && typeof v === 'object') {
        return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortValue(v[k])]));
    }
    return v;
}

export function canonicalJson(value) {
    return JSON.stringify(sortValue(value));
}

export function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}
```

```js
// pipeline/lib/limit.mjs
// Thunk-based semaphore. Pass a THUNK (() => promise) — an already-invoked
// promise is already running and the limiter can no longer bound it.
export function pLimit(max) {
    let active = 0;
    const queue = [];
    const next = () => {
        active -= 1;
        if (queue.length > 0) queue.shift()();
    };
    return (thunk) => new Promise((resolve, reject) => {
        const start = () => {
            active += 1;
            Promise.resolve().then(thunk).then(
                (v) => { next(); resolve(v); },
                (e) => { next(); reject(e); },
            );
        };
        if (active < max) start(); else queue.push(start);
    });
}
```

`pipeline/package.json` (marks the dir ESM for editors; no deps, matching `proof/`):

```json
{
    "name": "x-pipeline",
    "private": true,
    "type": "module",
    "description": "Deterministic LLM-powered site compiler over the x-agent toolchain. Deps come from x-agent/mcp; run with node >= 20.",
    "scripts": {
        "test": "node --test tests/"
    }
}
```

`PROGRESS.pipeline.json`: read `PROGRESS.canon-factory.json` first and copy its top-level schema exactly (same keys), starting with an empty milestone list and one `decisions[]` entry recording the branch/worktree choice and the "pipeline/ is plain .mjs importing x-agent/mcp/dist" decision.

Append to `.gitignore`:

```
runs/
pipeline.config.json
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test pipeline/tests/plumbing.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline .gitignore PROGRESS.pipeline.json
git commit -m "pipeline: plumbing — errors, canonical hash, thunk limiter, progress ledger"
```

---

### Task 2: Minimal draft-07 validator (`lib/schema.mjs`)

The house rule is no ajv; the repo precedent is the tiny inline validator in `x-agent/tests/schemas.test.ts`. The pipeline needs local JSON-Schema validation for exactly one new contract (brief.schema.json) plus small structural checks; implement only the draft-07 subset those use.

**Files:**
- Create: `pipeline/lib/schema.mjs`
- Test: `pipeline/tests/schema.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `validateSchema(schema, value) -> [{path, message}]` (empty array = valid; `path` is an RFC 6901 pointer like `/pages/0/sections/1/role`). Supported keywords: `type` (string or array; `integer` counts as number check + integrality), `const`, `enum`, `pattern`, `minLength`, `minimum`, `maximum`, `required`, `properties`, `additionalProperties` (boolean false or schema), `items` (single schema), `minItems`, `maxItems`. Unknown keywords are ignored.

- [ ] **Step 1: Write the failing test**

```js
// pipeline/tests/schema.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../lib/schema.mjs';

const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'items'],
    properties: {
        version: { const: 1 },
        name: { type: 'string', minLength: 2, pattern: '^[a-z-]+$' },
        kind: { enum: ['a', 'b'] },
        count: { type: 'integer', minimum: 0, maximum: 10 },
        items: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['id'],
                additionalProperties: false,
                properties: { id: { type: 'string' } },
            },
        },
    },
};

test('valid document returns no issues', () => {
    const issues = validateSchema(schema, { version: 1, name: 'ok-name', kind: 'a', count: 3, items: [{ id: 'x' }] });
    assert.deepEqual(issues, []);
});

test('each violation is reported with a JSON pointer', () => {
    const issues = validateSchema(schema, {
        version: 2, name: 'X', kind: 'c', count: 11.5, items: [{ id: 42, extra: true }], stray: 1,
    });
    const paths = issues.map((i) => i.path).sort();
    assert.ok(paths.includes(''));                    // const violation at root property → reported at /version
    assert.ok(paths.includes('/version'));
    assert.ok(paths.includes('/name'));               // minLength + pattern
    assert.ok(paths.includes('/kind'));               // enum
    assert.ok(paths.includes('/count'));              // maximum + integer
    assert.ok(paths.includes('/items/0/id'));         // type
    assert.ok(paths.includes('/items/0/extra'));      // additionalProperties:false
    assert.ok(paths.includes('/stray'));              // additionalProperties:false
});

test('missing required and minItems', () => {
    const issues = validateSchema(schema, { version: 1, items: [] });
    assert.ok(issues.some((i) => i.path === '/items' && /minItems|at least/.test(i.message)));
    const missing = validateSchema(schema, { items: [{ id: 'x' }] });
    assert.ok(missing.some((i) => i.path === '' && /version/.test(i.message)));
});
```

Note: the root `const` assertion in test 2 — `/version` carries the const violation; adjust the test if you report at the property path only (the implementation below reports at the property path; then drop the `''` expectation from that test).

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test pipeline/tests/schema.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```js
// pipeline/lib/schema.mjs
// Minimal draft-07 subset validator — house rule: no ajv (see x-agent/tests/schemas.test.ts).
// Supports exactly the keywords pipeline/schemas/*.json use; ignores anything else.

function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

export function validateSchema(schema, value, path = '', issues = []) {
    if (!schema || typeof schema !== 'object') return issues;

    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        const t = typeOf(value);
        const ok = types.some((want) => (want === 'integer' ? t === 'number' && Number.isInteger(value) : t === want));
        if (!ok) {
            issues.push({ path, message: `expected ${types.join('|')}, got ${t}` });
            return issues;                       // wrong type: deeper checks are noise
        }
    }
    if (schema.const !== undefined && value !== schema.const) {
        issues.push({ path, message: `expected const ${JSON.stringify(schema.const)}` });
    }
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
        issues.push({ path, message: `expected one of ${schema.enum.join(', ')}` });
    }
    if (typeof value === 'string') {
        if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
            issues.push({ path, message: `does not match ${schema.pattern}` });
        }
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            issues.push({ path, message: `shorter than minLength ${schema.minLength}` });
        }
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            issues.push({ path, message: `below minimum ${schema.minimum}` });
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            issues.push({ path, message: `above maximum ${schema.maximum}` });
        }
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            issues.push({ path, message: `fewer than minItems ${schema.minItems} (at least ${schema.minItems})` });
        }
        if (schema.maxItems !== undefined && value.length > schema.maxItems) {
            issues.push({ path, message: `more than maxItems ${schema.maxItems}` });
        }
        if (schema.items !== undefined) {
            value.forEach((v, i) => validateSchema(schema.items, v, `${path}/${i}`, issues));
        }
    }
    if (typeOf(value) === 'object') {
        for (const key of schema.required ?? []) {
            if (!(key in value)) issues.push({ path, message: `missing required property "${key}"` });
        }
        const props = schema.properties ?? {};
        for (const [key, v] of Object.entries(value)) {
            const esc = key.replace(/~/g, '~0').replace(/\//g, '~1');
            if (key in props) {
                validateSchema(props[key], v, `${path}/${esc}`, issues);
            } else if (schema.additionalProperties === false) {
                issues.push({ path: `${path}/${esc}`, message: 'unexpected property' });
            } else if (typeof schema.additionalProperties === 'object') {
                validateSchema(schema.additionalProperties, v, `${path}/${esc}`, issues);
            }
        }
    }
    return issues;
}
```

- [ ] **Step 4: Run the tests, adjust the root-const expectation to the property-path behavior, make them pass**

Run: `node --test pipeline/tests/schema.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/lib/schema.mjs pipeline/tests/schema.test.mjs
git commit -m "pipeline: minimal draft-07 validator (no ajv, house rule)"
```

---

### Task 3: The brief contract — `pipeline/schemas/brief.schema.json` + fixtures

The one NEW contract this spec introduces. It must carry everything the budget formula reads (S, B, P, I) and everything later stages consume: identity, art direction, palette, pages/sections with roles + copy notes + image intents, custom block declarations (with the gap argument), schema package declarations (with the lifecycle argument), nav and footer intent.

**Files:**
- Create: `pipeline/schemas/brief.schema.json`
- Create: `pipeline/fixtures/brief.m1.json` (the S=3,B=1,P=1,I=2 budget fixture)
- Test: `pipeline/tests/brief-schema.test.mjs`

**Interfaces:**
- Consumes: `validateSchema` from Task 2.
- Produces: the Brief shape all stages read: `brief.identity.site_title`, `brief.art_direction`, `brief.palette[]`, `brief.pages[].sections[]` (`{id, role, copy_notes, image_intent?, uses_custom_block?}`), `brief.custom_blocks[]` (`{slug, title, gap_argument, render_intent, attributes[], interactivity, stylesheet}`), `brief.schema_packages[]` (`{slug, intent, lifecycle_argument, post_types[], routes?, bindings?}`), `brief.navigation.items[]` (`{label, page_slug}`), `brief.footer` (`{intent, items[]}`).

- [ ] **Step 1: Write the failing test**

```js
// pipeline/tests/brief-schema.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSchema } from '../lib/schema.mjs';

const schema = JSON.parse(readFileSync(new URL('../schemas/brief.schema.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));

test('the M1 budget fixture validates clean', () => {
    assert.deepEqual(validateSchema(schema, fixture), []);
});

test('fixture declares exactly S=3, B=1, P=1, I=2', () => {
    const S = fixture.pages.reduce((n, p) => n + p.sections.length, 0);
    const I = fixture.pages.reduce((n, p) => n + p.sections.filter((s) => s.image_intent).length, 0);
    assert.equal(S, 3);
    assert.equal(fixture.custom_blocks.length, 1);
    assert.equal(fixture.schema_packages.length, 1);
    assert.equal(I, 2);
});

test('a sectionless page, a bad role, and a gap-argument-free block all fail', () => {
    const bad = structuredClone(fixture);
    bad.pages[0].sections = [];
    assert.ok(validateSchema(schema, bad).length > 0);

    const badRole = structuredClone(fixture);
    badRole.pages[0].sections[0].role = 'jumbotron';
    assert.ok(validateSchema(schema, badRole).some((i) => i.path.endsWith('/role')));

    const badBlock = structuredClone(fixture);
    delete badBlock.custom_blocks[0].gap_argument;
    assert.ok(validateSchema(schema, badBlock).some((i) => /gap_argument/.test(i.message)));
});

test('free-form extra keys are rejected (additionalProperties:false throughout)', () => {
    const bad = structuredClone(fixture);
    bad.creative_notes = 'no free text lanes';
    assert.ok(validateSchema(schema, bad).some((i) => i.path === '/creative_notes'));
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test pipeline/tests/brief-schema.test.mjs`
Expected: FAIL — schema file not found

- [ ] **Step 3: Write the schema**

```json
{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "x-pipeline/brief.schema.json",
    "title": "Brief",
    "description": "S1 output: the whole plan of the site, fixed before the second LLM call. S/B/P/I are read from it and never renegotiated.",
    "type": "object",
    "additionalProperties": false,
    "required": ["version", "identity", "art_direction", "palette", "pages", "custom_blocks", "schema_packages", "navigation", "footer"],
    "properties": {
        "version": { "const": 1 },
        "identity": {
            "type": "object",
            "additionalProperties": false,
            "required": ["site_title", "tagline"],
            "properties": {
                "site_title": { "type": "string", "minLength": 1 },
                "tagline": { "type": "string", "minLength": 1 },
                "voice": { "type": "string" }
            }
        },
        "art_direction": { "type": "string", "minLength": 40, "description": "Two or three sentences (wp-blocks SKILL §2). Also the style line for the image pass." },
        "palette": {
            "type": "array",
            "minItems": 2,
            "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["name", "color", "role"],
                "properties": {
                    "name": { "type": "string", "minLength": 1 },
                    "color": { "type": "string", "pattern": "^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$" },
                    "role": { "enum": ["primary", "secondary", "accent", "background", "surface", "text", "muted", "border", "other"] }
                }
            }
        },
        "pages": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["slug", "title", "sections"],
                "properties": {
                    "slug": { "type": "string", "pattern": "^[a-z0-9-]+$" },
                    "title": { "type": "string", "minLength": 1 },
                    "front_page": { "type": "boolean" },
                    "sections": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["id", "role", "copy_notes"],
                            "properties": {
                                "id": { "type": "string", "pattern": "^[a-z0-9-]+$" },
                                "role": { "enum": ["header", "hero", "features", "gallery", "testimonial", "pricing", "faq", "cta", "contact", "content", "footer", "section"] },
                                "copy_notes": { "type": "string", "minLength": 10, "description": "What the section says — headlines, claims, tone. The tree task writes the actual copy from this." },
                                "image_intent": { "type": "string", "minLength": 10, "description": "Present iff the section carries one generated image. Each one is one image call (I)." },
                                "uses_custom_block": { "type": "string", "pattern": "^[a-z0-9-]+$", "description": "slug of a custom_blocks[] entry this section is built around." }
                            }
                        }
                    }
                }
            }
        },
        "custom_blocks": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["slug", "title", "gap_argument", "render_intent", "attributes"],
                "properties": {
                    "slug": { "type": "string", "pattern": "^[a-z0-9-]+$" },
                    "title": { "type": "string", "minLength": 1 },
                    "description": { "type": "string", "description": "User-facing inserter description, written for site editors." },
                    "gap_argument": { "type": "string", "minLength": 40, "description": "Why core vocabulary cannot express the section — cite the rungs (supports, tokens, styles, variations) that fail. A block without a winning argument does not exist." },
                    "render_intent": { "type": "string", "minLength": 20 },
                    "attributes": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["name", "type", "control"],
                            "properties": {
                                "name": { "type": "string", "pattern": "^[a-zA-Z][a-zA-Z0-9]*$" },
                                "type": { "enum": ["string", "number", "boolean", "array"] },
                                "default": {},
                                "control": { "enum": ["text", "textarea", "number", "toggle", "select"] },
                                "options": { "type": "array", "items": { "type": "string" } }
                            }
                        }
                    },
                    "interactivity": { "enum": ["none", "view-script", "interactivity-api"] },
                    "stylesheet": { "type": "boolean" }
                }
            }
        },
        "schema_packages": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["slug", "intent", "lifecycle_argument", "post_types"],
                "properties": {
                    "slug": { "type": "string", "pattern": "^[a-z0-9-]+$" },
                    "intent": { "type": "string", "minLength": 20 },
                    "lifecycle_argument": { "type": "string", "minLength": 40, "description": "Why this data has a lifecycle (created, moderated, listed, uninstalled) that a block alone cannot own. wp-schema S1: model before UI." },
                    "post_types": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["slug", "label"],
                            "properties": {
                                "slug": { "type": "string", "pattern": "^[a-z0-9-]+$" },
                                "label": { "type": "string" },
                                "supports": { "type": "array", "items": { "type": "string" } },
                                "public": { "type": "boolean" },
                                "meta": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "additionalProperties": false,
                                        "required": ["key", "type"],
                                        "properties": {
                                            "key": { "type": "string" },
                                            "type": { "enum": ["string", "integer", "number", "boolean"] },
                                            "description": { "type": "string" }
                                        }
                                    }
                                },
                                "taxonomies": { "type": "array", "items": { "type": "string" } }
                            }
                        }
                    },
                    "routes": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["path", "methods", "auth"],
                            "properties": {
                                "path": { "type": "string", "pattern": "^/[a-z0-9/-]*$" },
                                "methods": { "type": "array", "minItems": 1, "items": { "enum": ["GET", "POST"] } },
                                "auth": { "enum": ["public-nonce", "capability"] },
                                "capability": { "type": "string" },
                                "intent": { "type": "string" }
                            }
                        }
                    },
                    "bindings": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["name", "meta_key"],
                            "properties": {
                                "name": { "type": "string" },
                                "meta_key": { "type": "string" }
                            }
                        }
                    }
                }
            }
        },
        "navigation": {
            "type": "object",
            "additionalProperties": false,
            "required": ["items"],
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["label", "page_slug"],
                        "properties": {
                            "label": { "type": "string", "minLength": 1 },
                            "page_slug": { "type": "string", "pattern": "^[a-z0-9-]+$" }
                        }
                    }
                }
            }
        },
        "footer": {
            "type": "object",
            "additionalProperties": false,
            "required": ["intent", "items"],
            "properties": {
                "intent": { "type": "string", "minLength": 10 },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["label", "page_slug"],
                        "properties": {
                            "label": { "type": "string", "minLength": 1 },
                            "page_slug": { "type": "string", "pattern": "^[a-z0-9-]+$" }
                        }
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 4: Write the fixture `pipeline/fixtures/brief.m1.json`**

One page (`front_page: true`, slug `home`) with three sections: `hero` (role hero, copy notes, `image_intent`), `features` (role features, `image_intent`), `signup` (role cta, `uses_custom_block: "signup-banner"`). One custom block `signup-banner` (gap_argument ≥ 40 chars citing rungs 1–4, render_intent, one `heading` string/text attribute, `interactivity: "view-script"`, `stylesheet: true`). One schema package `newsletter` (intent, lifecycle_argument ≥ 40 chars, post type `subscriber` with `email` string meta, one route `{path:"/subscribe", methods:["POST"], auth:"public-nonce"}`). Palette with 4 entries (background/text/primary/accent hexes). Navigation: one item to `home`. Footer: intent + one item to `home`. Every string long enough to clear its minLength.

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `node --test pipeline/tests/brief-schema.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add pipeline/schemas pipeline/fixtures pipeline/tests/brief-schema.test.mjs
git commit -m "pipeline: brief.schema.json — the S1 contract that fixes S, B, P, I"
```

---

### Task 4: `pipeline/budget.mjs` — computeBudget, BudgetMeter, Ledger

The spec's central promise: `base = 1 + 1 + S + B + P; ceiling = 2*base + I`, consulted BEFORE every generative call, hard-thrown on breach, everything in a ledger.

**Files:**
- Create: `pipeline/budget.mjs`
- Test: `pipeline/tests/budget.test.mjs`

**Interfaces:**
- Consumes: `PipelineError`, `canonicalJson`, `sha256` (Tasks 1); Brief shape (Task 3).
- Produces:
  - `computeBudget(brief) -> {S, B, P, I, base, ceiling}`
  - `class BudgetMeter { constructor({hard_cap = Infinity}); setCeiling(n); spend(task_type, label); get spent(); get ceiling(); }` — while the ceiling is unset (pre-S1) at most 2 spends are allowed (S1 + its schema retry); `spend()` past the ceiling (or past `hard_cap`) throws `PipelineError('budget_exceeded', ...)`. `setCeiling` throws `budget_exceeded` immediately if `ceiling > hard_cap` (the run must refuse right after S1, before call #2).
  - `class Ledger { constructor(runDir); record(entry); flush(); entries; }` — `record` appends `{task_type, label, provider, model, prompt_hash, payload_hash, usage, attempt, outcome, started_at, ms}` to memory AND appends a line to `runs/<ts>/ledger.jsonl` immediately (crash evidence); `flush()` writes `runs/<ts>/ledger.json` as the array sorted by `(task_type, label, attempt)` — deterministic order under concurrency, "timestamps excepted" comparability.

- [ ] **Step 1: Write the failing test**

```js
// pipeline/tests/budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBudget, BudgetMeter, Ledger } from '../budget.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/brief.m1.json', import.meta.url), 'utf8'));

test('M1 acceptance: S=3,B=1,P=1,I=2 => ceiling 16', () => {
    const b = computeBudget(fixture);
    assert.deepEqual(b, { S: 3, B: 1, P: 1, I: 2, base: 7, ceiling: 16 });
});

test('M1 acceptance: the 17th generative call throws {code:"budget_exceeded"}', () => {
    const meter = new BudgetMeter({});
    meter.spend('brief', 'brief');                       // pre-ceiling call #1 (S1 itself)
    meter.setCeiling(16);
    for (let i = 2; i <= 16; i += 1) meter.spend('tree', `s${i}`);
    assert.equal(meter.spent, 16);
    assert.throws(() => meter.spend('tree', 'one-too-many'), (e) => e.code === 'budget_exceeded');
});

test('pre-ceiling spending is capped at 2 (S1 + its schema retry)', () => {
    const meter = new BudgetMeter({});
    meter.spend('brief', 'brief');
    meter.spend('brief', 'brief');
    assert.throws(() => meter.spend('brief', 'brief'), (e) => e.code === 'budget_exceeded');
});

test('hard cap refuses a too-expensive brief at setCeiling time', () => {
    const meter = new BudgetMeter({ hard_cap: 10 });
    meter.spend('brief', 'brief');
    assert.throws(() => meter.setCeiling(16), (e) => e.code === 'budget_exceeded');
});

test('ledger: jsonl appended live, ledger.json flushed in deterministic order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-pipeline-ledger-'));
    const ledger = new Ledger(dir);
    ledger.record({ task_type: 'tree', label: 'home/features', provider: 'fake', model: 'f', prompt_hash: 'p2', payload_hash: 'q2', usage: { input_tokens: 1, output_tokens: 1 }, attempt: 1, outcome: 'ok', started_at: 5, ms: 1 });
    ledger.record({ task_type: 'tree', label: 'home/hero', provider: 'fake', model: 'f', prompt_hash: 'p1', payload_hash: 'q1', usage: { input_tokens: 1, output_tokens: 1 }, attempt: 1, outcome: 'ok', started_at: 9, ms: 1 });
    ledger.flush();
    const arr = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
    assert.deepEqual(arr.map((e) => e.label), ['home/features', 'home/hero']);   // sorted, not insertion order
    const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).label, 'home/features');                    // insertion order preserved live
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test pipeline/tests/budget.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `pipeline/budget.mjs`**

```js
// pipeline/budget.mjs
// The bill is a function of the brief: base = 1 (brief) + 1 (tokens) + S + B + P;
// ceiling = 2*base + I. The 2x covers one schema-retry OR one repair per artifact,
// whichever fires. Consulted BEFORE every generative call; a breach is a thrown
// structured error, never a warning (spec operating rule 5).
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from './lib/errors.mjs';

export function computeBudget(brief) {
    const S = brief.pages.reduce((n, p) => n + p.sections.length, 0);
    const B = brief.custom_blocks.length;
    const P = brief.schema_packages.length;
    const I = brief.pages.reduce((n, p) => n + p.sections.filter((s) => s.image_intent).length, 0);
    const base = 1 + 1 + S + B + P;
    return { S, B, P, I, base, ceiling: 2 * base + I };
}

const PRE_CEILING_ALLOWANCE = 2;    // S1 + its one schema-retry; nothing else may run before the ceiling exists

export class BudgetMeter {
    #ceiling = null;
    #hardCap;
    #spent = 0;
    #calls = [];

    constructor({ hard_cap = Infinity } = {}) {
        this.#hardCap = hard_cap;
    }

    setCeiling(ceiling) {
        if (ceiling > this.#hardCap) {
            throw new PipelineError('budget_exceeded',
                `this brief costs up to ${ceiling} calls; budget_hard_cap is ${this.#hardCap}`,
                'Raise budget_hard_cap in pipeline.config.json or narrow the prompt.',
                { ceiling, hard_cap: this.#hardCap });
        }
        this.#ceiling = ceiling;
    }

    spend(taskType, label) {
        const limit = this.#ceiling ?? PRE_CEILING_ALLOWANCE;
        if (this.#spent + 1 > limit) {
            throw new PipelineError('budget_exceeded',
                `call ${this.#spent + 1} (${taskType}:${label}) would exceed the ceiling of ${limit}`,
                'The run ends with a report, never with silent extra spending.',
                { spent: this.#spent, ceiling: limit, task_type: taskType, label });
        }
        this.#spent += 1;
        this.#calls.push({ task_type: taskType, label });
    }

    get spent() { return this.#spent; }
    get ceiling() { return this.#ceiling; }
    get calls() { return [...this.#calls]; }
}

export class Ledger {
    constructor(runDir) {
        this.runDir = runDir;
        this.entries = [];
    }

    record(entry) {
        this.entries.push(entry);
        appendFileSync(join(this.runDir, 'ledger.jsonl'), `${JSON.stringify(entry)}\n`);
    }

    flush() {
        const sorted = [...this.entries].sort((a, b) =>
            a.task_type.localeCompare(b.task_type) || a.label.localeCompare(b.label) || a.attempt - b.attempt);
        writeFileSync(join(this.runDir, 'ledger.json'), `${JSON.stringify(sorted, null, 2)}\n`);
        return sorted;
    }
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test pipeline/tests/budget.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add pipeline/budget.mjs pipeline/tests/budget.test.mjs
git commit -m "pipeline: budget — ceiling formula, hard meter, deterministic ledger"
```

---

### Task 5: Config load + preflight (`lib/config.mjs`)

**Files:**
- Create: `pipeline/lib/config.mjs`
- Create: `pipeline/config.example.json`
- Test: `pipeline/tests/config.test.mjs`

**Interfaces:**
- Consumes: `PipelineError`.
- Produces:
  - `TASK_TYPES = ['brief', 'tokens', 'tree', 'block', 'schema', 'repair']` (the 6 text tasks; `image` is routed by the existing Gemini client via `.x-agent.json`, not by pipeline.config.json).
  - `loadPipelineConfig(configPath) -> {tasks, concurrency, budget_hard_cap, prompts_dir}` — parses, defaults `concurrency: 3` (single-PHP-worker Playground: keep fan-out modest), `budget_hard_cap: Infinity`, `prompts_dir: <repo>/pipeline/prompts`. Throws `PipelineError('preflight_failed', ...)` naming the missing file / missing task entry / entry without provider or model.
  - `readProviderKeys(cwd) -> {cerebras_api_key?, anthropic_api_key?, openai_api_key?, gemini_api_key?}` — reads `.x-agent.json` from `cwd` (same file the toolchain reads; the pipeline reads it separately because the toolchain's `resolveConfig` does not surface these keys), env fallbacks `CEREBRAS_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

- [ ] **Step 1: Write the failing test**

```js
// pipeline/tests/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPipelineConfig, readProviderKeys, TASK_TYPES } from '../lib/config.mjs';

const dir = mkdtempSync(join(tmpdir(), 'x-pipeline-config-'));

function writeConfig(name, obj) {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(obj));
    return p;
}

const fullTasks = Object.fromEntries(TASK_TYPES.map((t) => [t, { provider: 'fake', model: 'fixtures' }]));

test('a full config loads with defaults applied', () => {
    const cfg = loadPipelineConfig(writeConfig('ok.json', { tasks: fullTasks }));
    assert.equal(cfg.concurrency, 3);
    assert.equal(cfg.budget_hard_cap, Infinity);
    assert.ok(cfg.prompts_dir.endsWith('pipeline/prompts'));
});

test('a missing task entry fails preflight NAMING the task', () => {
    const partial = { ...fullTasks };
    delete partial.repair;
    assert.throws(() => loadPipelineConfig(writeConfig('missing.json', { tasks: partial })),
        (e) => e.code === 'preflight_failed' && /repair/.test(e.message));
});

test('a task entry without model fails preflight naming task and field', () => {
    const bad = { ...fullTasks, tree: { provider: 'fake' } };
    assert.throws(() => loadPipelineConfig(writeConfig('nomodel.json', { tasks: bad })),
        (e) => e.code === 'preflight_failed' && /tree/.test(e.message) && /model/.test(e.message));
});

test('a missing config file fails preflight naming the path', () => {
    assert.throws(() => loadPipelineConfig(join(dir, 'nope.json')),
        (e) => e.code === 'preflight_failed' && /nope\.json/.test(e.message));
});

test('provider keys come from .x-agent.json with env fallback', () => {
    writeFileSync(join(dir, '.x-agent.json'), JSON.stringify({ anthropic_api_key: 'sk-file' }));
    const keys = readProviderKeys(dir, { OPENAI_API_KEY: 'sk-env' });
    assert.equal(keys.anthropic_api_key, 'sk-file');
    assert.equal(keys.openai_api_key, 'sk-env');
    assert.equal(keys.cerebras_api_key, undefined);
});
```

- [ ] **Step 2: Run to verify FAIL, then implement**

`loadPipelineConfig`: read+parse (wrap ENOENT and JSON syntax errors into `preflight_failed` with the path in the message), verify `cfg.tasks` object exists, loop `TASK_TYPES` asserting each entry exists and has non-empty string `provider` and `model` (`temperature` optional number; unknown extra keys like `options` pass through untouched), apply defaults, resolve `prompts_dir` relative to the pipeline package (`new URL('../prompts/', import.meta.url)`) unless overridden by a `prompts_dir` key (used by the M3 poisoned-template acceptance). `readProviderKeys(cwd, env = process.env)`: try `JSON.parse(readFileSync(join(cwd, '.x-agent.json')))`, swallow ENOENT; map the four `*_api_key` fields with env fallbacks.

`pipeline/config.example.json` (committed; the live `pipeline.config.json` is gitignored — copy and edit):

```json
{
    "tasks": {
        "brief":  { "provider": "anthropic", "model": "claude-opus-5" },
        "tokens": { "provider": "anthropic", "model": "claude-sonnet-5", "temperature": 0.4 },
        "tree":   { "provider": "anthropic", "model": "claude-opus-5", "temperature": 0.3 },
        "block":  { "provider": "cerebras",  "model": "zai-glm-4.7", "temperature": 0.3 },
        "schema": { "provider": "cerebras",  "model": "zai-glm-4.7", "temperature": 0.3 },
        "repair": { "provider": "anthropic", "model": "claude-opus-5", "temperature": 0.2 }
    },
    "concurrency": 3,
    "budget_hard_cap": 60
}
```

(Routing rationale is the spec's: brief benefits from reasoning; trees and repair want the strongest model; blocks/schema are code tasks. Swapping a provider is a config edit, never a code change.)

- [ ] **Step 3: Run the tests and make sure they pass**

Run: `node --test pipeline/tests/config.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 4: Commit**

```bash
git add pipeline/lib/config.mjs pipeline/config.example.json pipeline/tests/config.test.mjs
git commit -m "pipeline: config load + preflight — missing tasks fail before the run, not mid-run"
```

---

### Task 6: Prompt template loader + renderer (`lib/prompts.mjs`)

**Files:**
- Create: `pipeline/lib/prompts.mjs`
- Test: `pipeline/tests/prompts.test.mjs`

**Interfaces:**
- Consumes: `PipelineError`.
- Produces:
  - `loadTemplate(promptsDir, taskType) -> {task_type, required: string[], body}` — reads `<promptsDir>/<taskType>.md`, parses YAML-lite frontmatter between the first two `---` lines: `task_type: <name>` and `required: [a, b, c]` (a single bracketed inline list — no YAML dependency). Throws `preflight_failed` if the file is missing, frontmatter is absent, or `task_type` doesn't match the filename.
  - `renderPrompt(template, payload) -> string` — substitutes every `{{key}}` in the body: string values verbatim, everything else `JSON.stringify(value, null, 2)`. Throws `PipelineError('prompt_payload_missing', ...)` naming the field when a `required` field is absent from the payload or a `{{key}}` has no payload value. Unused payload keys are fine (they still ride into the ledger's payload_hash).

- [ ] **Step 1: Write the failing test**

```js
// pipeline/tests/prompts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTemplate, renderPrompt } from '../lib/prompts.mjs';

const dir = mkdtempSync(join(tmpdir(), 'x-pipeline-prompts-'));
writeFileSync(join(dir, 'tree.md'), [
    '---',
    'task_type: tree',
    'required: [section, manifest_slice, epoch]',
    '---',
    'Build section {{section}} against {{manifest_slice}} at epoch {{epoch}}.',
].join('\n'));

test('frontmatter parses task_type and required', () => {
    const t = loadTemplate(dir, 'tree');
    assert.equal(t.task_type, 'tree');
    assert.deepEqual(t.required, ['section', 'manifest_slice', 'epoch']);
    assert.match(t.body, /^Build section/);
});

test('rendering substitutes strings verbatim and objects as pretty JSON', () => {
    const t = loadTemplate(dir, 'tree');
    const out = renderPrompt(t, { section: 'hero', manifest_slice: { blocks: ['core/group'] }, epoch: 'abc' });
    assert.match(out, /section hero against/);
    assert.match(out, /"blocks": \[\s+"core\/group"\s+\]/);
    assert.match(out, /at epoch abc\./);
});

test('a missing required field throws naming the field', () => {
    const t = loadTemplate(dir, 'tree');
    assert.throws(() => renderPrompt(t, { section: 'hero', epoch: 'abc' }),
        (e) => e.code === 'prompt_payload_missing' && /manifest_slice/.test(e.message));
});

test('a template without frontmatter fails preflight', () => {
    writeFileSync(join(dir, 'block.md'), 'no frontmatter here');
    assert.throws(() => loadTemplate(dir, 'block'), (e) => e.code === 'preflight_failed');
});
```

- [ ] **Step 2: Run to verify FAIL, implement, run to PASS**

Implementation notes: split the file on `\n`; assert line 0 is `---`; scan to the closing `---`; parse `key: value` pairs; `required` value must match `/^\[(.*)\]$/` and splits on commas with trim. Render with `body.replace(/\{\{([a-z_]+)\}\}/g, ...)` after the required-fields presence check; the replacer throws on keys absent from the payload.

- [ ] **Step 3: Commit**

```bash
git add pipeline/lib/prompts.mjs pipeline/tests/prompts.test.mjs
git commit -m "pipeline: prompt templates — frontmatter-declared payloads, deterministic render"
```

---

### Task 7: Providers — fake fixture-replay + registry

**Files:**
- Create: `pipeline/providers/fake.mjs`
- Create: `pipeline/providers/index.mjs`
- Create: `pipeline/fixtures/fake/brief.brief.json` (sample fixture used by the tests)
- Test: `pipeline/tests/providers.test.mjs`

**Interfaces:**
- Consumes: `PipelineError`.
- Produces:
  - Provider module contract: each `pipeline/providers/<id>.mjs` exports `create({ keys, options }) -> LlmProvider` where `LlmProvider = { id, async complete(task_type, prompt, payload, { model, temperature, label }) -> { text, usage: {input_tokens, output_tokens} } }`. Providers are dumb pipes: no prompt forks, no silent model fallback, no retries beyond transport errors. (`label` is an additive opt the fake provider uses for fixture keying — wpforge's dryModel trick; real providers ignore it.)
  - `createProviders({ config, keys }) -> Map<task_type, {provider, model, temperature}>` in `providers/index.mjs`: dynamic-imports each distinct `tasks[t].provider` module exactly once (`preflight_failed` naming task and provider when the module doesn't exist or the provider's key is missing — fake needs no key; anthropic needs `anthropic_api_key`, openai `openai_api_key`, cerebras `cerebras_api_key`).
  - Fake provider: `create({options})` with `options.fixtures_dir` (default `pipeline/fixtures/fake`). `complete` reads `<fixtures_dir>/<task_type>.<label-with-slashes-as-dashes>.json`, which contains `{ text: "<raw model output>", usage?: {...} }`, and returns it with `usage` defaulted to `{input_tokens: 0, output_tokens: 0}`. Missing fixture → `PipelineError('fixture_missing', ...)` naming the path. Deterministic: same inputs, same bytes, zero network.

- [ ] **Step 1: Write the failing test**

```js
// pipeline/tests/providers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createFake } from '../providers/fake.mjs';
import { createProviders } from '../providers/index.mjs';

const dir = mkdtempSync(join(tmpdir(), 'x-pipeline-fixtures-'));
writeFileSync(join(dir, 'tree.home-hero.json'), JSON.stringify({ text: '{"version":1}', usage: { input_tokens: 5, output_tokens: 7 } }));

test('fake provider replays a fixture keyed by task_type + label', async () => {
    const fake = createFake({ options: { fixtures_dir: dir } });
    const out = await fake.complete('tree', 'PROMPT', { any: 'payload' }, { model: 'fixtures', label: 'home/hero' });
    assert.equal(out.text, '{"version":1}');
    assert.deepEqual(out.usage, { input_tokens: 5, output_tokens: 7 });
});

test('a missing fixture throws fixture_missing naming the path', async () => {
    const fake = createFake({ options: { fixtures_dir: dir } });
    await assert.rejects(fake.complete('tree', 'P', {}, { model: 'fixtures', label: 'nope' }),
        (e) => e.code === 'fixture_missing' && /tree\.nope\.json/.test(e.message));
});

test('createProviders routes every task and rejects unknown provider modules', async () => {
    const tasks = Object.fromEntries(['brief', 'tokens', 'tree', 'block', 'schema', 'repair']
        .map((t) => [t, { provider: 'fake', model: 'fixtures' }]));
    const routed = await createProviders({ config: { tasks }, keys: {} });
    assert.equal(routed.get('tree').provider.id, 'fake');
    assert.equal(routed.get('brief').model, 'fixtures');

    tasks.tree = { provider: 'no-such-provider', model: 'x' };
    await assert.rejects(createProviders({ config: { tasks }, keys: {} }),
        (e) => e.code === 'preflight_failed' && /tree/.test(e.message) && /no-such-provider/.test(e.message));
});

test('a real provider without its key fails preflight naming the key', async () => {
    const tasks = { brief: { provider: 'anthropic', model: 'claude-opus-5' } };
    await assert.rejects(createProviders({ config: { tasks: { ...tasks } }, keys: {} }),
        (e) => e.code === 'preflight_failed' && /anthropic_api_key/.test(e.message));
});
```

- [ ] **Step 2: Run to verify FAIL, implement fake.mjs and index.mjs**

```js
// pipeline/providers/fake.mjs
// Fixture-replay provider for deterministic tests (spec: pipeline/providers/fake.mjs).
// Keyed by task_type + label — wpforge's dryModel label trick — because payload
// hashes vary with instance fingerprints while labels are stable across runs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineError } from '../lib/errors.mjs';

const DEFAULT_DIR = new URL('../fixtures/fake', import.meta.url).pathname;

export function create({ options = {} } = {}) {
    const dir = options.fixtures_dir ?? DEFAULT_DIR;
    return {
        id: 'fake',
        async complete(taskType, _prompt, _payload, { label }) {
            const file = join(dir, `${taskType}.${String(label).replaceAll('/', '-')}.json`);
            let raw;
            try {
                raw = readFileSync(file, 'utf8');
            } catch {
                throw new PipelineError('fixture_missing', `no fixture for ${taskType}:${label} at ${file}`,
                    'Add the fixture or route this task to a real provider.');
            }
            const { text, usage } = JSON.parse(raw);
            return { text, usage: usage ?? { input_tokens: 0, output_tokens: 0 } };
        },
    };
}
```

```js
// pipeline/providers/index.mjs
import { PipelineError } from '../lib/errors.mjs';
import { TASK_TYPES } from '../lib/config.mjs';

const KEY_FOR = { anthropic: 'anthropic_api_key', openai: 'openai_api_key', cerebras: 'cerebras_api_key' };

export async function createProviders({ config, keys }) {
    const routed = new Map();
    const instances = new Map();
    for (const task of TASK_TYPES) {
        const entry = config.tasks[task];
        const { provider: id, model, temperature, options } = entry;
        if (!instances.has(id)) {
            let mod;
            try {
                mod = await import(`./${id}.mjs`);
            } catch (e) {
                throw new PipelineError('preflight_failed',
                    `task "${task}" routes to provider "${id}" but pipeline/providers/${id}.mjs does not load: ${e.message}`);
            }
            const keyName = KEY_FOR[id];
            if (keyName && !keys[keyName]) {
                throw new PipelineError('preflight_failed',
                    `task "${task}" routes to provider "${id}" but ${keyName} is not in .x-agent.json (or env)`);
            }
            instances.set(id, mod.create({ keys, options }));
        }
        routed.set(task, { provider: instances.get(id), model, temperature });
    }
    return routed;
}
```

Also commit `pipeline/fixtures/fake/brief.brief.json`: `{"text": "<the brief.m1.json fixture serialized as a JSON string>"}` — generate it with `node -e` from `pipeline/fixtures/brief.m1.json` so the two never drift (`{text: JSON.stringify(brief)}`).

- [ ] **Step 3: Run the tests and make sure they pass, then commit**

```bash
node --test pipeline/tests/providers.test.mjs
git add pipeline/providers pipeline/fixtures pipeline/tests/providers.test.mjs
git commit -m "pipeline: LlmProvider contract, fake fixture-replay provider, task routing"
```

---

### Task 8: Real providers — anthropic, openai, cerebras (raw fetch, no SDKs)

**Files:**
- Create: `pipeline/providers/anthropic.mjs`
- Create: `pipeline/providers/openai.mjs`
- Create: `pipeline/providers/cerebras.mjs`
- Test: `pipeline/tests/providers-real.test.mjs`

**Interfaces:**
- Consumes: provider module contract from Task 7; `PipelineError`.
- Produces: three `create({keys}) -> LlmProvider` implementations. Each sends the rendered prompt as the single user message, honors `{model, temperature}`, maps usage to `{input_tokens, output_tokens}`, retries ONLY transport-level failures (fetch rejection, 408/429/5xx) 3 times with `1500 * attempt` ms backoff (mirroring `images/gemini.ts` — these are not budget calls), and throws `PipelineError('provider_error', ...)` with status + body excerpt on anything else. To keep them testable without network, each accepts `options.fetch` (defaults to `globalThis.fetch`).

- [ ] **Step 1: Write the failing test** (exercises request shape + usage mapping + transport retry with an injected fetch)

```js
// pipeline/tests/providers-real.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create as anthropic } from '../providers/anthropic.mjs';
import { create as openai } from '../providers/openai.mjs';
import { create as cerebras } from '../providers/cerebras.mjs';

function fetchStub(responses) {
    const calls = [];
    return {
        calls,
        fetch: async (url, init) => {
            calls.push({ url, init: JSON.parse(init.body), headers: init.headers });
            const next = responses.shift();
            if (next instanceof Error) throw next;
            return { ok: next.status < 400, status: next.status, json: async () => next.body, text: async () => JSON.stringify(next.body) };
        },
    };
}

test('anthropic: request shape and usage mapping', async () => {
    const stub = fetchStub([{ status: 200, body: { content: [{ type: 'text', text: 'OUT' }], usage: { input_tokens: 11, output_tokens: 3 } } }]);
    const p = anthropic({ keys: { anthropic_api_key: 'sk-a' }, options: { fetch: stub.fetch } });
    const out = await p.complete('tree', 'PROMPT', {}, { model: 'claude-opus-5', temperature: 0.3 });
    assert.equal(out.text, 'OUT');
    assert.deepEqual(out.usage, { input_tokens: 11, output_tokens: 3 });
    const call = stub.calls[0];
    assert.match(call.url, /api\.anthropic\.com\/v1\/messages/);
    assert.equal(call.headers['x-api-key'], 'sk-a');
    assert.equal(call.init.model, 'claude-opus-5');
    assert.equal(call.init.temperature, 0.3);
    assert.deepEqual(call.init.messages, [{ role: 'user', content: 'PROMPT' }]);
});

test('openai + cerebras: chat-completions shape', async () => {
    for (const [make, host, key] of [[openai, 'api.openai.com', 'openai_api_key'], [cerebras, 'api.cerebras.ai', 'cerebras_api_key']]) {
        const stub = fetchStub([{ status: 200, body: { choices: [{ message: { content: 'OUT' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } } }]);
        const p = make({ keys: { [key]: 'sk-x' }, options: { fetch: stub.fetch } });
        const out = await p.complete('block', 'PROMPT', {}, { model: 'm1', temperature: 0 });
        assert.equal(out.text, 'OUT');
        assert.deepEqual(out.usage, { input_tokens: 7, output_tokens: 2 });
        assert.match(stub.calls[0].url, new RegExp(host));
        assert.equal(stub.calls[0].headers.Authorization, 'Bearer sk-x');
    }
});

test('transport errors retry 3x then throw provider_error; 4xx does not retry', async () => {
    const stub = fetchStub([{ status: 500, body: {} }, { status: 500, body: {} }, { status: 200, body: { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }]);
    const p = openai({ keys: { openai_api_key: 'k' }, options: { fetch: stub.fetch, backoff_ms: 1 } });
    assert.equal((await p.complete('tree', 'P', {}, { model: 'm' })).text, 'OK');
    assert.equal(stub.calls.length, 3);

    const bad = fetchStub([{ status: 400, body: { error: 'bad request' } }]);
    const p2 = openai({ keys: { openai_api_key: 'k' }, options: { fetch: bad.fetch, backoff_ms: 1 } });
    await assert.rejects(p2.complete('tree', 'P', {}, { model: 'm' }), (e) => e.code === 'provider_error');
    assert.equal(bad.calls.length, 1);
});
```

- [ ] **Step 2: Run to verify FAIL, implement the three providers**

`anthropic.mjs`: POST `https://api.anthropic.com/v1/messages`, headers `{'x-api-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json'}`, body `{model, max_tokens: 16000, temperature, messages: [{role:'user', content: prompt}]}`; text = `body.content.filter(c => c.type === 'text').map(c => c.text).join('')`; usage maps 1:1. `openai.mjs` / `cerebras.mjs`: POST `https://api.openai.com/v1/chat/completions` / `https://api.cerebras.ai/v1/chat/completions`, header `Authorization: Bearer <key>`, body `{model, temperature, messages: [{role:'user', content: prompt}]}`; text = `choices[0].message.content`; usage `{input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens}`. Shared retry helper INSIDE `providers/` (e.g. `providers/_transport.mjs`, exporting `withTransportRetry(fn, {attempts: 3, backoff_ms})` retrying on rejection/408/429/5xx). Temperature omitted from the body when undefined.

- [ ] **Step 3: Run the tests to PASS, commit**

```bash
node --test pipeline/tests/providers-real.test.mjs
git add pipeline/providers pipeline/tests/providers-real.test.mjs
git commit -m "pipeline: anthropic/openai/cerebras providers — dumb pipes over fetch"
```

---

### Task 9: The metered LLM caller (`lib/llm.mjs`)

The one lane every generative call uses: budget check → render → provider → JSON extraction → contract validation → at most ONE metered schema-retry → ledger entry per attempt.

**Files:**
- Create: `pipeline/lib/llm.mjs`
- Test: `pipeline/tests/llm.test.mjs`

**Interfaces:**
- Consumes: `BudgetMeter`, `Ledger` (Task 4), `loadTemplate`/`renderPrompt` (Task 6), routed providers Map (Task 7), `canonicalJson`/`sha256` (Task 1).
- Produces:
  - `extractJson(text) -> value` — strips one ```/```json fence if present, `JSON.parse`; on failure tries the balanced-brace slice from first `{`/`[` to last `}`/`]`; throws `SyntaxError` if still unparseable. (wpforge's defensive parse, minus the LLM-repair fallback — our repair lane is the schema-retry.)
  - `createLlm({providers, promptsDir, budget, ledger}) -> { generate }` where `generate({task_type, label, payload, validate, maxAttempts = 2})` returns `{value, attempts}`. `validate(value) -> [{path, message}]`. Attempt loop: `budget.spend()` FIRST, then `provider.complete`, parse, validate; on contract failure at attempt 1 (and maxAttempts 2) re-render the prompt with a `CONTRACT FAILURE` addendum listing the issues verbatim and loop once; on final failure throw `PipelineError('contract_failed', ..., {task_type, label, issues})`. Every attempt gets a ledger entry `{task_type, label, provider, model, prompt_hash: sha256(prompt), payload_hash: sha256(canonicalJson(payload)), usage, attempt, outcome: 'ok'|'invalid_json'|'schema_failed', started_at, ms}`. maxAttempts=1 is the S7 repair mode (a malformed repair is dead, no retry-of-the-repair).

- [ ] **Step 1: Write the failing test**

```js
// pipeline/tests/llm.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetMeter, Ledger } from '../budget.mjs';
import { createLlm, extractJson } from '../lib/llm.mjs';

test('extractJson: plain, fenced, and prose-wrapped', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('Here you go:\n{"a":1}\nHope that helps!'), { a: 1 });
    assert.throws(() => extractJson('not json at all'));
});

function harness({ outputs }) {
    const dir = mkdtempSync(join(tmpdir(), 'x-pipeline-llm-'));
    writeFileSync(join(dir, 'tree.md'), '---\ntask_type: tree\nrequired: [section]\n---\nDo {{section}}.');
    const calls = [];
    const provider = {
        id: 'scripted',
        complete: async (t, prompt) => { calls.push(prompt); return { text: outputs.shift(), usage: { input_tokens: 1, output_tokens: 1 } }; },
    };
    const providers = new Map([['tree', { provider, model: 'm', temperature: 0 }]]);
    const budget = new BudgetMeter({});
    budget.setCeiling(10);
    const runDir = mkdtempSync(join(tmpdir(), 'x-pipeline-llm-run-'));
    const ledger = new Ledger(runDir);
    return { llm: createLlm({ providers, promptsDir: dir, budget, ledger }), calls, budget, ledger };
}

test('clean call: 1 spend, 1 ledger entry, outcome ok', async () => {
    const h = harness({ outputs: ['{"n":1}'] });
    const out = await h.llm.generate({ task_type: 'tree', label: 'home/hero', payload: { section: 'hero' }, validate: () => [] });
    assert.deepEqual(out, { value: { n: 1 }, attempts: 1 });
    assert.equal(h.budget.spent, 1);
    assert.equal(h.ledger.entries.length, 1);
    assert.equal(h.ledger.entries[0].outcome, 'ok');
    assert.equal(h.ledger.entries[0].label, 'home/hero');
});

test('contract failure retries EXACTLY once with issues in the prompt, both metered', async () => {
    const h = harness({ outputs: ['{"bad":true}', '{"good":true}'] });
    const validate = (v) => (v.good ? [] : [{ path: '/bad', message: 'not allowed' }]);
    const out = await h.llm.generate({ task_type: 'tree', label: 'l', payload: { section: 's' }, validate });
    assert.equal(out.attempts, 2);
    assert.equal(h.budget.spent, 2);
    assert.match(h.calls[1], /CONTRACT FAILURE/);
    assert.match(h.calls[1], /\/bad: not allowed/);
    assert.deepEqual(h.ledger.entries.map((e) => e.outcome), ['schema_failed', 'ok']);
});

test('second contract failure throws contract_failed with issues attached', async () => {
    const h = harness({ outputs: ['nonsense', 'still nonsense'] });
    await assert.rejects(
        h.llm.generate({ task_type: 'tree', label: 'l', payload: { section: 's' }, validate: () => [] }),
        (e) => e.code === 'contract_failed' && e.extra.issues.length > 0);
    assert.equal(h.budget.spent, 2);
    assert.deepEqual(h.ledger.entries.map((e) => e.outcome), ['invalid_json', 'invalid_json']);
});

test('maxAttempts 1 (repair mode) never retries', async () => {
    const h = harness({ outputs: ['nonsense'] });
    await assert.rejects(h.llm.generate({ task_type: 'tree', label: 'l', payload: { section: 's' }, validate: () => [], maxAttempts: 1 }));
    assert.equal(h.budget.spent, 1);
});

test('budget is consulted BEFORE the provider call', async () => {
    const h = harness({ outputs: ['{"n":1}'] });
    for (let i = 0; i < 9; i += 1) h.budget.spend('x', `pre${i}`);
    await assert.rejects(async () => {
        await h.llm.generate({ task_type: 'tree', label: 'a', payload: { section: 's' }, validate: () => [] });   // 10th ok
        await h.llm.generate({ task_type: 'tree', label: 'b', payload: { section: 's' }, validate: () => [] });   // 11th must throw
    }, (e) => e.code === 'budget_exceeded');
    assert.equal(h.calls.length, 1);   // the provider was never reached for call 11
});
```

- [ ] **Step 2: Run to verify FAIL, implement `lib/llm.mjs`**

Template cache per `(promptsDir, task_type)`. The retry prompt is `${prompt}\n\nCONTRACT FAILURE — your previous output did not satisfy the contract:\n${issues.map(i => `${i.path}: ${i.message}`).join('\n')}\nReturn ONLY corrected JSON.`. `started_at = Date.now()` and `ms` measured around the provider call. Outcome mapping: parse throw → `invalid_json`; non-empty validate() → `schema_failed`; else `ok`.

- [ ] **Step 3: Run the tests to PASS, commit**

```bash
node --test pipeline/tests/llm.test.mjs
git add pipeline/lib/llm.mjs pipeline/tests/llm.test.mjs
git commit -m "pipeline: metered LLM lane — one schema-retry, every attempt in the ledger"
```

---

### Task 10: Toolchain shim (`lib/toolchain.mjs`)

**Files:**
- Create: `pipeline/lib/toolchain.mjs`
- Test: `pipeline/tests/toolchain.test.mjs` (import-level checks only — live behavior is covered by acceptance scripts)

**Interfaces:**
- Consumes: `x-agent/mcp/dist/mcp/src/{context,server,registry,errors}.js`.
- Produces: `createToolchain({cwd = process.cwd(), providerKeys = {}}) -> {call, runtime, dispose}` where `call(name, args) -> {ok, data}` (`ok = !res.isError`, `data = JSON.parse(res.content[0].text)` — the result on success, the `{code,message,hint}` envelope on failure). Registers every provider key via the toolchain's own `registerSecret` (one redaction layer). Verifies after `loadExternalHandlers()` that `wp_compile` is really implemented (guard against the one-shot loader no-op noted in the research: check the tool's handler is not the `not_implemented` placeholder by calling nothing — inspect `findTool('wp_compile')` and assert its module loaded, or call `loadExternalHandlers({force:true})` and check the returned report; if the registry exports `isUnimplemented`, use it).

- [ ] **Step 1: Write the failing test**

```js
// pipeline/tests/toolchain.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolchain } from '../lib/toolchain.mjs';

test('createToolchain loads handlers and shims callTool results', async () => {
    const tc = await createToolchain({ cwd: mkdtempSync(join(tmpdir(), 'x-pipeline-tc-')) });
    // wp_spec_validate is local:true — callable with no instance at all.
    const res = await tc.call('wp_spec_validate', { version: 1 });
    assert.equal(typeof res.ok, 'boolean');
    assert.ok(res.data);                                  // parsed result or envelope, never raw text
    // An unknown tool comes back as a structured envelope, not a throw.
    const bad = await tc.call('wp_definitely_not_a_tool', {});
    assert.equal(bad.ok, false);
    assert.equal(bad.data.code, 'invalid_input');
    await tc.dispose();
});
```

- [ ] **Step 2: Run to verify FAIL (module not found), implement**

```js
// pipeline/lib/toolchain.mjs
// In-process consumption of the MCP tool handlers — the spec's recorded decision:
// not a fork, not a second server. One Runtime per run = one holder of epoch state,
// one config chain, one redaction layer.
import { Runtime } from '../../x-agent/mcp/dist/mcp/src/context.js';
import { callTool } from '../../x-agent/mcp/dist/mcp/src/server.js';
import { loadExternalHandlers } from '../../x-agent/mcp/dist/mcp/src/registry.js';
import { registerSecret } from '../../x-agent/mcp/dist/mcp/src/errors.js';

export async function createToolchain({ cwd = process.cwd(), providerKeys = {} } = {}) {
    await loadExternalHandlers();
    for (const v of Object.values(providerKeys)) {
        if (typeof v === 'string' && v.length >= 4) registerSecret(v);
    }
    const runtime = new Runtime({ cwd });
    return {
        runtime,
        async call(name, args = {}) {
            const res = await callTool(name, args, runtime);
            return { ok: !res.isError, data: JSON.parse(res.content[0].text) };
        },
        async dispose() {
            await runtime.disconnect();
        },
    };
}
```

During implementation, verify the exact dist export names once with `node -e "import('./x-agent/mcp/dist/mcp/src/registry.js').then(m => console.log(Object.keys(m)))"` — if `isUnimplemented` is exported, add the wp_compile placeholder guard described above; if not, assert `loadExternalHandlers()`'s returned report on first load lists the six external tools (and on a no-op second load, skip the assert).

- [ ] **Step 3: Run the test to PASS (this test needs the dist build: run `cd x-agent/mcp && npm ci && npm run build` first if dist imports fail), commit**

```bash
node --test pipeline/tests/toolchain.test.mjs
git add pipeline/lib/toolchain.mjs pipeline/tests/toolchain.test.mjs
git commit -m "pipeline: in-process toolchain shim — one Runtime, one epoch holder"
```

---

### Task 11: The runner (`run.mjs`) + M1 acceptance

**Files:**
- Create: `pipeline/run.mjs`
- Create: `pipeline/lib/report.mjs` (stub for now: budget + ledger sections; S9 completes it)
- Create: `pipeline/tests/accept/m1.sh`
- Test: `pipeline/tests/run.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - CLI: `node pipeline/run.mjs "<prompt>" [--config pipeline.config.json] [--resume <run_dir>] [--until <STAGE_ID>]`.
  - `runPipeline({prompt, configPath, resumeDir, until, cwd}) -> {runDir, state}` exported for tests.
  - Stage sequencing: static import of the nine stage modules in spec order; for each: skip if `state.completed` includes its id (resume — artifacts already on disk), else `await stage.run(ctx)`, push id, persist `state.json`. Stop after `--until`. On ANY throw: persist state, `ledger.flush()`, write `report.md` with the failure, re-throw after printing the structured error `{code, message, hint}` to stderr; exit code 1.
  - Run dir: `runs/<YYYYMMDD-HHMMSS>/` with subdirs `trees/ blocks/ packages/ images/` created up front. `--resume` reuses the given dir and its `state.json` and appends to the existing `ledger.jsonl` (spec: "a resumed run's ledger appends, never rewrites").
  - Budget printing after S1 is the runner's job (S1 sets `state.budget`): `this brief costs at most ${ceiling} calls (S=${S}, B=${B}, P=${P}, I=${I})` — printed before any second call because S1 is the only pre-ceiling stage.

Until Tasks 12–21 land their stage modules, create all nine as minimal placeholders that throw `PipelineError('not_implemented', 'stage <id> arrives with its milestone task')` — the run.test below only drives the machinery with two scripted in-test stage objects, so structure `run.mjs` with an injectable stage list: `runPipeline({..., stages = DEFAULT_STAGES})`.

- [ ] **Step 1: Write the failing test**

```js
// pipeline/tests/run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from '../run.mjs';
import { TASK_TYPES } from '../lib/config.mjs';

function setup() {
    const cwd = mkdtempSync(join(tmpdir(), 'x-pipeline-run-'));
    const tasks = Object.fromEntries(TASK_TYPES.map((t) => [t, { provider: 'fake', model: 'fixtures' }]));
    writeFileSync(join(cwd, 'pipeline.config.json'), JSON.stringify({ tasks }));
    return cwd;
}

test('stages run in order, state persists, --until stops, resume skips', async () => {
    const cwd = setup();
    const ran = [];
    const mk = (id) => ({ id, kind: 'deterministic', run: async (ctx) => { ran.push(id); ctx.state[id] = true; } });
    const stages = [mk('S1_brief'), mk('S2_read_instance'), mk('S3_tokens')];

    const { runDir } = await runPipeline({ prompt: 'p', cwd, until: 'S2_read_instance', stages, skipToolchain: true });
    assert.deepEqual(ran, ['S1_brief', 'S2_read_instance']);
    const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    assert.deepEqual(state.completed, ['S1_brief', 'S2_read_instance']);
    assert.ok(existsSync(join(runDir, 'trees')));

    await runPipeline({ prompt: 'p', cwd, resumeDir: runDir, stages, skipToolchain: true });
    assert.deepEqual(ran, ['S1_brief', 'S2_read_instance', 'S3_tokens']);   // completed stages not re-run
});

test('a stage failure still flushes ledger and report, and the error surfaces', async () => {
    const cwd = setup();
    const boom = { id: 'S1_brief', kind: 'generative', run: async () => { const e = new Error('gate dead'); e.code = 'contract_failed'; throw e; } };
    let thrown;
    try {
        await runPipeline({ prompt: 'p', cwd, stages: [boom], skipToolchain: true });
    } catch (e) { thrown = e; }
    assert.equal(thrown.code, 'contract_failed');
    const runs = join(cwd, 'runs');
    const dir = join(runs, (await import('node:fs')).readdirSync(runs)[0]);
    assert.ok(existsSync(join(dir, 'ledger.json')));
    assert.ok(existsSync(join(dir, 'report.md')));
    assert.match(readFileSync(join(dir, 'report.md'), 'utf8'), /contract_failed/);
});
```

Note the `skipToolchain: true` test seam: the runner skips `createToolchain()` and leaves `ctx.call = null`. Real runs always build it. Runs land in `<cwd>/runs/` — the runner resolves `runs/` relative to its `cwd` option (default `process.cwd()`), so tests stay out of the repo.

- [ ] **Step 2: Run to verify FAIL, implement `run.mjs` + `report.mjs` stub**

`run.mjs` shape:

```js
#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadPipelineConfig, readProviderKeys } from './lib/config.mjs';
import { createProviders } from './providers/index.mjs';
import { createLlm } from './lib/llm.mjs';
import { createToolchain } from './lib/toolchain.mjs';
import { BudgetMeter, Ledger } from './budget.mjs';
import { writeReport } from './lib/report.mjs';
import * as s1 from './stages/s1-brief.mjs';
// ... s2..s9
const DEFAULT_STAGES = [s1, s2, s3, s4, s5, s6, s7, s8, s9];

export async function runPipeline({ prompt, configPath, resumeDir, until, cwd = process.cwd(), stages = DEFAULT_STAGES, skipToolchain = false }) {
    const config = loadPipelineConfig(configPath ?? join(cwd, 'pipeline.config.json'));
    const keys = readProviderKeys(cwd);
    const providers = await createProviders({ config, keys });
    const runDir = resumeDir ?? join(cwd, 'runs', timestamp());
    for (const d of ['', 'trees', 'blocks', 'packages', 'images']) mkdirSync(join(runDir, d), { recursive: true });
    const state = resumeDir && existsSync(join(runDir, 'state.json'))
        ? JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'))
        : { completed: [] };
    const budget = new BudgetMeter({ hard_cap: config.budget_hard_cap });
    if (state.budget) budget.setCeiling(state.budget.ceiling);          // resume: ceiling is already fixed
    const ledger = new Ledger(runDir);
    const toolchain = skipToolchain ? null : await createToolchain({ cwd, providerKeys: keys });
    const ctx = { prompt, runDir, config, call: toolchain?.call ?? null, llm: createLlm({ providers, promptsDir: config.prompts_dir, budget, ledger }), budget, ledger, state, log: (m) => console.error(`[x-pipeline] ${m}`) };
    try {
        for (const stage of stages) {
            if (state.completed.includes(stage.id)) { ctx.log(`${stage.id}: complete (resume)`); continue; }
            ctx.log(`${stage.id}: running`);
            await stage.run(ctx);
            state.completed.push(stage.id);
            writeFileSync(join(runDir, 'state.json'), JSON.stringify(state, null, 2));
            if (until && stage.id === until) break;
        }
        return { runDir, state };
    } catch (e) {
        state.failure = { code: e.code ?? 'internal', message: e.message, hint: e.hint ?? '' };
        writeFileSync(join(runDir, 'state.json'), JSON.stringify(state, null, 2));
        throw e;
    } finally {
        ledger.flush();
        writeReport(runDir, { state, budget, ledger });
        await toolchain?.dispose();
    }
}
```

Plus `timestamp()` (`new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)` shaped as `YYYYMMDD-HHMMSS`), a tiny argv parser for `--config/--resume/--until` and the positional prompt, and `if (import.meta.url === pathToFileURL(process.argv[1]).href)` main guard that prints `{code, message, hint}` on failure and `process.exit(1)`.

`report.mjs` stub: `writeReport(runDir, {state, budget, ledger})` writes `report.md` with: run status (completed stages / failure block with code+message+hint), `## Budget` (ceiling, spent, and S/B/P/I when `state.budget` exists), `## Ledger` (a table of task_type/label/provider/model/attempt/outcome). S9's task extends it with gates/dead artifacts/predicted-vs-actual.

- [ ] **Step 3: Run the tests to PASS**

- [ ] **Step 4: Write the M1 acceptance script `pipeline/tests/accept/m1.sh`**

```bash
#!/usr/bin/env bash
# M1 acceptance (spec M1_provider_shim_and_budget):
#  - fake routing resolves at preflight; missing task entry fails naming the task
#  - ceiling for the S=3,B=1,P=1,I=2 fixture is 16; the 17th call throws budget_exceeded
#  - identical runs produce identical ledgers (timestamps excepted)
set -euo pipefail
cd "$(dirname "$0")/../../.."
node --test pipeline/tests/
node - <<'EOF'
import { computeBudget, BudgetMeter, Ledger } from './pipeline/budget.mjs';
import { readFileSync } from 'node:fs';
const brief = JSON.parse(readFileSync('pipeline/fixtures/brief.m1.json', 'utf8'));
const b = computeBudget(brief);
if (b.ceiling !== 16) throw new Error(`ceiling ${b.ceiling} != 16`);
console.log(`this brief costs at most ${b.ceiling} calls (S=${b.S}, B=${b.B}, P=${b.P}, I=${b.I})`);
const m = new BudgetMeter({}); m.spend('brief','brief'); m.setCeiling(16);
for (let i = 2; i <= 16; i++) m.spend('tree', `c${i}`);
try { m.spend('tree', 'c17'); throw new Error('17th call did NOT throw'); }
catch (e) { if (e.code !== 'budget_exceeded') throw e; console.log('17th call: budget_exceeded ✓'); }
EOF
echo "M1 ACCEPTED"
```

Mark executable, run it, expect `M1 ACCEPTED`. (The identical-ledger clause is fully proven by `m6-determinism.sh`; the unit suite's deterministic-sort test covers the mechanism at M1 time.)

- [ ] **Step 5: Update PROGRESS.pipeline.json (M1 milestone entry + any decisions) and commit**

```bash
git add pipeline PROGRESS.pipeline.json
git commit -m "pipeline: runner — stage sequencing, resume, structured failure; M1 accepted"
```

---

### Task 12: `prompts/brief.md` + S1 stage (`stages/s1-brief.mjs`)

**Files:**
- Create: `pipeline/prompts/brief.md`
- Create: `pipeline/stages/s1-brief.mjs` (replacing the placeholder)
- Test: `pipeline/tests/s1-brief.test.mjs`

**Interfaces:**
- Consumes: `ctx.llm.generate`, `validateSchema` + `brief.schema.json`, `computeBudget`, `ctx.budget.setCeiling`.
- Produces: `runs/<ts>/brief.json`; `ctx.state.brief`; `ctx.state.budget = {S,B,P,I,base,ceiling}`; the printed budget line. Downstream stages read `ctx.state.brief` (S2–S8) and `ctx.state.budget` (report).

**Prompt template.** `pipeline/prompts/brief.md` is assembled from wp-blocks SKILL excerpts — the skill stays the single source of truth; a template that contradicts it is a bug. Structure:

```markdown
---
task_type: brief
required: [prompt, contract]
---
You are planning a WordPress site build that a deterministic pipeline will execute.
You make ALL the creative decisions now — nothing is renegotiated later. Your output
fixes the bill: one tree call per section, one build per custom block, one build per
schema package, one image per image_intent.

<verbatim excerpt: x-agent/skills/wp-blocks/SKILL.md §2 "Design quality" — the
art-direction discipline ("Before the tokens, write the art direction. Two or three
sentences...") — copy the section's normative paragraphs>

<verbatim excerpt: wp-blocks SKILL.md R7 opening + the vocabulary-gap ladder summary —
a custom block exists ONLY where composition, styles, variations and tokens provably
cannot express the section; write that argument into gap_argument>

<verbatim excerpt: wp-schema SKILL.md S1 "Model before UI" + S6 (anonymous writes) —
a schema package exists ONLY where data has a lifecycle; write that argument into
lifecycle_argument>

THE REQUEST, verbatim:
{{prompt}}

Respond with ONLY a JSON document valid against this contract (brief.schema.json):
{{contract}}

Rules:
- Sections are the units of generation: one hero-class statement section, then one
  section per distinct job the page does. Do not pad; every section must earn its call.
- image_intent only where a generated image does real work; it is one metered call.
- custom_blocks and schema_packages are empty arrays unless their arguments win.
- navigation/footer items reference pages[].slug entries only.
- Exactly one page carries front_page: true.
```

At implementation time, open `x-agent/skills/wp-blocks/SKILL.md` (§2 starts near line 64; R7 near line 304) and `x-agent/skills/wp-schema/SKILL.md` (S1/S6 in the rules block starting near line 54) and paste the excerpts verbatim where marked. `{{contract}}` is the brief.schema.json content — passed in the payload so schema and prompt can never drift.

**Stage.** Mechanical cross-checks beyond the JSON Schema go into the same `validate` callback so a violation triggers the ONE schema-retry: every `sections[].uses_custom_block` resolves to a `custom_blocks[].slug`; every `navigation.items[].page_slug` and `footer.items[].page_slug` resolves to a `pages[].slug`; exactly one page has `front_page: true`; section ids unique per page; custom block and package slugs unique.

```js
// pipeline/stages/s1-brief.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSchema } from '../lib/schema.mjs';
import { computeBudget } from '../budget.mjs';

const schema = JSON.parse(readFileSync(new URL('../schemas/brief.schema.json', import.meta.url), 'utf8'));

export const id = 'S1_brief';
export const kind = 'generative';

export function crossChecks(brief) {
    const issues = [];
    const blockSlugs = new Set((brief.custom_blocks ?? []).map((b) => b.slug));
    const pageSlugs = new Set((brief.pages ?? []).map((p) => p.slug));
    (brief.pages ?? []).forEach((p, pi) => {
        const seen = new Set();
        (p.sections ?? []).forEach((s, si) => {
            if (s.uses_custom_block && !blockSlugs.has(s.uses_custom_block)) {
                issues.push({ path: `/pages/${pi}/sections/${si}/uses_custom_block`, message: `no custom_blocks entry "${s.uses_custom_block}"` });
            }
            if (seen.has(s.id)) issues.push({ path: `/pages/${pi}/sections/${si}/id`, message: `duplicate section id "${s.id}"` });
            seen.add(s.id);
        });
    });
    for (const [field, items] of [['navigation', brief.navigation?.items], ['footer', brief.footer?.items]]) {
        (items ?? []).forEach((it, i) => {
            if (!pageSlugs.has(it.page_slug)) issues.push({ path: `/${field}/items/${i}/page_slug`, message: `no page "${it.page_slug}"` });
        });
    }
    const fronts = (brief.pages ?? []).filter((p) => p.front_page).length;
    if (fronts !== 1) issues.push({ path: '/pages', message: `exactly one page must set front_page:true (got ${fronts})` });
    return issues;
}

export async function run(ctx) {
    const { value: brief } = await ctx.llm.generate({
        task_type: 'brief',
        label: 'brief',
        payload: { prompt: ctx.prompt, contract: schema },
        validate: (v) => [...validateSchema(schema, v), ...crossChecks(v)],
    });
    writeFileSync(join(ctx.runDir, 'brief.json'), JSON.stringify(brief, null, 2));
    ctx.state.brief = brief;
    const budget = computeBudget(brief);
    ctx.budget.setCeiling(budget.ceiling);          // throws budget_exceeded if > hard cap — before call #2
    ctx.state.budget = budget;
    ctx.log(`this brief costs at most ${budget.ceiling} calls (S=${budget.S}, B=${budget.B}, P=${budget.P}, I=${budget.I})`);
}
```

- [ ] **Step 1: Write the failing test** — drive `run()` with a hand-built ctx: fake-provider-backed `llm` (fixture `brief.brief.json` from Task 7), a temp runDir, a real `BudgetMeter`. Assert: `brief.json` written and equal to the fixture brief; `ctx.state.budget.ceiling === 16`; the log line printed (capture `ctx.log` calls in an array). Second test: a scripted llm whose first output violates a cross-check (nav pointing at a missing page) and whose second output is clean → `attempts === 2`. Third: `crossChecks` unit cases (each rule violated once).

- [ ] **Step 2: Run to FAIL, implement (code above + template file), run to PASS**

- [ ] **Step 3: Commit**

```bash
git add pipeline/prompts/brief.md pipeline/stages/s1-brief.mjs pipeline/tests/s1-brief.test.mjs
git commit -m "pipeline: S1 brief — the plan-fixing call; budget printed before call #2"
```

---

### Task 13: S2 read-instance (`stages/s2-read-instance.mjs`)

Deterministic, zero LLM calls: connect, read the manifest, pick each section's starting pattern, slice the manifest per section role.

**Files:**
- Create: `pipeline/stages/s2-read-instance.mjs`
- Test: `pipeline/tests/s2-read-instance.test.mjs`

**Interfaces:**
- Consumes: `ctx.call` (`wp_connect`, `wp_manifest`, `wp_patterns`), `ctx.state.brief`.
- Produces: `runs/<ts>/instance.json` (`{site_url, posture, fingerprint, wp_version, theme_tokens}`); `runs/<ts>/sections/<page>--<sectionId>.json` one per section: `{page, section, manifest_slice, pattern: {name, title, parsed_tree} | null}`; `ctx.state.instance`, `ctx.state.fingerprint`, `ctx.state.sections = [{key, page, id, file}]`. The section files are S4's per-call payloads and S7's baseline source.

**Deterministic mappings** (module-level consts):

```js
const ROLE_FAMILIES = {
    header:      ['core/group', 'core/site-title', 'core/navigation', 'core/buttons', 'core/button'],
    hero:        ['core/cover', 'core/group', 'core/heading', 'core/paragraph', 'core/buttons', 'core/button', 'core/image', 'core/spacer'],
    features:    ['core/columns', 'core/column', 'core/group', 'core/heading', 'core/paragraph', 'core/image', 'core/list', 'core/list-item'],
    gallery:     ['core/gallery', 'core/image', 'core/group', 'core/heading'],
    testimonial: ['core/quote', 'core/group', 'core/columns', 'core/column', 'core/paragraph', 'core/image', 'core/heading'],
    pricing:     ['core/columns', 'core/column', 'core/group', 'core/heading', 'core/paragraph', 'core/list', 'core/list-item', 'core/buttons', 'core/button', 'core/separator'],
    faq:         ['core/details', 'core/group', 'core/heading', 'core/paragraph'],
    cta:         ['core/group', 'core/cover', 'core/heading', 'core/paragraph', 'core/buttons', 'core/button'],
    contact:     ['core/group', 'core/columns', 'core/column', 'core/heading', 'core/paragraph', 'core/social-links', 'core/social-link'],
    content:     ['core/group', 'core/heading', 'core/paragraph', 'core/image', 'core/list', 'core/list-item', 'core/separator', 'core/quote'],
    footer:      ['core/group', 'core/columns', 'core/column', 'core/paragraph', 'core/site-title', 'core/social-links', 'core/social-link'],
    section:     ['core/group', 'core/columns', 'core/column', 'core/heading', 'core/paragraph', 'core/image', 'core/buttons', 'core/button'],
};
const ROLE_PATTERN_QUERIES = {
    header: ['header'], hero: ['hero', 'cover', 'banner'], features: ['features', 'services', 'columns'],
    gallery: ['gallery'], testimonial: ['testimonial', 'quote'], pricing: ['pricing'],
    faq: ['faq'], cta: ['call to action', 'cta'], contact: ['contact'],
    content: ['text', 'about'], footer: ['footer'], section: ['text'],
};
```

Stage logic:

1. `wp_connect {}` → refuse (`PipelineError('preflight_failed')`) when `data.posture !== 'toolchain'` (spec: any instance in toolchain posture; extend-tier stages would die at S3 anyway — fail loudly now). Record `fingerprint`.
2. `wp_manifest {}` → keep `theme_tokens` whole; build `blocksByName` from `data.blocks`.
3. `wp_patterns {}` once → for each section role, first query term with matches wins; among matches sort by `name` and take the first (deterministic pick). A section whose role matches nothing gets `pattern: null`.
4. Slice per section: `manifest_slice = {blocks: {name: {attributes, supports, parent, styles?, variations?} for name in ROLE_FAMILIES[role] if present}}` — plus, when `section.uses_custom_block`, the brief's custom block declaration under `manifest_slice.declared_custom_block` (`{name: 'agent/<slug>', attributes: <brief attrs>}`) so the tree task knows the shape of a block that does not exist yet.
5. Write `instance.json` + one file per section under `runs/<ts>/sections/`; fill `ctx.state`.

Failure of any tool call (`!ok`) → `PipelineError(data.code ?? 'companion_error', data.message, data.hint)`.

- [ ] **Step 1: Write the failing test** — hand-built ctx with a scripted `call` returning canned `wp_connect` (toolchain posture, fingerprint `f1`), `wp_manifest` (a dozen core blocks incl. `core/cover`, `theme_tokens` with `spacingSizes`), `wp_patterns` (two hero-ish patterns out of name-order to prove the deterministic pick, one header pattern). Brief = the M1 fixture. Assert: `instance.json` written; three section files; hero section's slice contains `core/cover` but not `core/navigation`; hero pattern is the alphabetically-first match; the `uses_custom_block` section carries `declared_custom_block.name === 'agent/signup-banner'`; production posture → throws `preflight_failed`; a `{ok:false}` connect → throws with the envelope's code.

- [ ] **Step 2: Run to FAIL, implement, run to PASS, commit**

```bash
git add pipeline/stages/s2-read-instance.mjs pipeline/tests/s2-read-instance.test.mjs
git commit -m "pipeline: S2 read-instance — manifest slices and pattern picks, zero calls"
```

---

### Task 14: `prompts/tokens.md` + S3 stage + M2 acceptance

**Files:**
- Create: `pipeline/prompts/tokens.md`
- Create: `pipeline/stages/s3-tokens.mjs`
- Create: `pipeline/tests/accept/m2.sh`
- Test: `pipeline/tests/s3-tokens.test.mjs`

**Interfaces:**
- Consumes: `ctx.state.brief`, `ctx.state.instance.theme_tokens`, `ctx.llm.generate`, `ctx.call` (`wp_tokens_apply`).
- Produces: `runs/<ts>/tokens.json` (the applied DesignTokens — source of truth per R9), `runs/<ts>/tokens-dry-run.json` (preview + diff evidence), updated `ctx.state.fingerprint` (the epoch moved), `instance.json` rewritten with the new fingerprint.

**The R9 discipline, mechanically.** The theme's own spacing/layout pass through verbatim:

```js
export function deriveThemeSpacing(themeTokens) {
    const sizes = themeTokens?.spacing?.spacingSizes ?? [];
    return { scale_unit: 'px', steps: sizes.map((s) => ({ slug: String(s.slug), size: String(s.size) })) };
}
export function deriveThemeLayout(themeTokens) {
    return { contentSize: String(themeTokens?.layout?.contentSize ?? ''), wideSize: String(themeTokens?.layout?.wideSize ?? '') };
}
```

These deterministic derivations go into the PAYLOAD (context the model must echo — R13: the token set is still authored by the model against the manifest); the stage's `validate` then asserts mechanically:

- shape sanity: `palette` (array), `spacing`, `typography`, `layout` all present (DesignTokensSchema requires all four — token-loss lesson from the session log);
- `deepEqual(tokens.spacing, payload.theme_spacing)` and `deepEqual(tokens.layout, payload.theme_layout)` — byte-equal pass-through, the M2 acceptance clause;
- every `brief.palette[].color` hex appears among `tokens.palette[].color` (case-insensitive) — "every brief color present";
- `base` and `contrast` slugs present in `tokens.palette` (keeps theme template parts resolving — Hearth & Crumb lesson).

Gate sequence in `run(ctx)`:

1. `generate({task_type:'tokens', label:'tokens', payload, validate})` → tokens.
2. `wp_tokens_apply {...tokens, dry_run: true}` → on `!ok` treat the envelope as contract issues and (if the schema-retry is still unburned — track `attempts` from generate) re-generate once with the envelope message appended; else fail the run. On success: deterministic diff review — `diff_against_instance` entries whose `group` is a spacing/layout group must be empty (the differ's groups are discoverable in `templates/theme-json/emitter.ts`; assert on `['spacing', 'layout'].some(g => d.group.includes(g))` and refine at implementation against the real `ThemeTokenDiff.group` values), and every brief palette hex must appear in `theme_json_preview`'s palette. Write `tokens-dry-run.json`.
3. `wp_tokens_apply {...tokens}` (real) → `data.fingerprint` is the new epoch: update `ctx.state.fingerprint`, rewrite `instance.json`.
4. Write `tokens.json`.

**Prompt template** `pipeline/prompts/tokens.md`:

```markdown
---
task_type: tokens
required: [identity, art_direction, palette, theme_spacing, theme_layout, contract_note]
---
You are the design system author for one WordPress site. Output a DesignTokens JSON
document — the source of truth the whole site compiles from.

<verbatim excerpt: wp-blocks SKILL.md R9 — greenfield ordering: tokens FIRST,
DesignTokens JSON kept as source of truth, theme.json is a compile target>

<verbatim excerpt: wp-blocks SKILL.md §2 — the palette discipline paragraphs:
roles, contrast, restraint>

Site: {{identity}}
Art direction: {{art_direction}}
The brief's palette (every color below MUST appear in your palette; keep slugs
lowercase-kebab; ALSO keep the theme's own `base` and `contrast` slugs, mapped
onto this world): {{palette}}

R9 pass-through — copy these two sections into your output BYTE-FOR-BYTE, they
are the theme's own and are not yours to redesign:
"spacing": {{theme_spacing}}
"layout": {{theme_layout}}

{{contract_note}}

Respond with ONLY the DesignTokens JSON object: {palette, spacing, typography, layout}.
Typography: font families as system stacks (no font files), a display size with fluid
clamp() if the art direction calls for one.
```

(`contract_note` carries the DesignTokens field summary from `contract/schemas/design-tokens.schema.json` — pass the schema's `properties` keys and the palette item shape so prompt and contract cannot drift.)

- [ ] **Step 1: Write the failing test** — scripted ctx: llm returns a good token set (echoing derived spacing/layout, containing brief hexes + base/contrast); scripted `call` asserts dry_run first then real apply, returns `{ok:true, data:{diff_against_instance: [], theme_json_preview: {...}, fingerprint: 'f2'}}` both times. Assert: tokens.json + tokens-dry-run.json written, `ctx.state.fingerprint === 'f2'`. Second test: llm emits tokens with its own spacing → validate fails → retry consumed → second output clean → passes with `attempts 2`. Third: `deriveThemeSpacing` unit case from a `spacingSizes` sample. Fourth: dry-run diff containing a spacing-group entry → run throws (gate, no bypass).

- [ ] **Step 2: Run to FAIL, implement stage + template (paste the real skill excerpts), run to PASS**

- [ ] **Step 3: Write `pipeline/tests/accept/m2.sh`** — the first LIVE acceptance:

```bash
#!/usr/bin/env bash
# M2 acceptance (spec M2_brief_and_tokens): S1+S2+S3 against a live Playground
# with one real provider (anthropic by default — needs anthropic_api_key in .x-agent.json).
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT=9410
node tools/playground/stop.mjs --port $PORT 2>/dev/null || true
node tools/playground/boot.mjs --profile core-only --posture toolchain --port $PORT --plugin ./x-companion --slot pipeline-accept
trap 'node tools/playground/stop.mjs --port '$PORT' 2>/dev/null || true' EXIT
python3 - <<'EOF'
import json
d = json.load(open('tools/.runtime/pipeline-accept.json'))
cfg = {"url": d["url"], "user": d["admin"]["user"], "app_password": d["admin"]["app_password"]}
existing = json.load(open('.x-agent.json')) if __import__('os').path.exists('.x-agent.json') else {}
for k in ('anthropic_api_key','openai_api_key','cerebras_api_key','gemini_api_key'):
    if k in existing: cfg[k] = existing[k]
json.dump(cfg, open('.x-agent.json','w'), indent=2)
EOF
node pipeline/run.mjs "A one-page site for a small artisan bakery: warm, floury, honest. Hero, what we bake, and a newsletter signup." \
    --config pipeline/config.example.json --until S3_tokens
RUN_DIR=$(ls -td runs/*/ | head -1)
node - "$RUN_DIR" <<'EOF'
import { readFileSync } from 'node:fs';
import { validateSchema } from './pipeline/lib/schema.mjs';
const dir = process.argv[2];
const schema = JSON.parse(readFileSync('pipeline/schemas/brief.schema.json', 'utf8'));
const brief = JSON.parse(readFileSync(`${dir}/brief.json`, 'utf8'));
const issues = validateSchema(schema, brief);
if (issues.length) throw new Error(`brief.json invalid: ${JSON.stringify(issues)}`);
const tokens = JSON.parse(readFileSync(`${dir}/tokens.json`, 'utf8'));
const instance = JSON.parse(readFileSync(`${dir}/instance.json`, 'utf8'));
const derivedSteps = instance.theme_tokens.spacing.spacingSizes.map(s => ({slug: String(s.slug), size: String(s.size)}));
if (JSON.stringify(tokens.spacing.steps) !== JSON.stringify(derivedSteps)) throw new Error('R9 spacing pass-through violated');
const dry = JSON.parse(readFileSync(`${dir}/tokens-dry-run.json`, 'utf8'));
for (const p of brief.palette) {
    if (!JSON.stringify(dry).toLowerCase().includes(p.color.toLowerCase())) throw new Error(`brief color ${p.color} missing from dry-run evidence`);
}
console.log('M2 ACCEPTED — budget:', JSON.parse(readFileSync(`${dir}/state.json`,'utf8')).budget);
EOF
```

Adjust the config used here at execution time: `config.example.json` routes to real providers — when only one key is available, generate a temp config routing every task to that provider. The fingerprint-moved clause is asserted by comparing `instance.json`'s fingerprint against the boot-time `wp_connect` value recorded in `state.json` (add `state.instance.initial_fingerprint` in S2 and assert here they differ after S3).

- [ ] **Step 4: Run `pipeline/tests/accept/m2.sh` to a green `M2 ACCEPTED`** (requires a real provider key; document the run in PROGRESS.pipeline.json evidence)

- [ ] **Step 5: Commit**

```bash
git add pipeline PROGRESS.pipeline.json
git commit -m "pipeline: S3 tokens — R9 pass-through asserted mechanically; M2 accepted live"
```

---

### Task 15: Gate screening (`lib/gates.mjs`) + `prompts/tree.md` + S4 stage

**Files:**
- Create: `pipeline/lib/gates.mjs`
- Create: `pipeline/prompts/tree.md`
- Create: `pipeline/stages/s4-sections.mjs`
- Test: `pipeline/tests/gates.test.mjs`, `pipeline/tests/s4-sections.test.mjs`

**Interfaces:**
- Consumes: `ctx.call` (`wp_validate`), `ctx.llm`, `pLimit`, section files from S2, `ctx.state.fingerprint`, applied token slugs from `runs/<ts>/tokens.json`.
- Produces:
  - `screenTreeDiagnostics(result, {allowedUnknown}) -> {status: 'pass'|'fail', deferred: string[], failures: [{code, path, message}]}` in `gates.mjs` — the mechanical warning review, shared by S4, S7 and S8:
    - `valid:false` → every error diagnostic is a failure UNLESS `code === 'E_UNKNOWN_BLOCK'` and the block name in the message/path resolves into `allowedUnknown` (the brief-declared `agent/<slug>` set — those blocks are born in S5 and installed in S8; the deferral is re-checked at the final epoch). Any deferral is recorded in `deferred`.
    - Warning screen: `W_ATTR_UNKNOWN` → failure (spec: fails the artifact). `W_STATIC_NEEDS_HARNESS`, `W_HINT_ALLOWED_BLOCKS`, `W_HINT_TEMPLATE_LOCK` → pass. `W_STYLE_UNKNOWN` → failure (an is-style-* not registered at this fingerprint is an invented style — conservative; record the decision in PROGRESS).
  - `localTreeCheck(tree, {epoch}) -> issues[]` in `gates.mjs`: shape `{version: 1, epoch: <current fingerprint>, blocks: array, nothing else}`; every node has `name` matching `^[a-z0-9-]+/[a-z0-9-]+$`; no `innerHTML`/`innerContent` keys anywhere (R1: markup never enters a tree). Used as the llm `validate` so malformed trees burn the schema-retry, not a wp_validate round trip.
  - S4 stage: for every section (all pages), through `pLimit(ctx.config.concurrency)`: `generate({task_type:'tree', label: '<page>/<sectionId>', payload, validate: localTreeCheck})` → `wp_validate(tree)` → `screenTreeDiagnostics`. Writes `runs/<ts>/trees/<page>--<sectionId>.json` (`{tree, gate: {status, deferred, failures, diagnostics}}`). Populates `ctx.state.artifacts.trees[key] = {status, deferred, failures}`. A `contract_failed` throw from `generate` (schema-retry burned) is caught and recorded as `{status:'fail', failures:[...]}` — S7 owns what happens next. THE STAGE NEVER RETRIES BEYOND THE LANE'S ONE SCHEMA-RETRY (temptation log candidate).

**Payload per section:** `{section (brief entry), page: {slug, title}, manifest_slice, pattern_tree (parsed_tree | null), token_slugs: {palette: [slugs], spacing: [slugs], font_sizes: [slugs]}, epoch (current fingerprint), image_note}` — `image_note` explains the placeholder discipline when `section.image_intent` exists: image nodes use a `wp_placeholder`-minted URL only in S8's world; at tree time the node carries `attributes.metadata.imageIntent` with the intent text and geometry attributes (width/aspectRatio/scale), pixels stay provisional. Token slugs come from `tokens.json` (palette slugs, spacing step slugs, typography font-size slugs).

**Prompt template** `pipeline/prompts/tree.md`:

```markdown
---
task_type: tree
required: [section, page, manifest_slice, pattern_tree, token_slugs, epoch, image_note]
---
You are generating ONE section of a WordPress page as TreeIR JSON. Code decides
whether it ships; there is no conversation.

<verbatim excerpt: wp-blocks SKILL.md R1 — never hand-write serialized markup;
TreeIR only>
<verbatim excerpt: R2 — vocabulary is the manifest at the current fingerprint;
never assume a block or attribute exists>
<verbatim excerpt: R4/expression ladder summary — styling ONLY via token slugs and
supports attributes; raw CSS/HTML styling is a defect>
<verbatim excerpt: R5 — the retrieve-first discipline: adapt the pattern idiom
before inventing>

Page: {{page}}
Section brief: {{section}}
Your block vocabulary for this section (manifest slice, with attribute schemas —
use NOTHING outside it, and no attributes absent from it): {{manifest_slice}}
Starting pattern (adapt its idiom; null means compose fresh from the vocabulary):
{{pattern_tree}}
Design tokens available (slugs only — backgroundColor/textColor/fontSize/spacing
presets): {{token_slugs}}
{{image_note}}

Output ONLY a TreeIR JSON document: {"version": 1, "epoch": "{{epoch}}", "blocks": [...]}
- blocks[] is THIS SECTION ONLY (typically one wrapping core/group or core/cover).
- Write real copy from the section brief's copy notes — no lorem ipsum.
- If manifest_slice.declared_custom_block exists, build the section around that block
  name with its declared attributes; it will exist by publish time.
```

- [ ] **Step 1: Write the failing gates test** — `screenTreeDiagnostics` cases: clean valid → pass; `W_STATIC_NEEDS_HARNESS` warning → pass; `W_ATTR_UNKNOWN` → fail; `E_UNKNOWN_BLOCK` naming `agent/signup-banner` with `allowedUnknown = new Set(['agent/signup-banner'])` → pass with `deferred: ['agent/signup-banner']`; same code, name not allowed → fail; `W_STYLE_UNKNOWN` → fail. `localTreeCheck`: wrong epoch → issue; `innerHTML` smuggled into a node → issue naming the path.

- [ ] **Step 2: Run to FAIL, implement `gates.mjs`, run to PASS**

- [ ] **Step 3: Write the failing S4 test** — ctx with fake-provider llm (fixtures `tree.home-hero.json`, `tree.home-features.json`, `tree.home-signup.json`: two clean trees + the signup tree using `agent/signup-banner`) and scripted `wp_validate` (clean for hero; `W_STATIC_NEEDS_HARNESS` for features; `E_UNKNOWN_BLOCK agent/signup-banner` for signup). Assert: three tree files with gates `pass/pass/pass`, signup's `deferred` lists the block, `ctx.state.artifacts.trees` populated, and the limiter was respected (wrap `call` to count concurrent entries like the Task 1 pLimit test). Second test: `wp_validate` returns `W_ATTR_UNKNOWN` for one section → that artifact records `status:'fail'` and the stage still completes (no throw).

- [ ] **Step 4: Run to FAIL, implement `s4-sections.mjs` + `tree.md` (paste real excerpts), run to PASS**

- [ ] **Step 5: Commit**

```bash
git add pipeline/lib/gates.mjs pipeline/prompts/tree.md pipeline/stages/s4-sections.mjs pipeline/tests/gates.test.mjs pipeline/tests/s4-sections.test.mjs
git commit -m "pipeline: S4 sections — concurrent tree fan-out, mechanical diagnostic screen"
```

---

### Task 16: `prompts/repair.md` + S7 stage + M3 acceptance

**Files:**
- Create: `pipeline/prompts/repair.md`
- Create: `pipeline/stages/s7-repair.mjs`
- Create: `pipeline/tests/accept/m3.sh` + `pipeline/fixtures/poisoned-prompts/` (a prompts dir whose `tree.md` demands an attribute the manifest lacks)
- Test: `pipeline/tests/s7-repair.test.mjs`

**Interfaces:**
- Consumes: `ctx.state.artifacts` (trees/blocks/packages outcomes), `ctx.llm` (maxAttempts: 1), `ctx.call`, gate helpers from `lib/gates.mjs` (and Task 17/18's `blockGate`/`schemaGate` — S7 calls whichever gate matches the artifact kind; at this task only the tree path exists, the block/schema paths join in Tasks 17/18).
- Produces: repaired artifacts written over the failed ones (same paths); `ctx.state.artifacts.*[key].status` updated to `'repaired'` or `'dead'`; dead trees substituted with their pattern baseline; `ctx.state.dead = [{kind, key, diagnostics}]` for the report. Spec rules enforced: at most ONE repair call per failed artifact; a second failure is a dead artifact; dead tree → section published with the pattern baseline; dead block/package → dropped from the plan AND every tree whose `deferred` referenced it re-screened (with the dead name removed from `allowedUnknown`) — trees that now fail also fall back to their pattern baseline. The pipeline never improvises.

```js
// pipeline/stages/s7-repair.mjs — shape
export const id = 'S7_repair';
export const kind = 'generative';

export async function run(ctx) {
    const arts = ctx.state.artifacts ?? {};
    ctx.state.dead = ctx.state.dead ?? [];

    // blocks and packages first: their deaths change what trees may defer to
    for (const kind of ['blocks', 'packages']) {
        for (const [key, art] of Object.entries(arts[kind] ?? {})) {
            if (art.status !== 'fail') continue;
            const repaired = await repairOnce(ctx, kind, key, art);      // ≤1 call + its own gate
            if (!repaired) { art.status = 'dead'; ctx.state.dead.push({ kind, key, diagnostics: art.failures }); }
            else art.status = 'repaired';
        }
    }
    const deadBlocks = new Set(Object.entries(arts.blocks ?? {}).filter(([, a]) => a.status === 'dead').map(([k]) => `agent/${k}`));

    for (const [key, art] of Object.entries(arts.trees ?? {})) {
        if (art.status === 'fail') {
            const repaired = await repairOnce(ctx, 'trees', key, art);
            if (!repaired) { substituteBaseline(ctx, key); art.status = 'dead'; ctx.state.dead.push({ kind: 'trees', key, diagnostics: art.failures }); }
            else art.status = 'repaired';
        } else if ((art.deferred ?? []).some((n) => deadBlocks.has(n))) {
            // the block this tree waited for is dead: re-gate without it (spec: re-gated)
            const stillValid = await regate(ctx, key, deadBlocks);
            if (!stillValid) { substituteBaseline(ctx, key); art.status = 'dead'; ctx.state.dead.push({ kind: 'trees', key, diagnostics: [{ code: 'E_UNKNOWN_BLOCK', message: `references dead block(s) ${[...deadBlocks].join(', ')}` }] }); }
        }
    }
}
```

`repairOnce(ctx, kind, key, art)`: payload `{artifact: <the failed tree JSON | the failed file map>, diagnostics: art.failures (VERBATIM — the spec's words), original_payload_note}`; `generate({task_type:'repair', label: `${kind}/${key}`, maxAttempts: 1, validate: <same local check as the original task>})`; on `contract_failed`/`fixture_missing` catch → return false; else run the SAME gate as the original stage (tree → wp_validate + screen; block → write files + `blockGate`; package → write + `schemaGate`); return gate pass. `substituteBaseline(ctx, key)`: load the section file's `pattern.parsed_tree`; if null, the minimal fallback `[{name:'core/group', attributes:{}, innerBlocks:[{name:'core/heading', attributes:{content: section brief title-cased id}, innerBlocks:[]}, {name:'core/paragraph', attributes:{content: section.copy_notes}, innerBlocks:[]}]}]`; overwrite `runs/<ts>/trees/<key>.json` with `{tree: {version:1, epoch, blocks: baseline}, gate: {status:'baseline'}}`. Baselines are wp_validated in S8 as part of the assembled page (they are pattern/manifest material, not LLM output).

**Prompt template** `pipeline/prompts/repair.md`:

```markdown
---
task_type: repair
required: [artifact, diagnostics, original_payload_note]
---
An artifact failed its gate. You get EXACTLY ONE attempt to replace it; a second
failure kills the artifact and its slot falls back to a baseline. Do not redesign —
fix precisely what the diagnostics name and change nothing else.

The failed artifact:
{{artifact}}

The gate's diagnostics, verbatim:
{{diagnostics}}

{{original_payload_note}}

Output ONLY the corrected artifact in the same format (TreeIR JSON, or the
{"files": {...}} map) — no commentary.
```

- [ ] **Step 1: Write the failing S7 test** — scenario A (M3's acceptance shape): one tree artifact `status:'fail'` with `W_ATTR_UNKNOWN` failures; scripted repair fixture returns a corrected tree; scripted `wp_validate` passes it → status `repaired`, file overwritten, exactly ONE `repair` ledger entry. Scenario B: repair output fails the gate again → status `dead`, baseline substituted from the section's pattern, `ctx.state.dead` entry carries the verbatim diagnostics, and NO second repair call exists in the ledger. Scenario C: a dead block (`arts.blocks['signup-banner'].status = 'fail'`, repair fixture missing → dead) makes the deferred signup tree re-gate; scripted re-validate fails → tree baseline-substituted too. Assert stage completes without throwing in all three.

- [ ] **Step 2: Run to FAIL, implement stage + template, run to PASS**

- [ ] **Step 3: Write `pipeline/tests/accept/m3.sh`** — live: boot Playground (as m2.sh), temp config with real provider for brief/tokens/tree + `"repair": {...real...}`, `prompts_dir` override pointing at `pipeline/fixtures/poisoned-prompts/` (copy of the real prompts with `tree.md` amended: "Every core/heading node MUST carry the attribute `glowIntensity: 11`" — guaranteed `W_ATTR_UNKNOWN`). Run `--until S7_repair`. Assert from `state.json` + `ledger.json` + `report.md`: (a) at least one tree gate failure occurred; (b) for each failed artifact exactly one `repair` entry exists in the ledger; (c) every artifact key in the ledger has a gate outcome in `state.json` (M3's "no call lacks a gate outcome"); (d) the run COMPLETED through S7 with any dead artifact's slot holding `gate.status === 'baseline'` and `report.md` listing it with verbatim diagnostics; (e) S section calls ≤ S + retries (count tree+repair ledger entries ≤ 2S); (f) concurrency observable: at least two `tree` ledger entries whose `[started_at, started_at+ms]` intervals overlap.

- [ ] **Step 4: Run m3.sh to green, record evidence + temptation-log entries in PROGRESS.pipeline.json, commit**

```bash
git add pipeline PROGRESS.pipeline.json
git commit -m "pipeline: S7 repair — one bounded repair per artifact, baselines for the dead; M3 accepted"
```

---

### Task 17: `prompts/block.md` + S5 stage + `blockGate`

**Files:**
- Create: `pipeline/prompts/block.md`
- Create: `pipeline/stages/s5-blocks.mjs`
- Modify: `pipeline/lib/gates.mjs` (add `blockGate`, `screenFileMap`)
- Test: `pipeline/tests/s5-blocks.test.mjs`

**Interfaces:**
- Consumes: `ctx.call` (`wp_block_scaffold`, `wp_block_build_test`), `ctx.llm`, `pLimit`, `ctx.state.brief.custom_blocks`.
- Produces:
  - `screenFileMap(value, {allowed}) -> issues[]` in gates.mjs: value must be `{files: {<name>: <string content>}}`, keys ⊆ allowed set, `render.php` present, no key containing `/` or `..` (files land only in the scaffold root).
  - `blockGate(result) -> {status, failures}` in gates.mjs: pass iff `data.built === true` AND no `data.failure` AND `zip_path` present AND `(data.smoke.front?.console_errors ?? []).length === 0` AND `data.smoke.front?.block_present !== false` AND `(data.style_warnings ?? []).length === 0` (spec: hex literals fail the artifact — every style_warning is a literal not spent through `var(--wp--preset--*)`). Failures carry `failure`, `style_warnings` and `front.console_errors` verbatim.
  - S5 stage, per custom block via limiter: (1) deterministic `wp_block_scaffold {slug, title, description, attributes, render_intent, interactivity, stylesheet, dir: join(runDir,'blocks'), force: true}` → scaffold dir + its file list; (2) read the scaffolded `render.php`, `block.json` (and `view.js`/`style.css` when shipped) as `scaffold_files`; (3) `generate({task_type:'block', label: `block/${slug}`, payload, validate: (v) => screenFileMap(v, {allowed})})` where allowed = `['render.php', 'view.js', 'style.css']` filtered by the declaration; (4) write the file map into the scaffold dir; (5) `wp_block_build_test {dir, sample_attributes}` (sample_attributes = each attribute's `default` or a type-appropriate sample: string → its name, number → 3, boolean → true, array → one sample item) → `blockGate`. Writes `runs/<ts>/blocks/<slug>.json` (`{dir, zip_path?, gate}`); `ctx.state.artifacts.blocks[slug] = {status, failures, dir, zip_path}`. Gate failures recorded, never retried here (S7 owns repairs). Note wp_block_build_test failure arrives as a SUCCESS envelope (`built:false`) — `blockGate` handles it; a thrown `build_failed` envelope (`!ok`) is also a gate failure, not a crash.

**Prompt template** `pipeline/prompts/block.md`:

```markdown
---
task_type: block
required: [block, gap_argument, scaffold_files, render_intent, token_slugs]
---
You are implementing ONE WordPress dynamic block inside an already-generated
scaffold. The factory gate (build + Playground smoke + front smoke) decides if
it ships; you will not get a conversation.

<verbatim excerpt: wp-blocks SKILL.md R7 rung 3 — the factory discipline:
scaffold, implement render.php against the render_intent, the gate is not skippable>
<verbatim excerpt: R11 — block-owned stylesheets spend token custom properties
var(--wp--preset--*) EXCLUSIVELY; a literal hex or px that exists as a token is
a defect the build test names>
<verbatim excerpt: canon-factory interactivity_policy — view-script is vanilla JS
progressive enhancement; no framework on the front end, ever>

The block, as the brief declared it: {{block}}
Why this block exists (the gap argument): {{gap_argument}}
render.php must realize: {{render_intent}}
Token slugs you may spend (as var(--wp--preset--color--<slug>) etc.): {{token_slugs}}

The scaffold as generated (block.json is FINAL — do not output it; escape every
attribute you print; use get_block_wrapper_attributes()):
{{scaffold_files}}

Output ONLY JSON: {"files": {"render.php": "<?php ...", "view.js": "...", "style.css": "..."}}
— include view.js/style.css only if the scaffold declared them.
```

- [ ] **Step 1: Write the failing test** — `screenFileMap` cases (missing render.php; illegal key `../evil.php`; non-string content). `blockGate` cases: clean pass; `built:false` + `failure` → fail; clean build but `style_warnings: [{line:3, literal:'#c8102e', ...}]` → fail carrying the warning; front `console_errors: ['x']` → fail. S5 run: ctx with fake fixture `block.block-signup-banner.json` returning a files map, scripted scaffold (returns dir + files) and build test (clean pass with zip) → `ctx.state.artifacts.blocks['signup-banner'].status === 'pass'`, files written into the scaffold dir, `runs/.../blocks/signup-banner.json` has `zip_path`.

- [ ] **Step 2: Run to FAIL, implement, run to PASS, wire the block branch of S7's `repairOnce` (write repaired file map → re-run `wp_block_build_test` → `blockGate`), extend the S7 test with a block-repair scenario, commit**

```bash
git add pipeline/lib/gates.mjs pipeline/prompts/block.md pipeline/stages/s5-blocks.mjs pipeline/stages/s7-repair.mjs pipeline/tests
git commit -m "pipeline: S5 blocks — scaffold-first factory lane, style literals fail the artifact"
```

---

### Task 18: `prompts/schema.md` + S6 stage + `schemaGate` + M4 acceptance

**Files:**
- Create: `pipeline/prompts/schema.md`
- Create: `pipeline/stages/s6-schema-packages.mjs`
- Modify: `pipeline/lib/gates.mjs` (add `schemaGate`)
- Create: `pipeline/tests/accept/m4.sh`
- Test: `pipeline/tests/s6-schema.test.mjs`

**Interfaces:**
- Consumes: `ctx.call` (`wp_schema_scaffold`, `wp_schema_build_test`), `ctx.llm`, `ctx.state.brief.schema_packages`.
- Produces:
  - `schemaGate(callResult) -> {status, failures}`: wp_schema_build_test THROWS on gate failure, so the envelope path (`!ok`) IS the failure lane — failures carry `data.message`, `data.hint` and any `data.smoke`/`data.build_log`; the success path requires `data.built === true && data.smoke.uninstall_clean === true && zip_path`.
  - S6 stage, per package via limiter: (1) `wp_schema_scaffold {slug, intent, post_types (mapped from the brief: meta entries become `{key, type, schema}` shapes the tool expects — mirror the input schema read at implementation time), routes, bindings, force: true}`; (2) **if `data.warnings.length > 0` → throw `PipelineError('preflight_failed', <the warnings verbatim>)` — the URL map is wrong BEFORE any LLM call is spent (spec + M4 acceptance)**; (3) read the scaffold's route/handler files as `scaffold_files`; (4) `generate({task_type:'schema', label: `schema/${slug}`, validate: screenFileMap with allowed = the scaffold's OWN writable file list (the files wp_schema_scaffold returned, minus `{slug}.php`'s registration block? — no: allowed = exactly the files the scaffold returned; the template instructs which to modify)})`; (5) write files; (6) `wp_schema_build_test {dir}` → `schemaGate`. Records `ctx.state.artifacts.packages[slug]`, writes `runs/<ts>/packages/<slug>.json`.

**Prompt template** `pipeline/prompts/schema.md`:

```markdown
---
task_type: schema
required: [package, lifecycle_argument, scaffold_files, route_probe_note]
---
You are implementing the route handlers of ONE schema package inside an
already-generated scaffold. The gate (policy scan + throwaway-WordPress boot +
route probes + uninstall check) decides if it ships.

<verbatim excerpt: wp-schema SKILL.md S3 — everything REST-visible>
<verbatim excerpt: S6 — anonymous writes: nonce + honeypot + server-side
validation + moderated statuses; never comments, options or transients>
<verbatim excerpt: S7 — owned code with an uninstall story>

The package, as the brief declared it: {{package}}
Why this data has a lifecycle: {{lifecycle_argument}}

The scaffold as generated (registration in {slug}.php is FINAL — implement the
route handlers against the embedded intent; core APIs only, no $wpdb):
{{scaffold_files}}

{{route_probe_note}}

Output ONLY JSON: {"files": {"<filename>": "<?php ..."}} — files you change, only.
```

`route_probe_note` (from the session log, a real gate-shape): "The gate probes public-nonce routes with ONLY `{_wpnonce, hp_website: '', title: 'Smoke sample'}` — a handler requiring more params must treat an absent param as a 200 ping, not a 400."

- [ ] **Step 1: Write the failing test** — `schemaGate`: envelope failure (`{ok:false, data:{code:'smoke_failed', message, smoke}}`) → fail with smoke attached; success shape → pass. S6 run: scripted scaffold with `warnings: []` + fake fixture `schema.schema-newsletter.json` + scripted build test pass → `packages.newsletter.status === 'pass'`. Preflight test: scaffold returns `warnings: ['public type claims /news which page 12 serves']` → stage throws `preflight_failed` AND the ledger contains ZERO `schema` task entries (the M4 no-LLM-spend clause).

- [ ] **Step 2: Run to FAIL, implement (verify the exact `wp_schema_scaffold` meta/routes input fields against `schemaScaffold.ts` while writing the brief→tool mapping), run to PASS, wire the package branch of S7's `repairOnce`, commit**

- [ ] **Step 3: Write `pipeline/tests/accept/m4.sh`** — live, fake-free factories: boot Playground; temp config with real providers; prompt crafted to force exactly one custom block and one schema package ("...a signup banner section that pulses its call-to-action and stores newsletter subscribers with a public subscribe endpoint..."); run `--until S7_repair`. Assert: `state.json` has `artifacts.blocks.<slug>.status ∈ {pass, repaired}` with a zip, in ledger exactly 1 `block` call (+ ≤1 repair); `artifacts.packages.<slug>` green with `uninstall_clean` evidence in `runs/.../packages/<slug>.json`; scaffold URL-map preflight tested by a second tiny run with a brief fixture whose package deliberately collides (route the brief task to `fake` with a colliding fixture, real everything else) asserting zero `schema` ledger entries.

- [ ] **Step 4: Run m4.sh green, update PROGRESS, commit**

```bash
git add pipeline PROGRESS.pipeline.json
git commit -m "pipeline: S6 schema packages — URL-map preflight before any call; M4 accepted"
```

---

### Task 19: S8 publish (`stages/s8-publish.mjs` + `lib/rest.mjs`)

Deterministic: sequential installs (the epoch discipline — installs are the only serialization point), final-epoch assembly, compile, publish, nav/footer/front-page, image pass.

**Files:**
- Create: `pipeline/lib/rest.mjs`
- Create: `pipeline/stages/s8-publish.mjs`
- Test: `pipeline/tests/s8-publish.test.mjs`

**Interfaces:**
- Consumes: `ctx.call` (`wp_schema_install`, `wp_block_install`, `wp_validate`, `wp_compile`, `wp_images_generate`, `wp_images_apply`, `wp_placeholder`), `lib/rest.mjs`, artifacts from S4–S7, `ctx.state.brief`, `ctx.budget` (I image spends).
- Produces: published pages (`ctx.state.published = {pages: [{slug, id, link}], nav_id, front_page_id}`), `runs/<ts>/pages/<slug>.html` (compiled markup evidence), final `ctx.state.fingerprint`, images generated+applied. Zero text-LLM calls; exactly `found` image spends metered as task_type `image`.

**`lib/rest.mjs`** — the same core-REST lane the tools already use, as a thin authed fetch helper. Read `tools/lib/rest-client.mjs` first; if its export shape fits (`request(cfg, method, path, body)`-style), import it from there instead of writing new code — tools/ is an allowed import per the spec's environment. Otherwise implement:

```js
export function createRest({ url, user, app_password }) {
    const auth = `Basic ${Buffer.from(`${user}:${app_password}`).toString('base64')}`;
    return async function rest(method, path, body) {
        const res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
            method,
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        const clean = text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '');   // WP responses can carry raw control chars that break JSON.parse
        if (!res.ok) throw new PipelineError('companion_error', `${method} ${path} -> ${res.status}`, clean.slice(0, 300));
        return clean ? JSON.parse(clean) : null;
    };
}
```

Connection values come from `ctx.state.instance` (recorded by S2 from wp_connect) plus the app password re-read via `readProviderKeys`-style `.x-agent.json` read (the pipeline may hold it: the config chain is the user's own file; never log it — it is registered as a secret).

**Stage sequence** (each numbered move records evidence into `ctx.state.published` and throws structured on failure — no improvisation):

1. **Sequential installs** — for each surviving package: `wp_schema_install {zip_path}`; then each surviving block: `wp_block_install {zip_path}` — STRICTLY awaited one-by-one in brief order, never through the limiter; each returns the moved fingerprint; record each into `ctx.state.installs = [{kind, slug, fingerprint}]` (the ledger-order assertion of M5 reads this).
2. **Final epoch**: `ctx.state.fingerprint =` the LAST install's fingerprint (or the S3 fingerprint when B+P=0).
3. **Placeholders**: for each surviving section with `image_intent`: `wp_placeholder {color: <brief palette accent slug>}` → rewrite that tree's image node url/id (the node carries `metadata.imageIntent` already; set its url/id attributes from the placeholder response). This is deterministic plumbing of a mint the companion owns.
4. **Assemble + gate per page**: `tree = {version: 1, epoch: finalFingerprint, blocks: sections.flatMap(s => s.tree.blocks)}` in brief order (baselines included); `wp_validate` → `screenTreeDiagnostics` with `allowedUnknown = ∅` — every deferral must have resolved; any failure now is a run failure with diagnostics (never bypass). Then `wp_compile(tree)` → require `all_valid === true` and empty `registry_gaps ∩ tree names`; write markup evidence.
5. **Publish pages**: `rest('POST', '/wp/v2/pages', {title, slug, status: 'publish', template: 'page-no-title', content: markup})` (TT5 prints an extra h1 otherwise — session log). Existing page with the slug (resume) → update by id.
6. **Front page**: `rest('POST', '/wp/v2/settings', {show_on_front: 'page', page_on_front: <front page id>})`; delete Sample Page if present (`GET /wp/v2/pages?slug=sample-page` → `DELETE /wp/v2/pages/<id>?force=true`).
7. **Navigation**: build `{version:1, epoch, blocks: [{name:'core/navigation-link', attributes:{label, url:'/<page_slug>/', kind:'custom'}, innerBlocks:[]} ...]}` from `brief.navigation.items` — FLAT, no submenu nesting (E_NEST_PARENT lesson); wrap in a `core/navigation` root node, `wp_compile`, strip ONLY the first and last line of the markup (`markup.split('\n').slice(1, -1).join('\n')` — a regex also eats the `navigation-link` comment lines; session log), discover the nav post (`GET /wp/v2/navigation` → first id — auto-created on first front render, never hardcode), `POST /wp/v2/navigation/<id> {content: inner}`.
8. **Footer**: build a `core/group` tree from `brief.footer` (site-title paragraph + one `core/paragraph` of links from footer.items), `wp_compile`, `POST /wp/v2/template-parts/<theme>%2F%2Ffooter {content: markup}` with `<theme>` from the instance manifest/theme (the TT5 demo-links replacement lane).
9. **Images**: `wp_images_generate {post_id: front_page_id, style: brief.art_direction, out_dir: join(runDir,'images')}` — FIRST `dry_run: true` to learn `found`, then `ctx.budget.spend('image', <ref.path>)` once per found pair (I enforcement BEFORE the real call), then the real call; each generated image also gets a ledger entry (`task_type:'image'`, provider `gemini`, model from the tool result, `prompt_hash: sha256(intent)`, outcome from generated/failures). Then `wp_images_apply {post_id, manifest_path}` requiring `all_valid: true`. Repeat per published page that has intents (page ids from step 5). `found` may be < I (dead sections) — spend what is found, the report shows predicted vs actual.

- [ ] **Step 1: Write the failing test** — scripted ctx exercising: install order strictly sequential (scripted `call` log: schema before blocks, one at a time — assert no interleaving by checking the recorded call sequence); final fingerprint = last install's; assembled tree carries it (capture the `wp_validate`/`wp_compile` args); a leftover deferral (scripted validate returns E_UNKNOWN_BLOCK now) → run failure with diagnostics; nav markup wrapper stripped by line-slice (feed a 4-line compiled nav, assert inner 2 lines posted); image budgeting: dry_run found=2 → exactly 2 image spends then the real call; a scripted `wp_images_apply` with `all_valid:false` → structured failure. Use an injected `rest` (pass it via ctx for tests: `ctx.rest ?? createRest(...)` — mirror the `ctx.call` seam).
- [ ] **Step 2: Run to FAIL, implement, run to PASS, commit**

```bash
git add pipeline/lib/rest.mjs pipeline/stages/s8-publish.mjs pipeline/tests/s8-publish.test.mjs
git commit -m "pipeline: S8 publish — sequential installs, final-epoch compile, core-REST lane"
```

---

### Task 20: S9 verify (`stages/s9-verify.mjs`) + full report + M5 acceptance

**Files:**
- Create: `pipeline/stages/s9-verify.mjs`
- Modify: `pipeline/lib/report.mjs` (complete it)
- Create: `pipeline/tests/accept/m5.sh`
- Test: `pipeline/tests/s9-verify.test.mjs`

**Interfaces:**
- Consumes: `ctx.call` (`wp_verify`, `wp_screenshot`), `ctx.state.published`, `ctx.state.budget`, `ctx.ledger`, `ctx.state.artifacts`, `ctx.state.dead`.
- Produces: `runs/<ts>/verify.json`, `runs/<ts>/screenshot.png`, the COMPLETE `runs/<ts>/report.md`. Exactly ONE `wp_screenshot` call in the whole run (grep the ledger? screenshots aren't LLM calls — assert from `ctx.state`: the stage records `screenshot_taken` and refuses a second).

Stage: `wp_verify {url: <front page link>, wait: 'domcontentloaded', nav_timeout_ms: 120000}` → mechanical checks: `pass !== false`; `a11y_outline` has EXACTLY one `h1` and no heading-level jumps (h2 may follow h1; a h4 directly under h1 is a failure); every `images[]` entry `loaded: true` with natural size > 0. Then ONE `wp_screenshot {url, out_path: join(runDir,'screenshot.png'), wait: 'domcontentloaded'}`. Failures are run failures with the verify payload as diagnostics.

`report.mjs` final form — sections: `# x-pipeline run report`; `## Outcome` (completed stages / failure); `## Budget — predicted vs spent` (table: task_type × predicted/actual from `state.budget` + ledger, plus per-provider totals with token usage sums); `## Artifacts` (every tree/block/package: key, gate status pass|repaired|baseline|dead, attempts); `## Dead artifacts` (each with its verbatim diagnostics block — the spec's requirement); `## Ledger` (the sorted table). Budget prediction per task_type: brief 1, tokens 1, tree S, block B, schema P, image I, repair 0 (predicted zero; actuals show what fired).

- [ ] **Step 1: Write the failing test** — scripted verify result (one h1, images loaded) → passes, writes verify.json, exactly one screenshot call even if `run` were invoked twice (second refuses); outline with two h1s → structured failure naming the outline; an unloaded image → failure. Report test: feed a state+ledger with one dead artifact → report.md contains its diagnostics verbatim and a predicted-vs-actual table where predicted == actual for the clean-run fixture.
- [ ] **Step 2: Run to FAIL, implement, run to PASS**
- [ ] **Step 3: Write `pipeline/tests/accept/m5.sh`** — live full run: boot Playground, real config, the M4-style prompt, NO `--until` (all nine stages). Assert: exit 0; `report.md` exists; installs sequential in `state.json.installs` and final tree epoch == last install fingerprint; `verify.json` one h1, all images loaded; exactly one `screenshot.png`; `report.md` predicted == actual for a clean run (retry/repair rows 0 or the run reran).
- [ ] **Step 4: Run m5.sh green, update PROGRESS, commit**

```bash
git add pipeline PROGRESS.pipeline.json
git commit -m "pipeline: S9 verify + report — one screenshot, predicted vs actual; M5 accepted"
```

---

### Task 21: M6 — end-to-end determinism, provider swap, the full-scope run

**Files:**
- Create: `pipeline/tests/accept/m6-determinism.sh`
- Create: `pipeline/tests/accept/m6-swap.sh`
- Create: `pipeline/fixtures/fake/` full fixture set for the M1 brief (captured, not hand-written — see below)
- Modify: `PROGRESS.pipeline.json` (final milestone evidence + temptation log)

**Fixture authoring rule** (mirrors the repo's captured-goldens doctrine): run the pipeline once against a live Playground with real providers and `X_PIPELINE_CAPTURE=1` — a ~10-line hook in `llm.mjs` that, when the env var is set, writes every successful `{text, usage}` into `pipeline/fixtures/fake/<task_type>.<label>.json`. Commit the captured set. Hand-authored fixture artifacts are forbidden except the two M1/M3 poison cases.

- [ ] **Step 1: Add the capture hook to `lib/llm.mjs`** (env-gated, no behavior change otherwise) with a unit test (env set → fixture file written beside a temp fixtures dir via `X_PIPELINE_CAPTURE_DIR`).
- [ ] **Step 2: `m6-determinism.sh`** — boot ONE Playground; run the pipeline TWICE with an all-fake config over the committed fixtures (same instance: identical token writes and same-version installs keep the fingerprint stable — session-log lesson); then compare: `diff <(normalize runs/A) <(normalize runs/B)` where normalize strips `started_at`/`ms` from ledgers and compares `brief.json`, `tokens.json`, `trees/`, `blocks/*.json`, `packages/*.json`, `ledger.json` (normalized) byte-for-byte. Both runs must exit 0; artifacts byte-identical; ledgers identical timestamps-excepted.
- [ ] **Step 3: `m6-swap.sh`** — copy the live config, flip ONLY `tasks.tree.provider` (+model) between two configured real providers (skip with a loud message when fewer than two keys exist in `.x-agent.json`); `git diff --exit-code pipeline/stages pipeline/lib pipeline/providers` before/after proves NOTHING in code changed; run `--until S4_sections` twice (once per config) and assert the `tree` ledger entries carry the two different provider ids.
- [ ] **Step 4: The Moulin-Rouge-class run** — one prompt of full scope (the cabaret landing: sails, marquee, stats, newsletter capture — the canonical rebuild recipe from the session log), real providers, zero human input, one run: `node pipeline/run.mjs "<prompt>" --config pipeline.config.json`. Acceptance: published verified site, empty dead-artifact list in report.md, predicted == actual budget. Keep the run dir as evidence; screenshot into PROGRESS evidence.
- [ ] **Step 5: Deliverable purity** — after acceptance: stop the Playground OR (on a kept instance) confirm no pipeline-owned state beyond the site itself; `runs/` stays local (gitignored).
- [ ] **Step 6: Final PROGRESS.pipeline.json update (all milestones, decisions, temptation log), final commit**

```bash
git add pipeline PROGRESS.pipeline.json
git commit -m "pipeline: M6 — byte-identical fake runs, provider swap by config, full-scope live run"
```

---

## Self-Review (run after writing, before executing)

1. **Spec coverage** — every spec clause maps to a task: file_layout → Tasks 1–21 (run.mjs T11, stages T12–T20, providers T7/T8, prompts T12/14/15/16/17/18, budget T4, brief schema T3, runs/ T11); stages S1–S9 → T12,13,14,15,17,18,16,19,20; llm_contract → T7/T8/T9; call_budget → T4 (+T9 consult-before, +T19 image spends); determinism (ledger/resume/claim) → T4/T11/T21; milestones M1–M6 → T11/T14/T16/T18/T20/T21; progress_protocol → T1 + every milestone task; operating rules → Global Constraints + gates in T15/17/18; non_goals respected (no agentic fallback — S7 baselines; no companion changes — pipeline reads .x-agent.json itself T5; no LLM markup — localTreeCheck T15 rejects innerHTML; single prompt per task_type — T6 one template file each; no hidden retries — T9 ledger per attempt; no instance state — T21 purity step).
2. **Known open verifications flagged for execution time** (each task names them inline): exact `ThemeTokenDiff.group` values (T14), `registry.js` export of `isUnimplemented` (T10), `tools/lib/rest-client.mjs` export shape (T19), `wp_schema_scaffold` meta field naming (T18), skill excerpt line offsets (T12/14/15/16/17/18).
3. **Type consistency** — `PipelineError(code, message, hint, extra)` used everywhere; `call() -> {ok, data}` consumed by all stages; `generate({task_type, label, payload, validate, maxAttempts}) -> {value, attempts}` consumed by S1/S3/S4/S5/S6/S7; `ctx.state.artifacts.{trees,blocks,packages}[key] = {status, failures, deferred?, dir?, zip_path?}` produced by S4/S5/S6, consumed by S7/S8/report; budget fixture arithmetic checked (7·2+2=16).

## Execution Handoff

Plan complete. Execution mode for this autonomous session: **inline execution via superpowers:executing-plans** — the milestones share heavy live-environment state (one Playground slot, one `.x-agent.json`, sequential epoch), which subagent-per-task isolation would fight. Work happens on branch `pipeline`; each task commits; each milestone updates PROGRESS.pipeline.json and runs its acceptance script before moving on.
