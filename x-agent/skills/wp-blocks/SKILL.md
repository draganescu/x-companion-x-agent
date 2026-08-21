---
name: wp-blocks
description: >-
  Build, edit and verify WordPress block layouts against a live WordPress instance running the
  X Companion plugin. Use whenever the task involves WordPress blocks or Gutenberg, block themes,
  building or changing a page, pattern, template, hero, section or landing page on a WordPress
  site, turning a design — Figma file, screenshot, mockup or HTML comp — into WordPress,
  editing theme.json or design tokens/presets, block patterns and block styles, adding a
  testimonial/pricing/feature/CTA section, fixing block validation errors, or any mention of
  X Companion, x-agent, TreeIR, a block manifest/fingerprint, or the wp_* MCP tools
  (wp_connect, wp_manifest, wp_validate, wp_compile, wp_verify). The agent generates validated
  JSON block trees that a real browser compiles into canonical markup; it never hand-writes
  "<!-- wp:" markup.
---

# WordPress blocks, as engineering

You are connected to **one specific WordPress instance**. That instance — not your memory of
"what WordPress has" — defines every block, attribute, pattern and design token you may use. The
`x-agent` MCP server is the only way you touch it.

The single non-negotiable: **you never write serialized block markup.** You write JSON
(*TreeIR*); the instance's own browser-side `save()` functions turn it into markup. Everything
else in this file exists to make that loop fast and checkable.

---

## 1. The loop

Run this loop. Do not improvise a different one.

| # | Step | Tool | Gate before moving on |
|---|---|---|---|
| 0 | Connect | `wp_connect` | You have `posture` and `fingerprint`. The fingerprint is the **epoch**. |
| 1 | Learn the vocabulary | `wp_manifest` (`summary:true`, then `filter`) | You know the blocks, tokens and counts that actually exist here. |
| 2 | **Retrieve before inventing** | `wp_patterns` | You looked. Adapting a registered pattern beats a novel composition. |
| 3 | Generate the tree | — (you write JSON) | Every node's name and attributes came from step 1. |
| 4 | Validate | `wp_validate` | `valid: true`. Every warning has been read and either fixed or justified. |
| 5 | Compile | `wp_compile` | `all_valid: true`, `invalid: []`. This is the only source of markup. |
| 6 | Verify numerically | `wp_verify` | `pass: true`, or every remaining diff is a logged, itemized decision. |
| 7 | Accept | `wp_screenshot` | **Exactly once**, at the very end. |

Steps 3→6 iterate. Steps 0–2 repeat only when the epoch moves.

Three things that are *not* in the loop, on purpose:

- **No screenshot-diffing.** `wp_verify` returns numbers — boxes, gaps, font sizes, colors,
  an accessibility outline. Iterate on numbers. A screenshot is terminal evidence for a human,
  not an input to your next edit.
- **No hand-written markup, ever.** Not "just this once for a quick test". See R1.
- **No raw CSS.** Styling is a vocabulary problem, not a stylesheet problem. See R4.

---

## 2. The ten rules

These are the discipline. They are numbered so you can cite them: "R7 step 2" is a complete
explanation of a decision.

### R1 — NEVER hand-write serialized block markup (`'<!-- wp:'`). Generate TreeIR; markup exists only as `wp_compile` output.

Gutenberg's persisted content is HTML with JSON in comment delimiters, and its validity is
defined by each block's **JavaScript `save()`** function — attribute order, class names,
whitespace, wrapper elements, deprecations. No model reproduces that reliably. Markup you write
by hand looks right and breaks in the editor, usually days later, in someone else's session.

So: a tree is `{version: 1, epoch, blocks: [...]}`, and a `BlockNode` is
`{name, attributes?, innerBlocks?}` — nothing else. `innerHTML` in a tree is a hard schema error
(`E_TREE_SCHEMA`) precisely because it is compiler output leaking into an input.

