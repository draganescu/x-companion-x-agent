---
name: wp-blocks
description: >-
  Build, edit and verify WordPress block layouts against a live WordPress instance running the
  X Companion plugin. Use whenever the user wants to make, build or set up a WordPress site,
  or to edit, change, update or redesign their WordPress site — in any wording — and whenever
  the task involves WordPress blocks or Gutenberg, block themes,
  building or changing a page, pattern, template, hero, section or landing page on a WordPress
  site, turning a design — Figma file, screenshot, mockup or HTML comp — into WordPress,
  editing theme.json or design tokens/presets, block patterns and block styles, adding a
  testimonial/pricing/feature/CTA section, fixing block validation errors, or any mention of
  X Companion, x-agent, TreeIR, a block manifest/fingerprint, or the wp_* MCP tools
  (wp_connect, wp_manifest, wp_validate, wp_compile, wp_verify). The agent generates validated
  JSON block trees that a real browser compiles into canonical markup; it never hand-writes
  "<!-- wp:" markup.
---

# WordPress blocks

You are connected to **one specific WordPress instance**. That instance — not your general
knowledge of WordPress — defines every block, attribute, pattern and design token you may use.

How the pieces fit: the instance runs the **X Companion plugin**, which exposes REST routes for
reading the block registry, validating trees, compiling markup and installing packages. The
**x-agent MCP server** is the client for those routes; its `wp_*` tools are the only way you
touch the instance. Compilation happens on the companion's `/harness` page — a page that loads
the block editor's JavaScript so trees are serialized by each block's real `save()` function,
driven by a headless browser on the agent side.

The one hard rule: **you never write serialized block markup.** You write JSON (*TreeIR*); the
instance's own `save()` functions turn it into markup. Everything else in this file exists to
make that loop fast and checkable.

---

## 1. The loop

Run this loop; do not substitute a different one.

| # | Step | Tool | Gate before moving on |
|---|---|---|---|
| 0 | Connect | `wp_connect` | You have `posture` and `fingerprint`. |
| 1 | Learn what exists | `wp_manifest` (`summary:true`, then `filter`) | You know the blocks, tokens and counts that actually exist here. |
| 2 | **Retrieve before inventing** | `wp_patterns` | You looked. Adapting a registered pattern beats a novel composition. |
| 3 | Generate the tree | — (you write JSON) | Every node's name and attributes came from step 1. |
| 4 | Validate | `wp_validate` | `valid: true`. Every warning has been read and either fixed or justified. |
| 5 | Compile | `wp_compile` | `all_valid: true`, `invalid: []`. This is the only source of markup. |
| 6 | Verify numerically | `wp_verify` | `pass: true`, or every remaining diff is a logged, itemized decision. |
| 7 | Accept | `wp_screenshot` | **Exactly once**, at the very end. |

Steps 3→6 iterate. Steps 0–2 repeat only when the fingerprint changes.

Three things that are deliberately *not* in the loop:

- **No screenshot-diffing.** `wp_verify` returns numbers — boxes, gaps, font sizes, colors,
  an accessibility outline. Iterate on those numbers. A screenshot is final evidence for a
  human, not an input to your next edit.
- **No hand-written markup, ever.** Not even for a quick test. See R1.
- **No raw CSS.** Styling goes through the instance's tokens and supported mechanisms, not
  through stylesheets you write ad hoc. See R4.

---

## 2. Design quality

Correctness is the loop's job; design quality is yours, and it is expected even when the user
gives no design direction. A prompt without design direction means you supply one — it does not
mean the output may be plain.

**Before the tokens, write the art direction.** Two or three sentences, stated explicitly: a
mood or reference style, a color story, a typographic attitude, the one image the site should
leave in someone's mind. Commit to a NAMED tone from a real vocabulary — editorial/magazine,
brutalist/raw, luxury/refined, organic/natural, retro-futuristic, playful/toy-like,
soft/pastel, industrial/utilitarian, art deco/geometric, or another that fits the brief
better — and answer the differentiation question: what should make this site memorable. Every
token and section decision is then made against that brief. If you cannot say what the site
should feel like, you are not ready to write `DesignTokens`.

**What separates a designed page from a default one.** Default output has a recognizable
shape: every section a centered stack on a flat band, one heading size doing all the work,
tokens copied from the theme it replaced. Break that deliberately:

- **Display-scale type.** Give the type scale a real top end — a `display` step (fluid,
  3rem → 6rem+) for hero statements and large numerals, not just a slightly bigger `xx-large`.
- **Asymmetry.** Uneven column splits (58/42, 45/55), left-aligned heroes, staggered card grids
  (an inner group with a `padding-top` preset drops one column), media-text rows that alternate
  sides.
- **Band rhythm with one bright moment.** Sections alternate ground tones; exactly one band
  gets the loud color. Two loud bands cancel each other out.
- **Editorial details.** Uppercase letterspaced kickers, a marquee strip, a large pullquote on
  the page's one accent band, figure captions with real content — cheap in tokens, and they
  give the page character.
- **One accent color.** A single accent handles every CTA and highlight; name the palette slugs
  after what they are for, rather than shipping five interchangeable grays.
- **Use whitespace deliberately.** `spacing|70` and `|80` between bands; choose content widths
  on purpose (a 640px column reads differently from a 720px one).

**Core blocks are the floor; custom blocks plus tokens are the ceiling.** `theme.json` through
`wp_tokens_apply` and dynamic agent blocks through the R7 factory together cover a very wide
range of UI without giving up any of the checks. When the design calls for a component core
cannot express well — meters, tickers, timelines, ratings, schedules, diagrams, anything
data-shaped — a custom dynamic block is not a failure of composition; it is often the strongest
element on the page. The R7 process still applies (try recomposition and styles first, always
run `wp_block_build_test`, the block is owned code); R7 governs *how* you build one, not
whether you may.

**Generic is a defect, not a baseline.** The overused AI aesthetic is recognizable: purple
gradients on white, the predictable hero/card/feature-grid page with no concept behind it, the
same visual formula reused across unrelated sites. Interpret each brief specifically — the art
direction names what makes THIS site memorable — and vary grounds (light vs dark), type
systems, and layout structures across builds.

**Match complexity to the vision.** Maximalism needs enough layered detail, motion, and visual
system to feel intentional; minimalism needs restraint, exact spacing, strong typography, and
careful hierarchy. Do not confuse minimal with unfinished.

**Self-check before you compile:** if every section is a centered stack on a flat band, the
design is not done — go back to the art direction.

## 3. The thirteen rules

These rules are numbered so you can cite them: "R7 step 2" is a complete explanation of a
decision.

### R1 — NEVER hand-write serialized block markup (`'<!-- wp:'`). Generate TreeIR; markup exists only as `wp_compile` output.

Gutenberg's persisted content is HTML with JSON in comment delimiters, and its validity is
defined by each block's **JavaScript `save()`** function — attribute order, class names,
whitespace, wrapper elements, deprecations. No model reproduces that reliably. Markup written
by hand looks right and then fails validation in the editor later.

So: a tree is `{version: 1, epoch, blocks: [...]}`, and a `BlockNode` is
`{name, attributes?, innerBlocks?}` — nothing else. `innerHTML` in a tree is a hard schema error
(`E_TREE_SCHEMA`) precisely because it is compiler output appearing in an input.

This also means: **do not paste markup from memory, from a blog post, or from another site.**
If you need to start from existing markup, run it through `wp_parse` — that is what it is for.

### R2 — The available blocks and attributes are whatever `wp_manifest` returns at the current fingerprint. Never assume a block exists; never use attributes not in the manifest entry (`W_ATTR_UNKNOWN` warnings are review items, not noise).

The manifest is the registry, verbatim: every block's attribute schema with types, enums and
defaults; `supports`; `parent`/`ancestor` constraints; `is_dynamic`; and `agent_hints` when a
block author declared constraints the registry cannot express.

Two habits:

- Start with `wp_manifest({summary: true})` to see what exists, then
  `wp_manifest({filter: {name_prefix: "core/"}})` for the full attribute schemas of the family
  you actually need. The full blocks map is large — 116 blocks on a bare core install, 175 with
  one suite active.
- Treat `W_ATTR_UNKNOWN` as a real finding. It usually means you used an attribute that
  WordPress moved. Real example: `core/heading` no longer declares `textAlign`; text alignment
  now lives at `style.typography.textAlign`. When your memory and the manifest disagree, the
  manifest is correct.

`agent_hints.usage_notes` and `agent_hints.example_attributes` are reliable, instance-provided
answers when present. Read them.

### R3 — Every tree carries `epoch` = current fingerprint. On any `epoch_mismatch`, refresh the manifest, regenerate or re-validate, continue.

The fingerprint is a hash of the block registry, the theme and the active plugins. It changes
when a plugin is activated, a theme is switched, tokens are written, or a block is installed.
In a tree, the same value is carried in the `epoch` field: it records which state of the
instance the tree was generated against. A tree generated against a stale state may compile
into something quietly wrong, so the companion refuses it: `E_EPOCH_MISMATCH` at `/epoch`,
with `epoch_ok: false` — **and it still runs every other check**, so a stale round trip is
never wasted.

The client refreshes and retries **once**, automatically. If it still mismatches, you get
`{code: "epoch_mismatch"}`. Then: `wp_manifest({refresh: true})`, re-read anything you cached,
regenerate the tree with the new fingerprint. Never loop on it, and never invent a value — it
is an opaque string from `wp_connect`/`wp_manifest`, not something you compute.

