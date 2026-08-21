# `x-agent/tests/live/` — the tests that need a real WordPress

Everything in `x-agent/tests/*.test.ts` runs against the mock companion and needs
nothing. Everything in **this** directory drives a real WordPress with the
`x-companion` plugin mounted, because the things it proves cannot be faked:
`window.__compile` is a real Gutenberg `save()`, and the layout oracle measures
real computed CSS.

```bash
# 1. boot (or re-attach to) an instance
x-agent/tests/live/setup.sh

# 2. capture the fixtures from THAT instance
cd x-agent/mcp
npx tsx ../tests/capture-golden.ts

# 3. run the live suite
X_AGENT_LIVE=1 npx vitest run ../tests/live --no-file-parallelism

# 4. when you are done
x-agent/tests/live/setup.sh --stop
```

Two flags matter and both are deliberate:

- **`X_AGENT_LIVE=1`** — without it every live file `describe.skipIf`s itself, so a
  plain `npx vitest run` stays a hermetic unit suite that passes on a laptop with
  no WordPress and no browser.
- **`--no-file-parallelism`** — the live files share one instance and
  `compile.test.ts` deliberately moves its fingerprint. Run them in parallel and
  they will fight.

## `setup.sh`

Boots via `tools/playground/boot.mjs` with `--plugin ./x-companion` (a live
filesystem mount — edit PHP and the next request sees it), waits for REST, and
prints the runtime descriptor path. It is idempotent: a second run re-attaches.

- **Ports 9430-9439 only.** Other suites own 9410-9419 and 9440-9449, which is
  also why this script never runs `stop.mjs --all`.
- `boot.mjs` keys one instance per `(profile, posture)` and refuses to trample a
  running one. So `setup.sh` prefers `core-only/toolchain` and falls back to
  `core-plus-suite/toolchain` when another agent holds the first. Both are
  toolchain instances with every core block; the second additionally has Kadence
  Blocks, which is useful — it makes `registry_gaps` and the class -> block-name
  map face a non-`core/` namespace.
- `--stop` stops only what this script started; `--print` echoes the runtime path;
  `eval "$(./setup.sh --export)"` sets `X_AGENT_LIVE_RUNTIME` and `X_WP_*`.

## Fixtures are captured, never written

`specs/agent-plugin.spec.json` → `fixtures.authoring_rule`: *"Hand-authored
expected markup is the original sin of this domain and is forbidden even in
tests."* So:

| fixture | authored | captured |
|---|---|---|
| `fixtures/trees/*.json` | **yes** — a human writes the tree | — |
| `fixtures/golden/*.html` | never | `wp_compile` → the instance's own harness |
| `fixtures/specs/golden-landing.json` | never | measured off the golden render at 1440px |
| `fixtures/images/*.png` | never | `wp_screenshot` / a measured region clip |

`npx tsx ../tests/capture-golden.ts --check` re-compiles and diffs without
writing — run it in CI to catch a WordPress upgrade changing a `save()`.

**Markup goldens are instance-independent** (same WP version → same `save()`), so
`compile.test.ts` asserts byte-equality and means it. **The spec fixture is
not**: a different theme or plugin set renders different numbers. If
`verify.test.ts` fails on geometry, re-run the capture before you debug the
oracle — that is what the failure message tells you to do.

## The warm session

One chromium per MCP server process, one harness page, reused. Measured on this
machine against a Playground instance:

| | in-browser | wall clock (incl. the `GET /fingerprint` epoch probe) |
|---|---|---|
| first compile (launch + `GET /harness` + `__ready`) | 1.1-2.6 s | ~1.5-3.3 s |
| every compile after | **5-7 ms** | ~0.6-0.7 s |

The page load is 98-99% of a cold compile (measured: 1147 ms total, 1129 ms of it
the page; the next compile is 5 ms — 229x), which is exactly why the page is kept.
`wp_compile` output carries `timing: {total_ms, page_ms, compile_ms, cold}` so
this is observable in production, not just in tests.

The session auto-reloads when the epoch moves: `wp_compile` probes
`GET /fingerprint` on every call (it is the cheap route, and a compile is a
batch), and a changed fingerprint fires `onEpochChange` → `session.reload()`
*before* the tree is compiled. `harness.reloaded` in the output counts them.

## Registry gaps and the editor-injection fallback