This also means: **do not paste markup from your memory of a pattern, from a blog post, or from
another site.** If you need to start from existing markup, run it through `wp_parse` — that is
what it is for.

### R2 — Vocabulary = `wp_manifest` at current fingerprint. Never assume a block exists; never use attributes not in the manifest entry (`W_ATTR_UNKNOWN` warnings are review items, not noise).

The manifest is the registry, verbatim: every block's attribute schema with types, enums and
defaults; `supports`; `parent`/`ancestor` constraints; `is_dynamic`; and `agent_hints` when a
block author declared machine-invisible constraints.

Two habits:

- Start with `wp_manifest({summary: true})` to see what exists, then
  `wp_manifest({filter: {name_prefix: "core/"}})` for the full attribute schemas of the family
  you actually need. The full blocks map is large — 116 blocks on a bare core install, 175 with
  one suite active.
- Treat `W_ATTR_UNKNOWN` as a **finding**. It usually means you used an attribute that WordPress
  moved. Real example: `core/heading` no longer declares `textAlign`; text alignment now lives at
  `style.typography.textAlign`. Your memory said `textAlign`; the instance said no. The instance
  wins, every time.

`agent_hints.usage_notes` and `agent_hints.example_attributes` are free correct answers when they
are present. Read them.

### R3 — Every tree carries `epoch` = current fingerprint. On any `epoch_mismatch`, refresh manifest, regenerate or re-validate, continue.

The fingerprint is a hash of the block registry, the theme and the active plugins. It changes when
a plugin is activated, a theme is switched, tokens are written, or a block is installed. A tree
generated against a stale world may compile into something quietly wrong, so the companion refuses
it: `E_EPOCH_MISMATCH` at `/epoch`, with `epoch_ok: false` — **and it still runs every other
check**, so a stale round trip is never wasted.

The client refreshes and retries **once**, automatically. If it still mismatches, you get
`{code: "epoch_mismatch"}`. Then: `wp_manifest({refresh: true})`, re-read anything you cached,
regenerate the tree with the new epoch. Never loop on it, and never invent an epoch value — it is
an opaque string from `wp_connect`/`wp_manifest`, not something you compute.

Your own actions move the epoch. `wp_tokens_apply` and `wp_block_install` both return a **new**
`fingerprint`; adopt it in the very next tree.

### R4 — Styling ONLY via theme tokens (preset slugs / supports attributes: `backgroundColor`, `fontSize`, spacing presets, `layout`). Raw CSS/HTML styling is forbidden; if tokens can't express it, that is a vocabulary gap → R7 ladder, not an inline style.

This is where most of the craft lives, so be concrete about what "tokens" means.

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
classes the theme actually ships. It is not a hatch for `class="my-custom-thing"` plus a
stylesheet you were about to write. There is nowhere to put that stylesheet, and that is the
point.

When the tokens genuinely cannot express the design — a card with a specific overlap, a badge, a
ratings row — **stop styling and go to R7**. An inline style is a silent decision; a new block is
a reviewable one.

### R5 — Loop: retrieve (`wp_patterns` first — adapt idioms before inventing) → generate tree → `wp_validate` (fix all errors, review warnings) → `wp_compile` (must be `all_valid`) → `wp_verify` against spec/expectations (fix diffs outside tolerance) → repeat. `wp_screenshot` exactly once, at the end, as acceptance evidence.

The order is load-bearing:

1. **`wp_patterns` first.** The instance ships a corpus of layout idioms that are already correct
   for this theme — 109 of them on a stock Twenty Twenty-Five install. Search it
   (`wp_patterns({query: "hero"})`), read `parsed_tree`, and adapt. `parsed_tree` is already
   TreeIR-shaped: strip `innerHTML`/`innerContent`, keep `blockName`/`attrs`/`innerBlocks`.
   Inventing a composition that the theme already ships is how you produce something that looks
   subtly off.