Your own actions change the fingerprint. `wp_tokens_apply`, `wp_block_install` and
`wp_pattern_save` all return a **new** `fingerprint`; use it in the very next tree.

### R4 — Style through the instance's styling mechanisms, in order. State which level you landed on and why each lower level was not enough; landing on level 5 or 6 without that explanation is a defect.

The levels, each readable from the instance (interfaces v2). Tool messages and generated
comments call these "rungs" of the "expression ladder" — same numbering, same meaning:

| level | what | read from |
|---|---|---|
| 1 | **block supports** — preset attributes: `backgroundColor`, `fontSize`, spacing, `layout`, align, elements | `wp_manifest` blocks[].supports |
| 2 | **global styles / tokens** — DesignTokens → theme.json settings; per-block and per-element styles | `manifest.theme_tokens`, section `global_styles` |
| 3 | **registered block styles** — `className: "is-style-…"` from theme, plugins, or an installed package | blocks[].styles (`W_STYLE_UNKNOWN` flags an unregistered one) |
| 4 | **block variations** — named attribute/innerBlocks presets, server- and client-registered | blocks[].variations (harness capture supplies `source: "client"`) |
| 5 | **custom css in global styles** — `wp_tokens_apply`'s `css: {global?, blocks?}` section; WordPress's own escape hatch since 6.2, theme-update-safe, rejections itemized in `css_rejected` | section `global_styles.custom_css`, `features.per_block_css` |
| 6 | **a block-owned stylesheet** — `style.css` shipped by the factory, token custom properties only (R11) | the factory; last resort |

Raw inline CSS and hand-rolled class-plus-stylesheet styling are forbidden at every level.
The tables below cover levels 1–2 in detail, since that is where most decisions happen.

**Use the preset slugs the instance publishes** in `manifest.theme_tokens`:

| Want | Write | Never write |
|---|---|---|
| A color | `"backgroundColor": "accent-3"`, `"textColor": "base"` | `"style": {"color": {"background": "#503AA8"}}` |
| A font size | `"fontSize": "xx-large"` | `"style": {"typography": {"fontSize": "34px"}}` |
| Space around a section | `"style": {"spacing": {"padding": {"top": "var:preset|spacing|80"}}}` | `"...padding": {"top": "96px"}` |
| Space between children | `"style": {"spacing": {"blockGap": "var:preset|spacing|50"}}` | a `core/spacer` stack |
| Arrangement | `"layout": {"type": "constrained"}` / `{"type": "flex", "justifyContent": "center"}` | float/flex CSS in a `className` |
| Width | `"align": "wide"` / `"align": "full"` | `"style": {"dimensions": {...}}` with pixels |

The `var:preset|spacing|<slug>` form is the *attribute* spelling; the compiler turns it into
`var(--wp--preset--spacing--<slug>)` in the markup. Both spellings exist; use the attribute one.

**A concrete token set** (Twenty Twenty-Five, read from a live instance) so you can see the shape:
palette slugs `base contrast accent-1 … accent-6`; spacing slugs `20 30 40 50 60 70 80`
(`10px` → `clamp(70px, 10vw, 140px)`); font-size slugs `small medium large x-large xx-large`;
`layout.contentSize: 645px`, `layout.wideSize: 1340px`. Always read the real values —
those are one theme's.

`className` is allowed for **registered block styles** (`"is-style-outline"`) and for utility
classes the theme actually ships. It is not an opening for `class="my-custom-thing"` plus a
stylesheet — there is deliberately nowhere to put such a stylesheet.

When the tokens genuinely cannot express the design — a card with a specific overlap, a badge,
a ratings row — **stop styling and go to R7**. An inline style is a silent decision; a new
block is a reviewable one.

### R5 — Loop: retrieve (`wp_patterns` first — adapt existing patterns before inventing) → generate tree → `wp_validate` (fix all errors, review warnings) → `wp_compile` (must be `all_valid`) → `wp_verify` against spec/expectations (fix diffs outside tolerance) → repeat. `wp_screenshot` exactly once, at the end, as acceptance evidence.

The order matters:

1. **`wp_patterns` first.** The instance ships a set of layout patterns that are already
   correct for this theme — 109 of them on a stock Twenty Twenty-Five install. Search it
   (`wp_patterns({query: "hero"})`), read `parsed_tree`, and adapt. `parsed_tree` is already
   TreeIR-shaped: strip `innerHTML`/`innerContent`, keep `blockName`/`attrs`/`innerBlocks`.
   Inventing a composition the theme already ships tends to produce something subtly off.

   **A page is an assembly of sections, and most sections should begin as patterns** — copied
   into the page tree, restyled with your tokens, their content replaced. That is the default
   approach, not the exception. Two qualifications: patterns are a correctness baseline, not a
   limit on the design — deviate deliberately whenever the art direction (§2) needs a shape
   the pattern set does not have. And when you compose a section worth keeping, **save it
   back** with `wp_pattern_save` so the instance's pattern set grows: the next page can start
   from it, and future sessions inherit it.
2. **`wp_validate` before `wp_compile`.** Validation is cheap and specific; compiling is a
   browser round trip. A local TreeIR schema pre-check runs first and short-circuits without
   any network call, so malformed trees cost nothing. Fix every `severity: "error"`. Read every
   warning: fix `W_ATTR_UNKNOWN`, satisfy `W_HINT_ALLOWED_BLOCKS` and `W_HINT_TEMPLATE_LOCK`.
   Expect `W_STATIC_NEEDS_HARNESS` — one per distinct static block name — and let it stand: it
   is a reminder that this block's markup must come from the compiler.
3. **`wp_compile` must return `all_valid: true` and `invalid: []`.** Anything in `invalid[]`
   means a block round-tripped through `parse()` and came back invalid — you sent attributes
   its `save()` cannot express. Fix the tree; do not touch the markup.
4. **`wp_verify` is the check.** With a spec it returns `diffs[]` and `pass`. Without a spec it
   returns `box_tree` and `a11y_outline` — still useful: check the heading levels form a sane
   outline and the geometry matches what you set out to build. It also returns `images[]` —
   every `<img>` on the page with its rendered box, natural size and loaded state, including
   images nested inside composite blocks the box tree cannot see. Read it: `loaded: false`, or
   a 1×1 natural size under a large box (an unsized placeholder where the markup needed real
   dimensions), is a defect the output just reported.
5. **One screenshot.** At the end. `wp_screenshot` is for a human to review.

If you are calling `wp_screenshot` twice, you are iterating on pixels instead of on
`wp_verify` output. Stop and use the numbers.

**Images before assets exist — the placeholder default.** A layout should not wait for
photography, and an agent never hotlinks stock imagery it cannot license. When a design calls
for an image and no real asset exists yet:

1. `wp_placeholder({color: "accent-2"})` — one call per colour, idempotent. Pass a **palette
   slug** so the placeholder uses the design system's colors; it returns `{id, url}` for a
   1×1 GIF attachment.
2. Stretch the pixel with block attributes, never CSS: on `core/image`, `width: "100%"` +
   `aspectRatio` + `scale: "cover"`; on `core/media-text`, `imageFill: true`. The geometry is
   final from day one — swapping in the real photo later moves nothing.
3. **Record what the picture should be** on the same node, in
   `attributes.metadata.imageIntent` — a one-sentence brief for the image that belongs there
   (subject, mood, crop). `metadata` is a real block attribute: it validates, serializes into
   the block delimiter, and round-trips through `wp_compile`/`wp_parse`.

```jsonc
{ "name": "core/image",
  "attributes": {
    "url": "…/x-pixel-b05427.gif", "id": 8,
    "alt": "Interiorul berăriei — fotografie în curând",
    "width": "100%", "aspectRatio": "21/9", "scale": "cover",
    "metadata": { "imageIntent": "Wide interior shot of the bar at night: warm amber pendant light on a copper counter, patrons blurred in the background, moody chiaroscuro." } } }
```

**When the markup is not yours to stretch** — WooCommerce product images, avatars, any
third-party template that renders images at intrinsic size — a 1×1 stretched by attributes
does not apply: mint a real-sized placeholder instead with
`wp_placeholder({color, width: 900, height: 1200})` (a PNG; WordPress generates its
thumbnail sizes normally) and attach that.