`CONTRACT.md` §6: the agent diffs `window.__registry()` against `manifest.blocks`.
A block the server advertises but that never registered client-side has no
usable `save()`, so `wp_compile` returns

```json
{ "code": "harness_gap", "blocks": ["core/separator"], "registry_gaps": [...], "message": "...", "hint": "..." }
```

rather than serializing something no editor will accept. On a live WP 7.1 the real gap list is three server-only widget shims —
`core/legacy-widget`, `core/post-comments`, `core/widget-group` — and that is
true on `core-only` and on `core-plus-suite` alike: the harness registers
everything else client-side, third-party suites included.

The contract names one documented escape hatch: load `wp-admin/post-new.php` and
inject `harness.js` into the editor iframe, since the real editor loads every
block's editor script by construction. **It is implemented and it is OFF by
default** (`HarnessSession.loadEditorFallback()`, gated on
`X_AGENT_HARNESS_FALLBACK=1`).

It is off because it cannot work on Application Password credentials alone, and
that is WordPress core, not a bug here. `wp_validate_application_password()`
bails unless the `application_password_is_api_request` filter says the request is
an API request, so wp-admin ignores a perfectly correct Basic header. Measured
against the live instance with the flag on:

```
status 200, landed on http://127.0.0.1:9430/wp-login.php?redirect_to=…%2Fwp-admin%2Fpost-new.php&reauth=1
```

So the fallback additionally needs a real cookie session. This package will only
ever accept that as a **pre-recorded Playwright storage state** —
`X_AGENT_STORAGE_STATE=/path/to/storage-state.json`, produced by you, once:

```js
// node, with playwright, ONCE, on a machine you trust
const ctx = await (await chromium.launch({headless:false})).newContext();
await (await ctx.newPage()).goto('https://example.com/wp-login.php'); // log in by hand
await ctx.storageState({ path: 'storage-state.json' });
```

It will never ask for, store, or transmit an account password. If you do not want
to do that, the better fix is on the instance: give the block correct
`editor_script_handles` so `GET /harness` registers it.

## What the oracle actually measures — and one honest limitation

`wp_verify` with `markup` does **not** create a draft (there are no author routes
in v1). It `POST /render`s the markup, then serves a local shell from 127.0.0.1
that loads:

- the block stylesheets from `/render.enqueued_styles`, and
- the site homepage's `<link>` stylesheets **and its inline `<style>` blocks**,
  harvested once per fingerprint.

The inline half is not optional on a block theme: `wp_enqueue_global_styles`
emits every `--wp--preset--*` custom property inline, and `/render` cannot report
it as a URL. Without it, every colour, font size and spacing token measures as an
unstyled default. Measured on the golden landing against a core-only instance: 7 stylesheets and
21 inline style blocks (23 with Kadence Blocks active).

**The limitation:** the shell reproduces the site's *styles*, not the active
*template's wrapper chain*. Content sits directly inside `<div class="wp-site-blocks">`,
so `alignwide` has no constrained-layout ancestor to resolve against and measures
full-bleed rather than `wideSize`. For template-accurate numbers, measure a real
page with `wp_verify({url})`. `markup` mode answers "is this composition right in
this site's design system", which is the question the build loop actually asks.

A second thing worth knowing: a freshly booted instance is **not** style-stable
for the first couple of page loads. Kadence Blocks generates and caches its
dynamic CSS on first front-end render, which moved the measured body font size from 22px to 24px, and the `xx-large` preset
from 48px to 60px, between two capture runs minutes apart. Capture fixtures *after* the instance has
served a page, which is what `setup.sh` + `capture-golden.ts` in that order does.

## Tolerances

Spec-pinned, all overridable per call via `tolerances`:

| kind | default |
|---|---|
| position | 4 px **or** 2% of the viewport dimension, whichever is larger |
| size | 4 px **or** 2% of the expected dimension, whichever is larger |
| gap | 1 spacing step — the distance from the expected value's nearest token step to *its* nearest neighbour on the same scale |
| font size | 1 px |
| colour | 8/255 per channel (not spec-pinned; chosen so sub-pixel rendering and 8-bit rounding do not register as a design decision) |

`gap` is measured from the computed `row-gap` when there is one, and otherwise
from the median spacing between element children — because WordPress implements
`blockGap` as a margin on children for flow and constrained layouts, where the
computed `gap` is `normal` and would lie.

`font_size` for a region is the **largest** computed font size in its subtree,
i.e. the size a designer names when they name a region's type scale.