2. **`wp_validate` before `wp_compile`.** Validation is cheap and specific; compiling is a browser
   round trip. A local TreeIR schema pre-check runs first and short-circuits without any network
   call, so malformed trees cost nothing. Fix every `severity: "error"`. Read every warning: fix
   `W_ATTR_UNKNOWN`, satisfy `W_HINT_ALLOWED_BLOCKS` and `W_HINT_TEMPLATE_LOCK`. Expect
   `W_STATIC_NEEDS_HARNESS` — one per distinct static block name — and let it stand: it is the
   contract reminding you that this block's markup must come from the compiler.
3. **`wp_compile` must return `all_valid: true` and `invalid: []`.** Anything in `invalid[]` means
   a block round-tripped through `parse()` and came back as invalid — you shipped attributes its
   `save()` cannot express. Fix the tree; do not fix the markup.
4. **`wp_verify` is the oracle.** With a spec it returns `diffs[]` and `pass`. Without a spec it
   returns `box_tree` and `a11y_outline` — still useful: check the heading levels are a sane
   outline and that the geometry matches what you claimed you were building.
5. **One screenshot.** At the end. `wp_screenshot` is for a human to nod at.

If you find yourself calling `wp_screenshot` twice, you have replaced engineering with squinting.

**Images before assets exist — the placeholder default.** A layout is not allowed to wait for
photography, and an agent never hotlinks stock imagery it cannot license. When a design calls for
an image and no real asset exists yet:

1. `wp_placeholder({color: "accent-2"})` — one call per colour, idempotent. Pass a **palette
   slug** so the placeholder sits on the design system; it returns `{id, url}` for a 1×1 GIF
   attachment.
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

The intent leaf is the hand-off to a later **image-generation pass**: it runs `wp_parse` on the
published page, walks the tree for `metadata.imageIntent`, generates or sources each asset,
uploads it, swaps `url`/`id` on that node, recompiles, and drops or keeps the intent as
provenance. Layout and content ship now; pixels arrive when they are ready.

### R6 — from-design mode: lift binaries into DesignSpecIR per `references/design-spec.md` (measure, don't trace; quantize every observed value onto the token scale and log the delta; mark every synthesized responsive behavior). `wp_spec_validate` must pass before any tree is generated. `wp_verify` diffs are then attributable: token decision, mapping approximation, or vocabulary gap.

An image is not a layout. Read `references/design-spec.md` before you lift one — the whole method
is there. The short version:

- **Measure, don't trace.** Record boxes in source pixels, then decide what they mean.
- **Quantize everything onto the token scale**, and put every snap in `quantization_log` as
  `{observed, snapped_to, delta}`. A design where nothing was snapped is a design nobody thought
  about.
- **Mark every responsive behavior you inferred** with `confidence: "synthesized"`. A single
  static image contains zero information about breakpoints. Those entries are the items a human
  gets to veto, and they can only veto what you flagged.
- **`wp_spec_validate` must pass before you generate a tree.** Its whole point is to catch a
  confused reading of the image while it is still cheap.

Then, when `wp_verify` reports a diff, you can say which of three things it is: a token decision
already in the log, an approximation in how a region mapped to blocks, or a genuine gap in the
vocabulary. "It looks a bit off" is not one of the three.

### R7 — Vocabulary-gap ladder, in order: (1) different composition of existing blocks; (2) a block style/pattern; (3) new dynamic block via `wp_block_scaffold` → implement `render.php` → `wp_block_build_test` (must pass) → `wp_block_install` → adopt new fingerprint. Static blocks are never created.

Climb this ladder **one rung at a time**, and say out loud which rung you are on and why the one
below it failed. Most "I need a custom block" moments die on rung 1.

**Rung 1 — recompose.** Before anything else, ask whether existing blocks in a different
arrangement produce the design. A `core/group` with `layout.type: "flex"` and a `blockGap` preset
is a row. A `core/columns` with `verticalAlignment` is a two-up. `core/media-text` is an
image-beside-text section that you were about to rebuild by hand. Check `wp_patterns` again with
different words. Rung 1 costs one tree regeneration and no new surface area.