The intent field is the hand-off to the **image-generation pass**, which is two tools:
`wp_images_generate` finds every placeholder+intent pair on a published post (with the
editor's own parser — `url` is a sourced attribute, invisible to PHP parsing), generates one
image per brief with a Gemini image model (`gemini_api_key` in `.x-agent.json`; pass `style`
for one shared look), and writes files plus a manifest locally; `wp_images_apply` uploads
them to the media library, swaps `url`/`id` on exactly those nodes, recompiles through the
harness and updates the post, keeping the intent as provenance. Layout and content ship now;
pixels arrive when they are ready — and land without moving a single box.

### R6 — from-design mode: lift binaries into DesignSpecIR per `references/design-spec.md` (measure, don't trace; quantize every observed value onto the token scale and log the delta; mark every synthesized responsive behavior). `wp_spec_validate` must pass before any tree is generated. `wp_verify` diffs are then attributable: token decision, mapping approximation, or a gap in the available blocks.

An image is not a layout. Read `references/design-spec.md` before you lift one — the whole
method is there. The short version:

- **Measure, don't trace.** Record boxes in source pixels, then decide what they mean.
- **Quantize everything onto the token scale**, and put every snap in `quantization_log` as
  `{observed, snapped_to, delta}`. A design where nothing was snapped is a design nobody
  reviewed.
- **Mark every responsive behavior you inferred** with `confidence: "synthesized"`. A single
  static image contains zero information about breakpoints. Those entries are the items a
  human gets to veto, and they can only veto what you flagged.
- **`wp_spec_validate` must pass before you generate a tree.** Its purpose is to catch a
  misreading of the image while it is still cheap to fix.

Then, when `wp_verify` reports a diff, you can say which of three things it is: a token
decision already in the log, an approximation in how a region mapped to blocks, or a genuine
gap in the available blocks. "It looks a bit off" is not one of the three.

### R7 — When the available blocks cannot express the design, work through these options in order: (1) a different composition of existing blocks; (2) a block style/pattern; (3) a new dynamic block via `wp_block_scaffold` → implement `render.php` → `wp_block_build_test` (must pass) → `wp_block_install` → use the new fingerprint. Static blocks are never created.

Work through the options **one at a time**, and state which one you are on and why the
previous one was not enough. Most "I need a custom block" cases are resolved by option 1.
(Tool descriptions call this sequence the "vocabulary-gap ladder" and the options "rungs" —
same numbering.)

**Option 1 — recompose.** Before anything else, ask whether existing blocks in a different
arrangement produce the design. A `core/group` with `layout.type: "flex"` and a `blockGap`
preset is a row. A `core/columns` with `verticalAlignment` is a two-up. `core/media-text` is
an image-beside-text section. Check `wp_patterns` again with different words. Option 1 costs
one tree regeneration and adds no new code.

**Option 2 — a registered block style or pattern.** If the *structure* is right and only the
*appearance* differs, look for a registered block style (`className: "is-style-…"`) — the
manifest's `supports` and the theme's registered styles tell you what exists. A pattern that
is 90% right and needs its content swapped is still option 2, not option 3.

**Option 3 — a new dynamic block.** Only when 1 and 2 are genuinely exhausted. Four calls, in
order, none skippable:

```
wp_block_scaffold  → a directory: block.json (agent/{slug}), render.php, edit.js, edit.asset.php
                     — vanilla no-build JS: no package.json, no src/, no npm, ever
  ↓  you implement render.php against the render_intent comment
     — escape every attribute, use get_block_wrapper_attributes(), no raw echo of input
wp_block_build_test → the safety check. Syntax-gate every shipped script, boot a local Playground, register the
                      block, assert it appears in /wp/v2/block-types, render sample attributes,
                      produce the install zip. Must return built:true, smoke.registered:true and
                      no smoke.php_error. Nothing reaches the instance without this.
wp_block_install    → POST the zip. Returns the NEW fingerprint.
  ↓
use the new fingerprint in every subsequent tree; the block is now available like any other
```

**The editor is part of the deliverable.** The scaffolded `edit.js` previews the block through
`ServerSideRender` — the canvas IS `render.php`, so the editor can never drift from the front
end. Every setting sits in the inspector; nothing invisible is ever printed on the canvas. All
inserter copy, labels and help text are written for the **site editor**, in plain language
about what the reader sees — never toolchain terms (no "agent", no "x-agent", no attribute
names): pass a real `description`, and per-attribute `label`/`help`, to `wp_block_scaffold`.
Two finishing obligations before `wp_block_install`:

1. If part of the render is hidden on the front by default (a closed modal, a success state),
   reveal it in `render.php` when `$is_editor_preview` is true so the canvas shows what is
   being edited.
2. A structured attribute (array/object) scaffolds with a raw-JSON fallback control. Replace it
   with a purpose-built control (one field per property, add/remove rows) before install —
   shipping raw JSON to a site editor is a defect, exactly as a hardcoded color is.

**Static blocks are never created.** A static block freezes its `save()` output into every
post that used it; change the block and that content is invalid forever. Dynamic blocks render
at request time, so iteration is free. The scaffold cannot produce a static block and the
companion rejects a package whose `block.json` has no `render` entry (422 `block_policy`).
There is no setting that turns this off.

**Option 3½ — hand off to wp-schema.** If the gap is *storage, backend behavior, or an admin
surface* — orders, bookings, submissions, inventory, anything with a lifecycle — **stop
here**. That is the **wp-schema** skill's territory: a schema package registers the post
types, meta, routes and bindings; the block you then build here is the *view* of that
package, never its database. A block whose `render.php` writes comments, options or
transients to simulate a data store violates this rule the same way hand-written markup
violates R1.

**Front-end interactivity has two modes — declare which one you take and why.**
`wp_block_scaffold` accepts `interactivity`:

- `"view-script"` (the default): a plain vanilla `view.js`, no build step, no framework —
  progressive enhancement only (submit-over-fetch, toggles, client-side state). Everything the
  block *does* must work without it.
- `"interactivity-api"`: an ES module store via `viewScriptModule`, resolved by WordPress's
  own import map — only when state must flow server→client (hydration via
  `wp_interactivity_state`, context shared across blocks), and only when
  `manifest.features.interactivity_api` says the instance has it (checked; refused otherwise).

React or any framework on the front end is not an option. The build test grows to match: a
block shipping front assets is smoke-tested in a real browser — `view.js` must execute,
`style.css` must enqueue, and any console error fails `wp_block_build_test`.

**Option 3 is a real cost.** A new block is code someone has to own. Say so when you take it.

### R8 — Posture awareness: extend-tier tools fail on `production` posture by design. For structural work on a production site: `wp_snapshot` → work in a sandbox instance → promote artifacts. Do not look for a way around this.

`wp_connect` tells you the posture. The split:

| posture | you may | you may not |
|---|---|---|
| `toolchain` | everything | — |
| `production` | `wp_manifest`, `wp_patterns`, `wp_validate`, `wp_parse`, `wp_render`, `wp_compile`, `wp_verify`, `wp_screenshot`, `wp_spec_validate`, `wp_tokens_apply({dry_run: true})` | `wp_tokens_apply`, `wp_block_install`, `wp_snapshot`, `wp_placeholder`, `wp_pattern_save` — 403 `posture_forbidden` |

The refusal happens in the permission callback, **before the request body is parsed**. It is
not a UI toggle and there is no header that changes it. When you hit it, follow the hint the
error already gives you: snapshot to a sandbox, do the structural work there, promote the
artifact. Proposing that the user edit `wp-config.php` on their production site to get past a
safety check is not a solution; it is the situation the check exists to prevent.

Note `wp_tokens_apply({dry_run: true})` works everywhere and returns the full theme.json
preview plus a diff against the instance's current tokens. Use it to *show* the change you
would make.

### R9 — Greenfield ordering: design tokens FIRST (as DesignTokens JSON, kept as source of truth), `wp_tokens_apply`, then layout. `theme.json` is a compile target, not the design system itself.

On a new build, resist starting with the hero. Decide the system first:

1. Write `DesignTokens` — `{palette, spacing, typography, layout}` — as JSON, and keep that
   file as the source of truth. It is what you will diff against later.
2. `wp_tokens_apply({dry_run: true})` to preview the compiled `theme.json` settings and the
   diff.
3. `wp_tokens_apply` for real (toolchain posture only). Use the returned fingerprint.
4. *Then* build layout, using only the slugs you just defined.

In the other order, every section picks its own near-miss values and the result is a "design
system" that is really a list of accidents. `theme.json` is downstream: it is what the tokens
compile into, and the companion writes it into user-origin global styles so it survives theme
updates.

### R10 — Credentials stay in local config; never echo the app password into conversation, files, or tool outputs.

The WordPress Application Password lives in exactly one of three places, resolved in this
order: tool arguments → `.x-agent.json` in the working directory → `X_WP_URL` / `X_WP_USER` /
`X_WP_APP_PASSWORD` in the environment. It never leaves the machine except as an
`Authorization: Basic` header to the site itself. There is no relay and no credential
custody — that is a deliberate architectural decision.

Concretely: do not print it, do not echo it back for confirmation, do not write it into a
script, a README, a commit, a test fixture or a log line. Do not read `.x-agent.json` "to
check the config" — call `wp_connect` and read `config_sources`, which reports *where* each
field came from (`arguments` | `file` | `env` | `missing`) and never what it is. The MCP
server redacts registered secrets, Basic headers and URL userinfo from every message it
emits; do not defeat that by quoting a value you obtained some other way.

If a credential is missing or wrong, say which field is missing and where it should go. That
is all the user needs.

### R11 — A block-owned stylesheet uses TOKENS, not literals. Build `style.css` exclusively on the instance's custom properties (`var(--wp--preset--color--…)`, `--wp--preset--spacing--…`, `--wp--preset--font-size--…`); a hardcoded color or size that a token can express is a defect `wp_block_build_test` already names in `style_warnings`.

Level 6 exists so a custom component can own layout mechanics core cannot express — grid
wiring, overlaps, transitions. It does not exist to create a second design system. Every
color is a palette token, every space a spacing token, every size a font-size token; what
remains in `style.css` is *structure*. The build test lints this (warnings, line-numbered) —
review every entry, and either use a token or state why the structure needs that literal (a
`1px` border, a `50%` transform — fine; a `#a45a2a` — never).

### R12 — ALWAYS fan independent tracks out to subagents. The epoch is the only serialization point; everything that does not move it runs concurrently.

A full build has four tracks: the **data model** (the wp-schema package), the **design
system** (tokens), the **vocabulary** (custom blocks), and the **content** (page trees).
Their authoring and gating are independent right up until bindings and installs tie them
together: a schema package's scaffold → implement → build test runs wholly in a throwaway
sandbox; so does each custom block's; tokens are a JSON document; and a tree references
block names and token slugs that are decided at design time, not at install time. Working
those in sequence wastes the wall clock — on a typical build two of the four phases overlap
completely. So: one subagent per track, and one per block when several blocks are being
built (each build test boots its own throwaway WordPress on a free port from a small range,
so a handful in parallel is fine).

**Subagents return artifacts, not effects**: a gated zip path, a tokens document, a draft
tree, a build-test report. Everything that touches the instance stays with the coordinating
agent, because the convergence points are hard:

1. **Installs move the fingerprint.** `wp_tokens_apply`, `wp_block_install` and
   `wp_schema_install` each return a NEW fingerprint — the coordinator runs them one after
   another (any order) and stamps every tree with the fingerprint of the **last** one. This
   is also what keeps R3 trivially true: only one agent ever needs to know the current
   epoch.
2. **Bindings and vocabulary wait for their installs.** A tree that binds a schema source
   validates only after `wp_schema_install` (`E_BINDING_UNKNOWN` before it); a tree using
   an agent block validates only after `wp_block_install`.
3. **Compile, verify and screenshot are coordinator work too** — they drive the one warm
   browser session; interleaving them from parallel agents interleaves that session.

The shape of a fast build, then: fan out (schema package ∥ tokens ∥ each block ∥ tree
drafts and copy) → converge on the coordinator (install everything, take the final
fingerprint) → validate → compile → verify → one screenshot.

### R13 — Never build tooling around the toolchain. No generators that write trees, no scripts that template JSON, no wrapper CLIs, no sed over markup. The tools are the interface and the model is the author.

The temptation looks like productivity: a Python script that stamps out TreeIR sections
from a data file, a shell pipeline that rewrites compiled markup, a helper that batches
REST calls around the companion. Every one of these moves authorship out of the loop the
toolchain exists to enforce — trees written per-node against the manifest, markup produced
only by the instance's own `save()`, mutations gated and epoch-stamped — and into ad-hoc
code nothing validates. A generator's output *looks* like a hundred decisions; it is one
decision photocopied, and the first attribute it gets slightly wrong is wrong a hundred
times behind `valid: true`-shaped confidence. String surgery on markup is worse: a pattern
that looks anchored eats sibling blocks (`navigation` vs `navigation-link` is one
character of prefix apart).

When work feels like it needs a crutch, it is telling you one of three things is missing:

1. **A pattern** — the same section shape over and over is `wp_pattern_save`, not a
   generator; the instance then owns the idiom and every future session inherits it.
2. **A capability** — data-shaped repetition wants a dynamic block or a schema package
   (R7 / wp-schema), built THROUGH the factory so it is gated, versioned and owned.
3. **A tool** — a genuine gap in the toolchain is toolchain work: a change to the MCP
   server on a branch with tests and a PR, never a sidecar script living in a site
   workspace.

What this rule does **not** forbid: verification code (a Playwright behavior test authors
nothing — it checks), read-only shell (`jq` over a tool's output, `curl` to look at a
route), and the repo's own infrastructure. The line is authorship: nothing mechanical may
write toolchain inputs, and nothing but the compiler may write what the instance stores.

---

## 4. Worked example — from-prompt: a three-section landing page (core-only)

> *"Build me a landing page on my WordPress site: a hero, three feature columns, and a call to
> action at the bottom."*

Instance: stock WordPress + Twenty Twenty-Five, no suites, `toolchain` posture.
Transcripts are literal tool calls, `→` in, `←` out. Responses are abbreviated;
`… (n more)` marks an elision. `«epoch»` stands for the full 64-character fingerprint —
always send it in full.

**Step 0 — connect.**

```jsonc
→ wp_connect {}
← {
    "site_url": "http://127.0.0.1:9410",
    "posture": "toolchain",
    "fingerprint": "3dfb9d3876c486b31f2b55f52e505d72fca6297df8f89842202f8e0966867e12",
    "wp_version": "7.1",
    "blocks_count": 116,
    "suites": [],
    "interfaces_version": "1",
    "url_form": "pretty",
    "config_sources": { "url": "file", "user": "file", "app_password": "file" }
  }
```

`posture: "toolchain"` — every tool is available. `suites: []` — core blocks only, so no
Kadence rows, no third-party heroes. The fingerprint is the `epoch` value for every tree
below.

**Step 1 — the available blocks and the tokens.**

```jsonc
→ wp_manifest { "summary": true }
← {
    "fingerprint": "3dfb9d38…6e12",
    "posture": "toolchain",
    "wp_version": "7.1",
    "counts": { "blocks": 116, "dynamic_blocks": 86, "static_blocks": 30, "patterns": 109 },
    "theme_tokens": {
      "color":   { "palette": { "theme": [
        {"slug":"base","color":"#FFFFFF"}, {"slug":"contrast","color":"#111111"},
        {"slug":"accent-1","color":"#FFEE58"}, {"slug":"accent-3","color":"#503AA8"},
        {"slug":"accent-5","color":"#FBFAF3"} ] } },
      "spacing": { "spacingSizes": { "theme": [
        {"slug":"20","size":"10px"}, {"slug":"40","size":"30px"},
        {"slug":"50","size":"clamp(30px, 5vw, 50px)"}, {"slug":"70","size":"clamp(50px, 7vw, 90px)"},
        {"slug":"80","size":"clamp(70px, 10vw, 140px)"} ] } },
      "typography": { "fontSizes": { "theme": [
        {"slug":"medium","size":"1rem"}, {"slug":"large","size":"1.38rem"},
        {"slug":"x-large","size":"1.75rem"}, {"slug":"xx-large","size":"2.15rem"} ] } },
      "layout": { "contentSize": "645px", "wideSize": "1340px" }
    },
    "blocks": {
      "core/group":   { "title": "Group",   "is_dynamic": false },
      "core/heading": { "title": "Heading", "is_dynamic": true },
      "core/columns": { "title": "Columns", "is_dynamic": false },
      "core/column":  { "title": "Column",  "is_dynamic": false, "parent": ["core/columns"] },
      "core/buttons": { "title": "Buttons", "is_dynamic": false },
      "core/button":  { "title": "Button",  "is_dynamic": true,  "parent": ["core/buttons"] }
    },
    "summary": true, "filtered": false,
    "blocks_returned": 116, "blocks_total": 116, "served_from_cache": false
  }
```

That is the whole design system: five usable palette slugs, a seven-step spacing scale, five
font sizes, a 645/1340 content/wide pair. Everything below uses only these values — R4.

Now the full attribute schemas for just the blocks in play:

```jsonc
→ wp_manifest { "filter": { "name_prefix": "core/" } }
← { "blocks": { "core/heading": { "title": "Heading", "api_version": 3,
      "attributes": {
        "content": {"type":"rich-text","source":"rich-text","selector":"h1,h2,h3,h4,h5,h6"},
        "level":   {"type":"number","default":2},
        "align":   {"type":"string","enum":["left","center","right","wide","full",""]},
        "fontSize":{"type":"string"}, "style":{"type":"object"}, "…": "(11 more)"
      },
      "supports": { "align": ["wide","full"], "typography": {"fontSize":true,"textAlign":true} },
      "parent": null, "ancestor": null, "is_dynamic": true },
    "…": "(115 more blocks)" },
    "summary": false, "filtered": true, "blocks_returned": 116, "blocks_total": 116,
    "served_from_cache": true }
```

Note what is **not** there: `core/heading` has no `textAlign` attribute on this instance. It
has `supports.typography.textAlign`, which means alignment is set at
`style.typography.textAlign`. This is exactly the class of thing R2 exists to catch.

**Step 2 — retrieve before inventing.**

```jsonc
→ wp_patterns { "query": "hero", "limit": 5 }
← { "patterns": [
      { "name": "twentytwentyfive/hero-book", "title": "Hero book", "categories": ["banner"],
        "parsed_tree": [ { "blockName": "core/cover", "attrs": { "…": "…" }, "innerBlocks": ["…"] } ] },
      { "name": "twentytwentyfive/hero-full-width-image", "title": "Hero, full width image",
        "categories": ["banner"],
        "parsed_tree": [ { "blockName": "core/cover",
          "attrs": { "url": "…/themes/twentytwentyfive/assets/images/northern-buttercups-flowers.webp",
                     "alt": "Picture of a flower", "dimRatio": 10, "minHeight": 840,
                     "contentPosition": "bottom center", "align": "full",
                     "layout": { "type": "constrained" } },
          "innerBlocks": [ { "blockName": "core/group",
            "attrs": { "align": "wide", "layout": { "type": "constrained", "justifyContent": "left" } },
            "innerBlocks": ["…"] } ] } ] },
      { "name": "twentytwentyfive/hero-podcast", "title": "Hero podcast", "categories": ["banner"],
        "parsed_tree": ["…"] },
      "… (2 more)" ],
    "total": 7, "returned": 5,
    "fingerprint": "3dfb9d38…6e12", "served_from_cache": false }
```

All seven are image-led: a `core/cover` with a photograph behind the text. The brief asks for
a *text* hero, so widen the search to the whole category rather than inventing a shape:

```jsonc
→ wp_patterns { "category": "banner", "limit": 25 }
← { "patterns": [
      { "name": "twentytwentyfive/banner-intro", "title": "Intro with left-aligned description",
        "categories": ["banner"],
        "parsed_tree": [ { "blockName": "core/group",
          "attrs": { "align": "full", "layout": { "type": "constrained" },
            "style": { "spacing": { "padding": { "top": "var:preset|spacing|80",
                                                 "bottom": "var:preset|spacing|80" },
                                    "margin": { "top": "0", "bottom": "0" } } } },
          "innerBlocks": [ { "blockName": "core/heading",
                             "attrs": { "align": "wide", "fontSize": "x-large" } } ] } ] },
      { "name": "twentytwentyfive/banner-poster", "title": "Poster-like section",
        "categories": ["banner"], "parsed_tree": ["…"] },
      "… (17 more)" ],
    "total": 19, "returned": 19,
    "fingerprint": "3dfb9d38…6e12", "served_from_cache": true }
```

`banner-intro` is the theme's text-first band: a full-width `core/group` with `spacing|80`
padding top and bottom, an `align: "wide"` heading, and a preset font size. That is the shape
to adapt for all three sections — not an invention, something the theme already ships. Note
also that `served_from_cache` is now `true`: the pattern set is fetched once per fingerprint
and filtered locally, so searching it repeatedly is free.

**Step 3 — the tree.** Three top-level sections, each a full-width `core/group`. Every color
is a palette slug, every space is a `var:preset|spacing|…`, every size is a font-size slug.

**Step 4 — validate.**

```jsonc
→ wp_validate {
    "version": 1,
    "epoch": "«epoch»",
    "blocks": [
      { "name": "core/group",
        "attributes": {
          "tagName": "section", "align": "full", "backgroundColor": "accent-5",
          "layout": { "type": "constrained" },
          "style": { "spacing": {
            "padding": { "top": "var:preset|spacing|80", "bottom": "var:preset|spacing|80" },
            "blockGap": "var:preset|spacing|50" } } },
        "innerBlocks": [
          { "name": "core/heading",
            "attributes": { "level": 1, "content": "Ship the layout, not the guesswork.",
              "fontSize": "xx-large",
              "style": { "typography": { "textAlign": "center" } } } },
          { "name": "core/paragraph",
            "attributes": { "content": "Trees in, compiled markup out, geometry checked in pixels.",
              "fontSize": "large",
              "style": { "typography": { "textAlign": "center" } } } },
          { "name": "core/buttons",
            "attributes": { "layout": { "type": "flex", "justifyContent": "center" } },
            "innerBlocks": [
              { "name": "core/button",
                "attributes": { "text": "Start building", "url": "/docs",
                  "backgroundColor": "accent-3", "textColor": "base" } },
              { "name": "core/button",
                "attributes": { "text": "Read the contract", "url": "/contract",
                  "className": "is-style-outline" } } ] } ] },

      { "name": "core/group",
        "attributes": { "tagName": "section", "align": "full",
          "layout": { "type": "constrained" },
          "style": { "spacing": { "padding": {
            "top": "var:preset|spacing|70", "bottom": "var:preset|spacing|70" } } } },
        "innerBlocks": [
          { "name": "core/heading",
            "attributes": { "level": 2, "content": "Three properties",
              "style": { "typography": { "textAlign": "center" } } } },
          { "name": "core/columns",
            "attributes": { "align": "wide", "isStackedOnMobile": true,
              "style": { "spacing": { "blockGap": { "left": "var:preset|spacing|50" } } } },
            "innerBlocks": [
              { "name": "core/column", "attributes": { "width": "33.33%" },
                "innerBlocks": [
                  { "name": "core/heading",
                    "attributes": { "level": 3, "content": "Deterministic", "fontSize": "large" } },
                  { "name": "core/paragraph",
                    "attributes": { "content": "Markup comes from each block's own save()." } } ] },
              { "name": "core/column", "attributes": { "width": "33.33%" },
                "innerBlocks": [ { "name": "core/heading",
                    "attributes": { "level": 3, "content": "Measured", "fontSize": "large" } },
                  { "name": "core/paragraph",
                    "attributes": { "content": "Layout is diffed in pixels, not squinted at." } } ] },
              { "name": "core/column", "attributes": { "width": "33.33%" },
                "innerBlocks": [ { "name": "core/heading",
                    "attributes": { "level": 3, "content": "Extensible", "fontSize": "large" } },
                  { "name": "core/paragraph",
                    "attributes": { "content": "A vocabulary gap becomes a new dynamic block." } } ] }
            ] } ] },

      { "name": "core/group",
        "attributes": { "tagName": "section", "align": "full",
          "backgroundColor": "accent-3", "textColor": "base",
          "layout": { "type": "constrained" },
          "style": { "spacing": { "padding": {
            "top": "var:preset|spacing|80", "bottom": "var:preset|spacing|80" } } } },
        "innerBlocks": [
          { "name": "core/heading",
            "attributes": { "level": 2, "content": "Start with the manifest.",
              "fontSize": "x-large", "style": { "typography": { "textAlign": "center" } } } },
          { "name": "core/buttons",
            "attributes": { "layout": { "type": "flex", "justifyContent": "center" } },
            "innerBlocks": [ { "name": "core/button",
              "attributes": { "text": "Connect an instance", "url": "/start",
                "backgroundColor": "accent-1", "textColor": "contrast" } } ] } ] }
    ] }

← { "valid": true, "epoch_ok": true,
    "server_fingerprint": "3dfb9d38…6e12",
    "checked_locally_only": false,
    "diagnostics": [
      { "code": "W_STATIC_NEEDS_HARNESS", "severity": "warning", "path": "/blocks/0",
        "message": "Block \"core/group\" is static: its markup is defined by its JavaScript save() output.",
        "fix_hint": "canonical markup must come from harness compile, do not hand-serialize" },
      { "code": "W_STATIC_NEEDS_HARNESS", "severity": "warning", "path": "/blocks/0/innerBlocks/1",
        "message": "Block \"core/paragraph\" is static: …", "fix_hint": "…" },
      { "code": "W_STATIC_NEEDS_HARNESS", "severity": "warning", "path": "/blocks/0/innerBlocks/2",
        "message": "Block \"core/buttons\" is static: …", "fix_hint": "…" },
      { "code": "W_STATIC_NEEDS_HARNESS", "severity": "warning", "path": "/blocks/1/innerBlocks/1",
        "message": "Block \"core/columns\" is static: …", "fix_hint": "…" },
      { "code": "W_STATIC_NEEDS_HARNESS", "severity": "warning",
        "path": "/blocks/1/innerBlocks/1/innerBlocks/0",
        "message": "Block \"core/column\" is static: …", "fix_hint": "…" }
    ] }
```

`valid: true`. Five warnings, one per distinct static block name — these five blocks' markup
must come from the compiler, which is what happens next. Nothing to fix.

> **The mistake this example is designed to show.** A first pass wrote
> `"textAlign": "center"` on the headings, from memory. The instance answered:
> `W_ATTR_UNKNOWN` at `/blocks/0/innerBlocks/0/attributes/textAlign` —
> *"Attribute \"textAlign\" is not declared by \"core/heading\"."*, fix hint
> *"drop it, or check GET /manifest for the block's declared attributes"*.
> `valid` was still `true` — a warning does not block you — and that is exactly why R2 says
> warnings are review items. Shipping it would have produced a silently unaligned heading.
> The fix is `style.typography.textAlign`, which is what the tree above carries.

**Step 5 — compile.**

```jsonc
→ wp_compile { "version": 1, "epoch": "«epoch»", "blocks": [ /* the same tree, verbatim */ ] }
← { "markup": "<!-- wp:group {\"tagName\":\"section\",\"align\":\"full\",\"style\":{\"spacing\":{\"padding\":{\"top\":\"var:preset|spacing|80\",\"bottom\":\"var:preset|spacing|80\"},\"blockGap\":\"var:preset|spacing|50\"}},\"backgroundColor\":\"accent-5\",\"layout\":{\"type\":\"constrained\"}} -->\n<section class=\"wp-block-group alignfull has-accent-5-background-color has-background\" style=\"padding-top:var(--wp--preset--spacing--80);padding-bottom:var(--wp--preset--spacing--80)\"><!-- wp:heading {\"level\":1,\"style\":{\"typography\":{\"textAlign\":\"center\"}},\"fontSize\":\"xx-large\"} -->\n<h1 class=\"wp-block-heading has-text-align-center has-xx-large-font-size\">Ship the layout, not the guesswork.</h1>\n<!-- /wp:heading -->\n\n… (about 3.9 KB more)",
    "all_valid": true,
    "invalid": [],
    "registry_gaps": ["core/legacy-widget", "core/post-comments", "core/widget-group"],
    "epoch": "3dfb9d38…6e12" }
```

Three things worth reading in that output:

- `all_valid: true`, `invalid: []` — the check passed.
- The compiler **applied defaults and dropped redundancy**: `isStackedOnMobile: true` is gone
  from the `core/columns` delimiter because it *is* the default. This is the reason you never
  hand-write markup: you would have kept it, and it would have been wrong-but-valid noise.
- `registry_gaps` lists three blocks in the manifest that do not self-register in the harness
  page. None of them is in this tree, so it compiled. Had the tree used one, the call would
  have failed with `{code: "harness_gap", blocks: [...]}` instead of compiling something
  wrong.

**Step 6 — verify.** No design spec here (from-prompt), so verify the structure and geometry
you set out to build.

```jsonc
→ wp_verify { "markup": "<!-- wp:group … -->", "viewport": { "width": 1440, "height": 900 } }
← { "box_tree": [
      { "selector_path": "body > section:nth-of-type(1)", "block_name": "core/group",
        "box": { "x": 0, "y": 0, "w": 1440, "h": 512 },
        "computed": { "display": "block", "gap": "normal", "fontSize": "16px",
                      "color": "rgb(17, 17, 17)", "background": "rgb(251, 250, 243)" } },
      { "selector_path": "body > section:nth-of-type(1) > h1", "block_name": "core/heading",
        "box": { "x": 398, "y": 140, "w": 645, "h": 96 },
        "computed": { "display": "block", "gap": "normal", "fontSize": "34.4px",
                      "color": "rgb(17, 17, 17)", "background": "rgba(0, 0, 0, 0)" } },
      "… (34 more nodes)" ],
    "a11y_outline": [
      { "role": "heading", "name": "Ship the layout, not the guesswork.", "level": 1 },
      { "role": "heading", "name": "Three properties", "level": 2 },
      { "role": "heading", "name": "Deterministic", "level": 3 },
      "… (5 more)" ],
    "diffs": [],
    "pass": true }
```

Read the outline: one `h1`, then `h2`s, then `h3`s — no skipped level, no second `h1`. Read
the geometry: the hero group is full-bleed at 1440, its heading is clamped to the 645px
content size. That is the layout that was asked for, confirmed in numbers.

**Step 7 — accept. Once.**

```jsonc
→ wp_screenshot { "markup": "<!-- wp:group … -->", "viewport": { "width": 1440, "height": 900 } }
← { "path_to_png": "/tmp/x-agent-shot-3dfb9d38-1755781200.png",
    "viewport": { "width": 1440, "height": 900 },
    "bytes": 418227 }
```

Report the path. Do not take a second one.

---

## 5. Worked example — from-design: one hero image, with a deliberate token-snap delta

> *"Here's the hero from our Figma export — build it."* Input: a single 1440×900 PNG.

The pivot type is **DesignSpecIR**: measured geometry + candidate tokens + a content
inventory. It exists so from-design uses the same back half as from-prompt. Read
`references/design-spec.md` for the full authoring method; this is the shape of the round
trip.

**Step 1 — lift the image into a spec.** Measure boxes in source pixels. Sample colors. Read
the text. Then *quantize*: snap every observed value onto a clean scale and record what you
gave up.

**Step 2 — validate the spec before generating anything.**

```jsonc
→ wp_spec_validate {
    "version": 1,
    "source": { "kind": "image", "files": ["fixtures/images/hero-sample.png"],
                "viewport": { "width": 1440, "height": 900 } },
    "tokens_candidates": {
      "palette": [
        { "slug": "base",     "name": "Base",     "color": "#ffffff", "role": "background" },
        { "slug": "contrast", "name": "Contrast", "color": "#111111", "role": "text" },
        { "slug": "primary",  "name": "Primary",  "color": "#1a4fd6", "role": "primary" },
        { "slug": "accent",   "name": "Accent",   "color": "#f5b301", "role": "accent" } ],
      "spacing": { "scale_unit": "rem", "steps": [
        { "slug": "30", "size": "1rem" }, { "slug": "40", "size": "1.5rem" },
        { "slug": "50", "size": "3rem" }, { "slug": "60", "size": "4.5rem" } ] },
      "typography": {
        "families": [
          { "slug": "heading", "name": "Heading", "fontFamily": "\"Playfair Display\", Georgia, serif" },
          { "slug": "body",    "name": "Body",    "fontFamily": "\"Inter\", system-ui, sans-serif" } ],
        "sizes": [
          { "slug": "medium",   "size": "1rem" },
          { "slug": "large",    "size": "1.5rem" },
          { "slug": "xx-large", "size": "3.5rem", "fluid": { "min": "2.5rem", "max": "3.5rem" } } ] },
      "layout": { "contentSize": "720px", "wideSize": "1200px" },
      "quantization_log": [
        { "observed": "#fefefe", "snapped_to": "#ffffff", "delta": "+2/255 on each channel",
          "note": "screenshot antialiasing on the page ground" },
        { "observed": "#1b4ed4", "snapped_to": "#1a4fd6", "delta": "dE 0.9", "note": "brand blue" },
        { "observed": "46px",  "snapped_to": "3rem",   "delta": "+2px" },
        { "observed": "70px",  "snapped_to": "4.5rem", "delta": "+2px" },
        { "observed": "54px",  "snapped_to": "3.5rem", "delta": "+2px",
          "note": "hero headline; the single deliberate fidelity delta" },
        { "observed": "716px", "snapped_to": "720px",  "delta": "+4px", "note": "measured text column" },
        "… (7 more entries)" ] },
    "content": [
      { "id": "c-headline", "kind": "heading",   "text": "Ship the layout, not the guesswork.",
        "region_id": "hero-copy" },
      { "id": "c-lede",     "kind": "paragraph", "text": "Generate trees, compile them in the real editor, verify the geometry numerically.",
        "region_id": "hero-copy" },
      { "id": "c-cta",      "kind": "button",    "text": "Start building", "region_id": "hero-actions" },
      { "id": "c-shot",     "kind": "image",     "image_ref": "fixtures/images/hero-sample.png#media",
        "region_id": "hero-media" },
      "… (2 more)" ],
    "regions": [
      { "id": "hero", "role": "hero",
        "box": { "x": 0, "y": 0, "w": 1440, "h": 720 },
        "layout": { "direction": "row", "gap_px": 48, "align": "center",
                    "justify": "space-between", "columns": 2 },
        "style_refs": { "background_palette_slug": "base", "palette_slug": "contrast",
                        "spacing_slugs": ["60", "50"] },
        "responsive_assumptions": [
          { "breakpoint": "<=781px",  "change": "the two columns stack; media follows copy",
            "confidence": "synthesized" },
          { "breakpoint": "<=1200px", "change": "outer padding drops from spacing 60 to spacing 50",
            "confidence": "synthesized" } ],
        "children": [
          { "id": "hero-copy", "role": "column",
            "box": { "x": 120, "y": 144, "w": 600, "h": 432 },
            "layout": { "direction": "column", "gap_px": 24, "align": "flex-start" },
            "style_refs": { "font_size_slug": "xx-large", "spacing_slugs": ["40"] },
            "children": [
              { "id": "hero-actions", "role": "item",
                "box": { "x": 120, "y": 496, "w": 420, "h": 56 },
                "layout": { "direction": "row", "gap_px": 16 },
                "style_refs": { "palette_slug": "primary", "spacing_slugs": ["30"] } } ] },
          { "id": "hero-media", "role": "item",
            "box": { "x": 768, "y": 120, "w": 552, "h": 480 },
            "layout": { "direction": "column", "gap_px": 0 },
            "style_refs": { "background_palette_slug": "accent" } } ] } ] }

← { "valid": true, "diagnostics": [] }
```

Clean. Note *why* it is clean: every concrete token value has a `quantization_log` entry
whose `snapped_to` equals it (else `W_UNQUANTIZED`), the top-level region declares responsive
assumptions (else `W_NO_RESPONSIVE`), every child box sits inside its parent within 2% slack
(else `E_BOX_OVERLAP`), and every `content[].region_id` resolves (else `E_ORPHAN_CONTENT`).

Both responsive assumptions are `confidence: "synthesized"` — correctly, because a single
static image contains no breakpoint information. Those two lines are what a human gets to
veto.

**Step 3 — apply the tokens, then build.** R9: system before layout.

```jsonc
→ wp_tokens_apply { "palette": [ /* … from tokens_candidates … */ ],
                    "spacing": { "scale_unit": "rem", "steps": [ "…" ] },
                    "typography": { "families": [ "…" ], "sizes": [ "…" ] },
                    "layout": { "contentSize": "720px", "wideSize": "1200px" },
                    "dry_run": true }
← { "applied": false, "dry_run": true, "adapters_applied": [],
    "fingerprint": "3dfb9d38…6e12",
    "theme_json_preview": { "color": { "palette": ["…"] }, "spacing": { "spacingSizes": ["…"] },
                            "typography": { "fontSizes": ["…"] },
                            "layout": { "contentSize": "720px", "wideSize": "1200px" } },
    "diff_against_instance": [ "… (9 token differences)" ] }
```

Then the same call without `dry_run`, which returns `applied: true` and a **new**
`fingerprint`. Use it (R3) — every tree from here carries the new value.

**Step 4 — map regions to blocks.** `role: "hero"` with `layout.direction: "row"`, two
children → a full-width `core/group` (`layout.type: "constrained"`) containing a
`core/columns` with `verticalAlignment: "center"`; `hero-copy` and `hero-media` become the
two `core/column`s; `hero-actions` becomes a `core/buttons` with `layout.type: "flex"`.
`gap_px: 48` snaps to the nearest spacing step. Then `wp_validate` → `wp_compile`, as in §4.

**Step 5 — verify against the spec.** This is what the spec was *for*.

```jsonc
→ wp_verify { "markup": "<!-- wp:group … -->",
              "spec": { /* the DesignSpecIR from step 2, verbatim */ },
              "viewport": { "width": 1440, "height": 900 } }
← { "box_tree": [ "… (28 nodes)" ],
    "a11y_outline": [ { "role": "heading", "name": "Ship the layout, not the guesswork.", "level": 1 },
                      "… (3 more)" ],
    "diffs": [
      { "region_id": "hero-copy", "kind": "font_size",
        "expected": "54px", "actual": "56px", "delta": 2, "within_tolerance": false },
      { "region_id": "hero-media", "kind": "position",
        "expected": { "x": 768, "y": 120 }, "actual": { "x": 770, "y": 120 },
        "delta": { "x": 2, "y": 0 }, "within_tolerance": true },
      { "region_id": "hero", "kind": "gap",
        "expected": 48, "actual": 48, "delta": 0, "within_tolerance": true }
    ],
    "pass": false }
```

`pass: false`, one diff outside tolerance. **Do not "fix" it.** Attribute it:

> **Itemized decision — hero headline size.**
> The image measures the headline at **54px**. The type scale I chose puts `xx-large` at
> **3.5rem = 56px**. I snapped 54 → 56 and logged it:
> `{ "observed": "54px", "snapped_to": "3.5rem", "delta": "+2px", "note": "hero headline; the single deliberate fidelity delta" }`.
> `wp_verify` therefore reports one `font_size` diff of **+2px** on `hero-copy`, outside the
> 1px font tolerance. This is the quantization, showing up exactly where it should.
>
> The alternative is a fifth font-size step at 54px that exists only for this headline — a
> one-off that every future page has to know about, to remove a 2px difference nobody can
> see. **Decision: keep the snap.** If a human disagrees, the fix is one token value, not a
> layout change.
>
> The other two diffs are inside tolerance: `hero-media` is 2px right of the measured box
> because the 1200px wide-size splits differently than the source's hand-placed column, and
> the 48px gap landed exactly on the spacing step.

That paragraph — not the screenshot — is the deliverable of this step. `wp_verify` turned
"close enough" into one number attached to one logged decision. Rerun with
`{"tolerances": {"font_size_px": 2}}` **only** if the user accepts the snap as policy;
widening a tolerance to make a report pass without saying so is misreporting the result.

Then, and only then, one `wp_screenshot`.

---

## 6. Worked example — a missing component, through the whole R7 sequence

> *"Add a testimonial section: a quote, an avatar, the person's name and role, and a star
> rating."* Instance: core-only, `toolchain` posture.

**Option 1 — recompose.** Try existing blocks first, and say precisely what the result cannot
do.

```jsonc
→ wp_patterns { "query": "testimonial" }
← { "patterns": [
      { "name": "twentytwentyfive/testimonials-2-col", "title": "2 columns with avatar",
        "categories": ["testimonials"],
        "parsed_tree": [ { "blockName": "core/group",
          "attrs": { "align": "full",
            "style": { "spacing": { "padding": { "top": "var:preset|spacing|60",
                                                 "bottom": "var:preset|spacing|60" } } } },
          "innerBlocks": [ { "blockName": "core/columns",
            "attrs": { "align": "wide" }, "innerBlocks": ["…"] } ] } ] },
      { "name": "twentytwentyfive/testimonials-6-col", "title": "3 column layout with 6 testimonials",
        "categories": ["testimonials"], "parsed_tree": ["…"] },
      { "name": "twentytwentyfive/testimonials-large", "title": "Review with large image on right",
        "categories": ["testimonials"], "parsed_tree": ["…"] },
      { "name": "twentytwentyfive/page-business-home", "title": "Business homepage",
        "categories": ["twentytwentyfive_page", "featured"], "parsed_tree": ["…"] } ],
    "total": 4, "returned": 4,
    "fingerprint": "3dfb9d38…6e12", "served_from_cache": true }
```

Four hits, and `testimonials-2-col` is exactly the requested structure. Its `parsed_tree`
reads:

```
core/group  align:full, padding spacing|60
└ core/columns  align:wide, blockGap spacing|60
  └ core/column
    └ core/columns  blockGap spacing|40
      ├ core/column  width:"64px"
      │ └ core/image  width:"64px", aspectRatio:"1", scale:"cover", linkDestination:"none"
      └ core/column
        └ core/quote  className:"is-style-plain"
          └ core/paragraph
```

**Option 1 gets you the quote, the avatar, the name and the role**, in the theme's own
spacing, with a rounded 1:1 avatar and a registered block style. Adapt it — strip
`innerHTML` from `parsed_tree`, keep `blockName`/`attrs`/`innerBlocks`, swap the content.
That covers most of the brief for one tool call.

What it does not contain is **the rating**. No core block models "4 out of 5 stars", and R4
rules out the two workarounds: a `className` plus a stylesheet you have nowhere to put, or a
literal `"★★★★★"` paragraph that no screen reader announces as a rating and no editor can
ever change to a 4. **Option 1 succeeds for everything except the rating.**

**Option 2 — a block style or pattern.** The pattern is already in hand, and a block style
changes *appearance*, not structure or data. A rating is data: a number an editor must be
able to set and the front end must render as structured, accessible output. No registered
style adds an attribute. **Option 2 cannot close the gap either.**

**Option 3 — scaffold a dynamic block.** State the cost explicitly: *this adds a block that
someone now owns, because options 1 and 2 cannot represent the rating as data.*

```jsonc
→ wp_block_scaffold {
    "slug": "testimonial-card",
    "title": "Testimonial card",
    "attributes": [
      { "name": "quote",     "type": "string",  "control": "textarea" },
      { "name": "author",    "type": "string",  "control": "text" },
      { "name": "role",      "type": "string",  "control": "text", "default": "" },
      { "name": "avatarUrl", "type": "string",  "control": "text", "default": "" },
      { "name": "rating",    "type": "number",  "control": "number", "default": 5 },
      { "name": "variant",   "type": "string",  "control": "select", "default": "card",
        "options": [ { "label": "Card",  "value": "card" },
                     { "label": "Plain", "value": "plain" } ] }
    ],
    "render_intent": "A blockquote containing the quote text, then a footer row with an optional avatar image, the author name, the optional role, and the rating rendered as an accessible group with role=img and an aria-label like '5 out of 5 stars'. Use theme preset classes only; no inline color or size. The variant attribute selects a wrapper class." }

← { "dir": "/tmp/x-agent-blocks/testimonial-card",
    "name": "agent/testimonial-card",
    "files": [ "block.json", "render.php", "package.json", "src/edit.js", "src/index.js" ] }
```

Now **you** implement `render.php` against that `render_intent` comment. Requirements:
`get_block_wrapper_attributes()` for the wrapper, `esc_html()` / `esc_url()` / `esc_attr()`
on every attribute that reaches output, no `echo` of raw input, and the rating clamped to its
range rather than trusted.

```jsonc
→ wp_block_build_test {
    "dir": "/tmp/x-agent-blocks/testimonial-card",
    "sample_attributes": { "quote": "It compiles the first time.",
                           "author": "A. Developer", "role": "Staff Engineer",
                           "rating": 5, "variant": "card" } }

← { "built": true,
    "smoke": {
      "registered": true,
      "rendered_html": "<figure class=\"wp-block-agent-testimonial-card is-variant-card\"><blockquote><p>It compiles the first time.</p></blockquote><figcaption><span class=\"wp-block-agent-testimonial-card__author\">A. Developer</span><span class=\"wp-block-agent-testimonial-card__role\">Staff Engineer</span><span role=\"img\" aria-label=\"5 out of 5 stars\">…</span></figcaption></figure>" },
    "zip_path": "/tmp/x-agent-blocks/agent-testimonial-card-1.0.0.zip",
    "build_log": "… (syntax-gate output when a script fails to parse)" }
```

This is **the safety check**: `built: true`, `registered: true`, and `rendered_html`
actually contains the sample values. Had `render.php` had a syntax error, you would have got
`smoke.php_error` populated, **no `zip_path`**, and nothing would have been sent to the
instance. The companion deliberately does not lint PHP — this local check is the only one
there is. If it fails, fix `render.php` and run it again. Do not proceed.

```jsonc
→ wp_block_install { "zip_path": "/tmp/x-agent-blocks/agent-testimonial-card-1.0.0.zip" }
← { "installed": { "slug": "testimonial-card", "name": "agent/testimonial-card", "version": "1.0.0" },
    "fingerprint": "9c1e4b7a0d5f38e26ab4c90f17d2e85b3fa6c04198be7d52036cfa81e94b7d60",
    "replaced_previous": false }
```

**The fingerprint just changed, because your install changed the instance.** The block is now
available like any other. Use the new fingerprint immediately — a tree carrying the old one
gets `E_EPOCH_MISMATCH`.

```jsonc
→ wp_validate {
    "version": 1,
    "epoch": "9c1e4b7a…7d60",
    "blocks": [
      { "name": "core/group",
        "attributes": { "tagName": "section", "align": "full",
          "layout": { "type": "constrained" },
          "style": { "spacing": { "padding": { "top": "var:preset|spacing|70",
                                               "bottom": "var:preset|spacing|70" },
                                  "blockGap": "var:preset|spacing|50" } } },
        "innerBlocks": [
          { "name": "core/heading",
            "attributes": { "level": 2, "content": "What people say",
              "style": { "typography": { "textAlign": "center" } } } },
          { "name": "core/columns", "attributes": { "align": "wide" },
            "innerBlocks": [
              { "name": "core/column",
                "innerBlocks": [
                  { "name": "agent/testimonial-card",
                    "attributes": { "quote": "It compiles the first time.",
                                    "author": "A. Developer", "role": "Staff Engineer",
                                    "rating": 5, "variant": "card" } } ] },
              { "name": "core/column",
                "innerBlocks": [
                  { "name": "agent/testimonial-card",
                    "attributes": { "quote": "The diff told me exactly which 2 pixels I gave up.",
                                    "author": "R. Designer", "role": "Design Lead",
                                    "rating": 5, "variant": "card" } } ] } ] } ] } ] }

← { "valid": true, "epoch_ok": true,
    "server_fingerprint": "9c1e4b7a…7d60",
    "checked_locally_only": false,
    "diagnostics": [
      { "code": "W_STATIC_NEEDS_HARNESS", "severity": "warning", "path": "/blocks/0",
        "message": "Block \"core/group\" is static: …", "fix_hint": "…" },
      { "code": "W_STATIC_NEEDS_HARNESS", "severity": "warning", "path": "/blocks/0/innerBlocks/1",
        "message": "Block \"core/columns\" is static: …", "fix_hint": "…" },
      { "code": "W_STATIC_NEEDS_HARNESS", "severity": "warning",
        "path": "/blocks/0/innerBlocks/1/innerBlocks/0",
        "message": "Block \"core/column\" is static: …", "fix_hint": "…" } ] }
```

Notice that the outer shape is still option 1's: the `core/group` + `core/columns` band the
theme's own `testimonials-2-col` pattern uses, with only the innermost column replaced by the
new block. Going to option 3 bought one block, not a new section — that is what "one option
at a time" means in practice.

`agent/testimonial-card` raises **no** `W_STATIC_NEEDS_HARNESS` — it is dynamic, which is the
point of R7's last sentence. Then `wp_compile` (check `registry_gaps`; a freshly installed
block that fails to self-register on the harness page is exactly the `harness_gap` case),
`wp_render` to see the server-side output of the dynamic block, `wp_verify`, and one
screenshot.

**If the instance had been `production` posture,** `wp_block_install` would have returned
`{"code": "posture_forbidden", "message": "…/blocks/install is an extend-tier route and is refused by design.", "hint": "clone to sandbox via wp_snapshot then apply there"}` — and the correct move is
that hint, verbatim: `wp_snapshot` → boot a sandbox from the zip → build and install there →
promote the artifact. R8.

---

## 7. Tool index

Twenty-three tools. Arguments are given as they appear in the input schemas; `{url, user, app_password}`
may be passed to any connected tool to override the config chain, and are omitted below.

Interfaces-v2 surfaces worth knowing before the table: `wp_manifest` serves `section:
"styles" | "variations" | "global_styles" | "bindings" | "data_model" | "features"` and, on a
v2 instance, merges client-registered variations/styles captured from the warm harness page
(`source: "client"`, cached per fingerprint; opt out with `client_capture: false`).
`wp_tokens_apply` accepts the level-5 `css` section. `wp_block_scaffold` accepts
`interactivity` and `stylesheet`. The three `wp_schema_*` tools are the backend factory —
their rules live in the sibling **wp-schema** skill.

| Tool | Args | Returns |
|---|---|---|
| `wp_connect` | — | `site_url, posture, fingerprint, wp_version, blocks_count, suites, interfaces_version, url_form, config_sources` |
| `wp_disconnect` | — | `disconnected, was_connected, session_closed, factory_closed, caches_cleared` |
| `wp_manifest` | `refresh?, summary?, filter{name_prefix?, dynamic_only?}?` | the Manifest + `summary, filtered, blocks_returned, blocks_total, served_from_cache` |
| `wp_patterns` | `query?, category?, limit?, include_markup?` | `patterns[{name,title,categories,parsed_tree,content?}], total, returned, fingerprint, served_from_cache` |
| `wp_validate` | `version, epoch, blocks` (a TreeIR, flattened) | `valid, epoch_ok, server_fingerprint?, diagnostics[], checked_locally_only` |
| `wp_compile` | `version, epoch, blocks` | `markup, all_valid, invalid[], registry_gaps[], epoch` |
| `wp_render` | `markup` | `html, enqueued_styles[]` |
| `wp_parse` | `markup, include_raw?` | `tree{version,epoch,blocks}, blocks?, dropped_freeform` |
| `wp_verify` | `markup? \| url?, spec?, spec_region_id?, viewport?, tolerances?, nav_timeout_ms?, wait?` | `box_tree[], a11y_outline[], diffs[], pass` |
| `wp_screenshot` | `markup? \| url?, viewport?, out_path?, nav_timeout_ms?, wait?` | `path_to_png, viewport, bytes` |
| `wp_spec_validate` | a DesignSpecIR, flattened: `version, source, tokens_candidates, content, regions` | `valid, diagnostics[]` |
| `wp_tokens_apply` | `palette, spacing, typography, layout, dry_run?` | `applied, dry_run, adapters_applied[], fingerprint, theme_json_written?, theme_json_preview, diff_against_instance[]` |
| `wp_block_scaffold` | `slug, title, description?, attributes[]? (each: name, type, control?, default?, options?, label?, help?), render_intent, dir?` | `dir, name, files[]` |
| `wp_block_build_test` | `dir, sample_attributes?` | `built, smoke{registered, rendered_html, php_error?}, zip_path?, build_log?` |
| `wp_block_install` | `zip_path` | `installed{slug,name,version}, fingerprint, replaced_previous` |
| `wp_snapshot` | `out_path?` | `zip_path, bytes, fingerprint, site_url` |
| `wp_placeholder` | `color` (hex or palette slug), `width?, height?` | `id, url, color, slug, reused` |
| `wp_pattern_save` | `slug (agent/…), title, content (compiled markup), categories?, description?` | `saved, replaced, total, fingerprint` (NEW — use it) |
| `wp_schema_scaffold` | `slug, intent, post_types[], taxonomies[]?, routes[]?, bindings[]?` | `dir, slug, files[], warnings[]` (URL-map collisions) — see the wp-schema skill |
| `wp_schema_build_test` | `dir` | `built, smoke{types_registered, meta_in_rest, routes[], bindings_registered, uninstall_clean}, zip_path?` — the schema build test |
| `wp_schema_install` | `zip_path` | `installed{slug,version}, fingerprint (NEW — use it), replaced_previous` |
| `wp_images_generate` | `post_id, rest_base?, style?, model?, out_dir?, dry_run?` | `found, generated, out_dir, manifest_path, images[{path,intent,aspect_ratio,file}]` — the image pass, first half; site untouched |
| `wp_images_apply` | `post_id, rest_base?, manifest_path?` | `uploaded[{id,source_url}], swapped, skipped[], all_valid, link` — uploads, swaps url/id on the scanned nodes, recompiles, updates the post |