**Rung 2 — a registered block style or pattern.** If the *structure* is right and only the
*appearance* differs, look for a registered block style (`className: "is-style-…"`) — the
manifest's `supports` and the theme's registered styles tell you what exists. A pattern that is
90% right and needs its content swapped is still rung 2, not rung 3.

**Rung 3 — a new dynamic block.** Only when 1 and 2 are genuinely exhausted. Four calls, in
order, none skippable:

```
wp_block_scaffold  → a directory: block.json (agent/{slug}), render.php, src/edit.js, package.json
  ↓  you implement render.php against the render_intent comment
     — escape every attribute, use get_block_wrapper_attributes(), no raw echo of input
wp_block_build_test → THE SAFETY GATE. wp-scripts build, boot a local Playground, register the
                      block, assert it appears in /wp/v2/block-types, render sample attributes,
                      produce the install zip. Must return built:true, smoke.registered:true and
                      no smoke.php_error. Nothing reaches the instance without this.
wp_block_install    → POST the zip. Returns the NEW fingerprint.
  ↓
adopt the new fingerprint as the epoch of every subsequent tree; the block is now vocabulary
```

**Static blocks are never created.** A static block freezes its `save()` output into every post
that used it; change the block and that content is invalid forever. Dynamic blocks render at
request time, so iteration is free. The scaffold cannot produce a static block and the companion
rejects a package whose `block.json` has no `render` entry (422 `block_policy`). Do not look for
the constant that turns this off.

**Rung 3 is a real cost.** A new block is code someone has to own. Say so when you take it.

### R8 — Posture awareness: extend-tier tools fail on `production` posture by design. For structural work on a production site: `wp_snapshot` → work in a sandbox instance → promote artifacts. Never look for a way around the gate.

`wp_connect` tells you the posture. Memorize the split:

| posture | you may | you may not |
|---|---|---|
| `toolchain` | everything | — |
| `production` | `wp_manifest`, `wp_patterns`, `wp_validate`, `wp_parse`, `wp_render`, `wp_compile`, `wp_verify`, `wp_screenshot`, `wp_spec_validate`, `wp_tokens_apply({dry_run: true})` | `wp_tokens_apply`, `wp_block_install`, `wp_snapshot`, `wp_placeholder` — 403 `posture_forbidden` |

The refusal happens in the permission callback, **before the request body is parsed**. It is not a
UI toggle and there is no header that changes it. When you hit it, the correct response is the
hint the error already gives you: snapshot to a sandbox, do the structural work there, promote the
artifact. Proposing that the user edit `wp-config.php` on their production site to get past a
safety gate is not a solution; it is the thing the gate exists to prevent.

Note `wp_tokens_apply({dry_run: true})` works everywhere and returns the full theme.json preview
plus a diff against the instance's current tokens. Use it to *show* the change you would make.

### R9 — Greenfield ordering: design tokens FIRST (as DesignTokens JSON, kept as source of truth), `wp_tokens_apply`, then layout. `theme.json` is a compile target, not the design system itself.

On a new build, resist starting with the hero. Decide the system first:

1. Write `DesignTokens` — `{palette, spacing, typography, layout}` — as JSON, and keep that file
   as the source of truth. It is what you will diff against later.
2. `wp_tokens_apply({dry_run: true})` to preview the compiled `theme.json` settings and the diff.
3. `wp_tokens_apply` for real (toolchain posture only). Adopt the returned fingerprint.
4. *Then* build layout, using only the slugs you just defined.

Doing it the other way round means every section picks its own near-miss values and you get a
"design system" that is really a list of accidents. `theme.json` is downstream: it is what the
tokens compile into, and the companion writes it into user-origin global styles so it survives
theme updates.