`wp_validate`, `wp_compile`, `wp_spec_validate` and `wp_tokens_apply` take their payload
**flattened into the tool arguments** — send `{version, epoch, blocks}`, not `{tree: {...}}`.

---

## 8. When something fails

Every tool failure is `{code, message, hint}` plus code-specific fields. Read the `hint`; it
is written to be actionable.

| code | what happened | what to do |
|---|---|---|
| `https_required` | plain `http://` to a non-local host | Use `https://`. Only loopback and playground hosts may be plain. |
| `invalid_input` | arguments or config missing/malformed | The message names the field. For config, `wp_connect` and read `config_sources`. |
| `companion_unreachable` | the site did not answer | Is it running? Is the URL right? Do not retry blindly. On `wp_verify`/`wp_screenshot` against a heavy front end (WooCommerce), pass `wait: "domcontentloaded"` and a lower `nav_timeout_ms` — some pages never reach network-idle. |
| `companion_error` | the site answered with an error; carries `status`, `wp_code` | `rest_forbidden` (401) = bad credentials. `rest_forbidden_capability` (403) = the user lacks the tier capability. |
| `posture_forbidden` | extend-tier tool on a `production` instance | R8. Snapshot → sandbox → promote. Do not try to bypass it. |
| `epoch_mismatch` | the fingerprint moved and stayed moved after one auto-retry | `wp_manifest({refresh: true})`, regenerate with the new fingerprint. |
| `harness_gap` | a block in your tree is in the manifest but absent from the harness registry; carries `blocks[]` and `registry_gaps[]` | Those blocks failed to self-register client-side, so their `save()` is unavailable and any markup would be wrong. Compose without them, fix the block's `editor_script_handles` on the instance, or enable the documented editor-injection fallback with `X_AGENT_HARNESS_FALLBACK=1` (default off — see the companion README's *Harness fallback*). |
| `build_failed` / `smoke_failed` | the R7 option-3 build test failed | Read `smoke.php_error` / `build_log`. Fix and rerun. Nothing was sent to the instance. |
| `not_implemented` | the tool is declared but its handler is not in this build | Tell the user which tool; do not work around it with hand-written markup. |

One failure mode is posture-dependent and worth understanding. Many suites register their
editor scripts from an `init` callback guarded by `is_admin()`, and a REST request is not
admin — so their blocks would be missing from the harness registry entirely. The companion
works around this by presenting the harness request as an editor request, **on by default in
`toolchain` posture and off in `production`**. Measured with Kadence Blocks active, that is
the difference between all 59 of its blocks compiling and none of them. So a suite tree that
compiles cleanly against your sandbox can return `harness_gap` against a production
instance. Read `registry_gaps` on every compile instead of trusting yesterday's result — and
note that three core blocks (`core/legacy-widget`, `core/post-comments`,
`core/widget-group`) are gaps on every instance, bare core included.

---

## 9. The references

Two files sit next to this one. Load them when the task calls for them — not by default.

- **`references/tree-ir.md`** — TreeIR and Diagnostics quick reference: every diagnostic code
  with its trigger and its fix, the global attribute whitelist, the epoch rule, JSON-pointer
  paths, and three worked trees (a core page, a suite section, an agent-block usage).
  *Read it when:* you hit a diagnostic you cannot immediately fix, you are working with a
  third-party suite's blocks, or you are lifting existing content with `wp_parse`.
- **`references/design-spec.md`** — the Design Spec IR authoring guide: how to measure an
  image instead of tracing it, how to quantize and log, region roles and how they map to
  block composition, and exactly what `wp_spec_validate` checks.
  *Read it when:* the input is an image, a Figma export, an HTML comp or any other visual
  reference — i.e. **before** you write a single spec field in from-design mode.