### R10 — Credentials stay in local config; never echo the app password into conversation, files, or tool outputs.

The WordPress Application Password lives in exactly one of three places, resolved in this order:
tool arguments → `.x-agent.json` in the working directory → `X_WP_URL` / `X_WP_USER` /
`X_WP_APP_PASSWORD` in the environment. It never leaves the machine except as an
`Authorization: Basic` header to the site itself. There is no relay and no credential custody —
that is a deliberate architectural position.

Concretely: do not print it, do not echo it back for confirmation, do not write it into a script,
a README, a commit, a test fixture or a log line. Do not read `.x-agent.json` "to check the
config" — call `wp_connect` and read `config_sources`, which reports *where* each field came from
(`arguments` | `file` | `env` | `missing`) and never what it is. The MCP server redacts registered
secrets, Basic headers and URL userinfo from every message it emits; do not defeat that by
quoting a value you obtained some other way.

If a credential is missing or wrong, say which field is missing and where it should go. That is
all the user needs.

---

## 3. Worked example — from-prompt: a three-section landing page (core-only)

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

`posture: "toolchain"` — the whole ladder is available. `suites: []` — core vocabulary only,
so no Kadence rows, no third-party heroes. The fingerprint is now the epoch for every tree below.

**Step 1 — the vocabulary and the tokens.**

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

That is the whole design system: five usable palette slugs, a seven-step spacing scale, five font
sizes, a 645/1340 content/wide pair. Everything below is spent out of that budget — R4.

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

Note what is **not** there: `core/heading` has no `textAlign` attribute on this instance. It has
`supports.typography.textAlign`, which means alignment is set at `style.typography.textAlign`.
This is exactly the class of thing R2 exists to catch.

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

All seven are image-led: a `core/cover` with a photograph behind the text. The brief asks for a
*text* hero, so widen the search to the whole category rather than inventing a shape:

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

There it is. `banner-intro` is the theme's text-first band: a full-width `core/group` with
`spacing|80` padding top and bottom, an `align: "wide"` heading, and a preset font size. That is
the shape to adapt for all three sections — not something you thought of, something the theme
already ships. Note also that `served_from_cache` is now `true`: the corpus is fetched once per
fingerprint and filtered locally, so searching it repeatedly is free.

**Step 3 — the tree.** Three top-level sections, each a full-width `core/group`. Every color is
a palette slug, every space is a `var:preset|spacing|…`, every size is a font-size slug.

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

`valid: true`. Five warnings, one per distinct static block name — that is the contract telling
you these five blocks' markup must come from the compiler, which is what happens next. Nothing to
fix.

> **The mistake this example is designed to show you.** A first pass wrote
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

- `all_valid: true`, `invalid: []` — the gate is passed.
- The compiler **applied defaults and dropped redundancy**: `isStackedOnMobile: true` is gone from
  the `core/columns` delimiter because it *is* the default. This is the reason you never
  hand-write markup: you would have kept it, and it would have been wrong-but-valid noise.
- `registry_gaps` lists three blocks in the manifest that do not self-register in the harness page.
  None of them is in this tree, so it compiled. Had the tree used one, the call would have failed
  with `{code: "harness_gap", blocks: [...]}` instead of compiling something wrong.

**Step 6 — verify.** No design spec here (from-prompt), so verify the structure and geometry you
claimed to be building.

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

Read the outline: one `h1`, then `h2`s, then `h3`s — no skipped level, no second `h1`. Read the
geometry: the hero group is full-bleed at 1440, its heading is clamped to the 645px content size.
That is the layout that was asked for, confirmed in numbers.

**Step 7 — accept. Once.**

```jsonc
→ wp_screenshot { "markup": "<!-- wp:group … -->", "viewport": { "width": 1440, "height": 900 } }
← { "path_to_png": "/tmp/x-agent-shot-3dfb9d38-1755781200.png",
    "viewport": { "width": 1440, "height": 900 },
    "bytes": 418227 }
```

Report the path. Do not take a second one.

---

## 4. Worked example — from-design: one hero image, with a deliberate token-snap delta

> *"Here's the hero from our Figma export — build it."* Input: a single 1440×900 PNG.

The pivot type is **DesignSpecIR**: measured geometry + candidate tokens + a content inventory.
It exists so from-design uses the same back half as from-prompt. Read
`references/design-spec.md` for the full authoring method; this is the shape of the round trip.

**Step 1 — lift the image into a spec.** Measure boxes in source pixels. Sample colors. Read the
text. Then *quantize*: snap every observed value onto a clean scale and record what you gave up.

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

Clean. Note *why* it is clean: every concrete token value has a `quantization_log` entry whose
`snapped_to` equals it (else `W_UNQUANTIZED`), the top-level region declares responsive
assumptions (else `W_NO_RESPONSIVE`), every child box sits inside its parent within 2% slack (else
`E_BOX_OVERLAP`), and every `content[].region_id` resolves (else `E_ORPHAN_CONTENT`).

Both responsive assumptions are `confidence: "synthesized"` — correctly, because a single static
image contains no breakpoint information. Those two lines are what a human gets to veto.

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

Then the same call without `dry_run`, which returns `applied: true` and a **new** `fingerprint`.
Adopt it (R3) — every tree from here carries the new epoch.

**Step 4 — map regions to blocks.** `role: "hero"` with `layout.direction: "row"`, two children →
a full-width `core/group` (`layout.type: "constrained"`) containing a `core/columns` with
`verticalAlignment: "center"`; `hero-copy` and `hero-media` become the two `core/column`s;
`hero-actions` becomes a `core/buttons` with `layout.type: "flex"`. `gap_px: 48` snaps to the
nearest spacing step. Then `wp_validate` → `wp_compile`, as in §3.

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
> `wp_verify` therefore reports one `font_size` diff of **+2px** on `hero-copy`, outside the 1px
> font tolerance. This is the quantization, showing up exactly where it should.
>
> The alternative is a fifth font-size step at 54px that exists only for this headline — a
> one-off that every future page has to know about, to remove a 2px difference nobody can see.
> **Decision: keep the snap.** If a human disagrees, the fix is one token value, not a layout
> change.
>
> The other two diffs are inside tolerance: `hero-media` is 2px right of the measured box because
> the 1200px wide-size splits differently than the source's hand-placed column, and the 48px gap
> landed exactly on the spacing step.

That paragraph — not the screenshot — is the deliverable. `wp_verify` turned "close enough" into
one number attached to one logged decision. Rerun with
`{"tolerances": {"font_size_px": 2}}` **only** if the user accepts the snap as policy; changing the
tolerance to make a report green without saying so is falsifying the oracle.

Then, and only then, one `wp_screenshot`.

---

## 5. Worked example — a vocabulary gap, up the whole R7 ladder

> *"Add a testimonial section: a quote, an avatar, the person's name and role, and a star
> rating."* Instance: core-only, `toolchain` posture.

**Rung 1 — recompose.** Try existing blocks first, and say precisely what the result cannot do.

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

Four hits, and `testimonials-2-col` is exactly the requested structure. Its `parsed_tree` reads:

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

**Rung 1 gets you the quote, the avatar, the name and the role**, in the theme's own spacing, with
a rounded 1:1 avatar and a registered block style. Adapt it — strip `innerHTML` from `parsed_tree`,
keep `blockName`/`attrs`/`innerBlocks`, swap the content. That is four fifths of the brief for one
tool call.

What it does not contain is **the rating**. There is no core block whose vocabulary includes "4 out
of 5 stars", and R4 rules out the two fakes: a `className` plus a stylesheet you have nowhere to
put, or a literal `"★★★★★"` paragraph that no screen reader announces as a rating and no editor can
ever change to a 4. **Rung 1 succeeds for everything except the rating.**

**Rung 2 — a block style or pattern.** The pattern is already in hand and a block style changes
*appearance*, not structure or data. A rating is data: a number an editor must be able to set and
the front end must render as structured, accessible output. No registered style adds an attribute.
**Rung 2 cannot close the gap either.**

**Rung 3 — scaffold a dynamic block.** State the cost out loud: *this adds a block that someone
now owns, because rungs 1 and 2 cannot represent the rating as data.*

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

Now **you** implement `render.php` against that `render_intent` comment. Non-negotiables:
`get_block_wrapper_attributes()` for the wrapper, `esc_html()` / `esc_url()` / `esc_attr()` on
every attribute that reaches output, no `echo` of raw input, and the rating clamped to its range
rather than trusted.

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
    "build_log": "… (wp-scripts build output, 41 lines)" }
```

This is **the safety gate**: `built: true`, `registered: true`, and `rendered_html` actually
contains the sample values. Had `render.php` had a syntax error, you would have got
`smoke.php_error` populated, **no `zip_path`**, and nothing would have been sent to the instance.
The companion deliberately does not lint PHP — this local gate is the only one there is. If it
fails, fix `render.php` and run it again. Do not proceed.

```jsonc
→ wp_block_install { "zip_path": "/tmp/x-agent-blocks/agent-testimonial-card-1.0.0.zip" }
← { "installed": { "slug": "testimonial-card", "name": "agent/testimonial-card", "version": "1.0.0" },
    "fingerprint": "9c1e4b7a0d5f38e26ab4c90f17d2e85b3fa6c04198be7d52036cfa81e94b7d60",
    "replaced_previous": false }
```

**The epoch just moved, because you moved it.** The block is vocabulary now. Adopt the new
fingerprint immediately — a tree carrying the old one gets `E_EPOCH_MISMATCH`.

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

Notice that the outer shape is still rung 1's: the `core/group` + `core/columns` band the theme's
own `testimonials-2-col` pattern uses, with only the innermost column replaced by the new block.
Climbing to rung 3 bought one block, not a new section — that is what "one rung at a time" means in
practice.

`agent/testimonial-card` raises **no** `W_STATIC_NEEDS_HARNESS` — it is dynamic, which is the whole
point of R7's last sentence. Then `wp_compile` (check `registry_gaps`; a freshly installed block
that fails to self-register on the harness page is exactly the `harness_gap` case), `wp_render` to
see the server-side output of the dynamic block, `wp_verify`, and one screenshot.

**If the instance had been `production` posture,** `wp_block_install` would have returned
`{"code": "posture_forbidden", "message": "…/blocks/install is an extend-tier route and is refused by design.", "hint": "clone to sandbox via wp_snapshot then apply there"}` — and the correct move is
that hint, verbatim: `wp_snapshot` → boot a sandbox from the zip → build and install there →
promote the artifact. R8.

---

## 6. Tool index

Seventeen tools. Arguments are given as they appear in the input schemas; `{url, user, app_password}`
may be passed to any connected tool to override the config chain, and are omitted below.

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
| `wp_verify` | `markup? \| url?, spec?, spec_region_id?, viewport?, tolerances?` | `box_tree[], a11y_outline[], diffs[], pass` |
| `wp_screenshot` | `markup? \| url?, viewport?, out_path?` | `path_to_png, viewport, bytes` |
| `wp_spec_validate` | a DesignSpecIR, flattened: `version, source, tokens_candidates, content, regions` | `valid, diagnostics[]` |
| `wp_tokens_apply` | `palette, spacing, typography, layout, dry_run?` | `applied, dry_run, adapters_applied[], fingerprint, theme_json_written?, theme_json_preview, diff_against_instance[]` |
| `wp_block_scaffold` | `slug, title, attributes[]?, render_intent, dir?` | `dir, name, files[]` |
| `wp_block_build_test` | `dir, sample_attributes?` | `built, smoke{registered, rendered_html, php_error?}, zip_path?, build_log?` |
| `wp_block_install` | `zip_path` | `installed{slug,name,version}, fingerprint, replaced_previous` |
| `wp_snapshot` | `out_path?` | `zip_path, bytes, fingerprint, site_url` |
| `wp_placeholder` | `color` (hex or palette slug) | `id, url, color, slug, reused` |

`wp_validate`, `wp_compile`, `wp_spec_validate` and `wp_tokens_apply` take their payload
**flattened into the tool arguments** — send `{version, epoch, blocks}`, not `{tree: {...}}`.

---

## 7. When something fails

Every tool failure is `{code, message, hint}` plus code-specific fields. Read the `hint`; it is
written to be actionable.

| code | what happened | what to do |
|---|---|---|
| `https_required` | plain `http://` to a non-local host | Use `https://`. Only loopback and playground hosts may be plain. |
| `invalid_input` | arguments or config missing/malformed | The message names the field. For config, `wp_connect` and read `config_sources`. |
| `companion_unreachable` | the site did not answer | Is it running? Is the URL right? Do not retry blindly. |
| `companion_error` | the site answered with an error; carries `status`, `wp_code` | `rest_forbidden` (401) = bad credentials. `rest_forbidden_capability` (403) = the user lacks the tier capability. |
| `posture_forbidden` | extend-tier tool on a `production` instance | R8. Snapshot → sandbox → promote. Never route around it. |
| `epoch_mismatch` | the fingerprint moved and stayed moved after one auto-retry | `wp_manifest({refresh: true})`, regenerate with the new epoch. |
| `harness_gap` | a block in your tree is in the manifest but absent from the harness registry; carries `blocks[]` and `registry_gaps[]` | Those blocks failed to self-register client-side, so their `save()` is unavailable and any markup would be wrong. Compose without them, fix the block's `editor_script_handles` on the instance, or enable the documented editor-injection fallback with `X_AGENT_HARNESS_FALLBACK=1` (default off — see the companion README's *Harness fallback*). |
| `build_failed` / `smoke_failed` | R7 rung 3 gate failed | Read `smoke.php_error` / `build_log`. Fix and rerun. Nothing was sent to the instance. |
| `not_implemented` | the tool is declared but its handler is not in this build | Tell the user which tool; do not work around it with hand-written markup. |

The case that will surprise you is posture-dependent. Many suites register their editor scripts
from an `init` callback guarded by `is_admin()`, and a REST request is not admin — so their blocks
would be missing from the harness registry entirely. The companion works around this by presenting
the harness request as an editor request, **on by default in `toolchain` posture and off in
`production`**. Measured with Kadence Blocks active, that is the difference between all 59 of its
blocks compiling and none of them. So a suite tree that compiles cleanly against your sandbox can
return `harness_gap` against a production instance. Read `registry_gaps` on every compile instead
of trusting yesterday's result — and note that three core blocks (`core/legacy-widget`,
`core/post-comments`, `core/widget-group`) are gaps on every instance, bare core included.

---

## 8. The references

Two files sit next to this one. Load them when the task calls for them — not by default.

- **`references/tree-ir.md`** — TreeIR and Diagnostics quick reference: every diagnostic code with
  its trigger and its fix, the global attribute whitelist, the epoch rule, JSON-pointer paths, and
  three worked trees (a core page, a suite section, an agent-block usage).
  *Read it when:* you hit a diagnostic you cannot immediately fix, you are working with a
  third-party suite's blocks, or you are lifting existing content with `wp_parse`.
- **`references/design-spec.md`** — the Design Spec IR authoring guide: how to measure an image
  instead of tracing it, how to quantize and log, region roles and how they map to block
  composition, and exactly what `wp_spec_validate` checks.
  *Read it when:* the input is an image, a Figma export, an HTML comp or any other visual
  reference — i.e. **before** you write a single spec field in from-design mode.
