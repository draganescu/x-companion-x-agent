# Design Spec IR — the authoring guide for lifting a design

You have an image, a Figma export, or an HTML comp. You want a WordPress page. Do not start
writing blocks directly from the image.

**DesignSpecIR is the pivot type.** You lift the binary into it once, `wp_spec_validate` checks
it, and from that point on from-design uses exactly the same back half as from-prompt: tree →
validate → compile → verify. The spec is also what `wp_verify` diffs against, which turns
"looks about right" into a list of specific, attributable numbers.

Schema: `x-agent/schemas/design-spec.schema.json` (vendored from `contract/schemas/`).
Every object in it is `additionalProperties: false` — an unexpected key is an error, not a hint.
The companion never sees this type; it is agent-side only.

---

## 1. Measure, do not trace

Tracing means reproducing what you see. Measuring means recording what is there and then deciding
what it *means*. The difference matters as soon as someone changes a token.

**Trace** (wrong): "the heading is 54px Playfair, dark grey, 120px from the left, and the button
is #1b4ed4 with 14px 28px padding."

**Measure** (right): "the headline occupies box (120,144,600,96) inside a hero region whose outer
padding measures 70px; it is the largest type on the page, so it is the top step of the type
scale; the button color is the page's primary."

Concretely, for each region, in **source pixels of the source viewport**:

1. **Box** — `{x, y, w, h}`, absolute in the source image, not relative to the parent. A child's
   box must sit inside its parent's box; that is checked.
2. **Layout** — `direction` (`row` | `column` | `grid`), `gap_px` measured between siblings,
   `align`, `justify`, `columns`. Measure the gap between two adjacent items, not the distance
   between their text.
3. **Role** — what the region *is*, from the fixed set of values in §4. This is the field that drives
   block choice.
4. **Style refs** — which *token slugs* this region uses: `palette_slug`,
   `background_palette_slug`, `font_size_slug`, `spacing_slugs`. Slugs, not values. The values
   live once, in `tokens_candidates`.

And separately, a flat **content inventory**: every piece of text or media, with its `kind`
(`heading` | `paragraph` | `image` | `button` | `list` | `other`), its text or `image_ref`, and
the `region_id` it belongs to. Keeping content flat and pointing at regions — rather than nesting
it inside them — is what makes it checkable: every item must resolve to a real region.

Three rules that save rework:

- **Do not invent structure you cannot see.** If two things are side by side, that is a row. That
  they are "a card component" is an interpretation; put it in the role, not in extra regions.
- **Do not record what you did not measure.** A guessed value that looks precise is worse than an
  honest snap, because nobody knows to question it.
- **The source viewport is part of the observation.** `source.viewport` is the width the design
  was drawn at. Every box is in that coordinate space, and `wp_verify` measures at whatever
  viewport you give it — usually the same one.

---

## 2. Quantize everything, and log every delta

A design contains dozens of near-identical values: 46px, 48px, 47px of padding; #1b4ed4 and
#1a4fd6; 15px and 16px of body text. Those differences are drawing noise, screenshot
antialiasing, and human hands. Carrying them into a token system produces a system that is really
a list of accidents.

So: **snap every observed value onto a scale, and record the snap.**

```jsonc
"quantization_log": [
  { "observed": "#1b4ed4", "snapped_to": "#1a4fd6", "delta": "dE 0.9", "note": "brand blue" },
  { "observed": "46px",    "snapped_to": "3rem",    "delta": "+2px" },
  { "observed": "54px",    "snapped_to": "3.5rem",  "delta": "+2px",
    "note": "hero headline; the single deliberate fidelity delta" },
  { "observed": "716px",   "snapped_to": "720px",   "delta": "+4px", "note": "measured text column" }
]
```

- `observed` — string or number, what you actually measured.
- `snapped_to` — **string, and it must be byte-identical to the token value you wrote**. This is
  how the checker links them.
- `delta` — string or number. Be honest and be specific: `"+2px"`, `"dE 0.9"`,
  `"-2/255 on each channel"`. `"small"` is not a delta.
- `note` — optional, and the most valuable field in the file. This is where you say *why*.

**What must be in the log.** `wp_spec_validate` walks these concrete values and demands a
`quantization_log` entry whose `snapped_to` equals each one, as a string:

| value | pointer |
|---|---|
| every palette color | `/tokens_candidates/palette/<i>/color` |
| every spacing step size | `/tokens_candidates/spacing/steps/<i>/size` |
| every typography size | `/tokens_candidates/typography/sizes/<i>/size` |
| the content width | `/tokens_candidates/layout/contentSize` |
| the wide width | `/tokens_candidates/layout/wideSize` |

**Font families are deliberately excluded.** A typeface is a chosen identifier, not a measurement
snapped onto a scale, so requiring a log entry for it would be noise.

**Aim for a small scale.** Four to six palette entries, four to seven spacing steps, three to five
type sizes. If your lift produces eleven spacing steps, you traced instead of measuring: two of
them are the same step observed twice.

**The log records every fidelity decision.** When `wp_verify` later reports a `font_size` diff of +2px, you
do not argue about it — you point at the log entry, state the alternative (a bespoke type step
that exists for one headline), and record the decision. That exchange is the entire point of
from-design mode. See `SKILL.md` §4 for it written out.

---

## 3. Mark every synthesized responsive behavior

A single static image contains **zero** information about what happens at 600px wide. Whatever you
write about breakpoints is inference. So say so:

```jsonc
"responsive_assumptions": [
  { "breakpoint": "<=781px",  "change": "the two columns stack; media follows copy",
    "confidence": "synthesized" },
  { "breakpoint": "<=1200px", "change": "outer padding drops from spacing 60 to spacing 50",
    "confidence": "synthesized" }
]
```

`confidence` is `"observed"` **only** when the source actually shows it — a Figma file with a
mobile frame, a second screenshot at a narrow width, a comp with declared breakpoints. Everything
else is `"synthesized"`.

**These are the human-vetoable items.** A reviewer cannot veto an assumption you did not write
down, and cannot tell an inference from an observation unless you label it. Marking your own
guesses is not a formality; it is the only mechanism by which someone else's judgement can enter
the build.

Write assumptions in terms the implementation can honour: "the two columns stack" maps to
`core/columns` with `isStackedOnMobile: true`; "padding drops one step" maps to a different
spacing preset. "Becomes mobile-friendly" maps to nothing concrete.

`wp_spec_validate` requires at least one entry on **each top-level region** (`W_NO_RESPONSIVE`).
Nested regions inherit their parent's behavior unless they do something different, in which case
say what.

---

## 4. Region roles, and what they become

`role` takes one of a fixed set of values. It is the field that carries your interpretation of the design
into block choice, so pick deliberately.

| role | what it means | typical block composition |
|---|---|---|
| `header` | site header / masthead | `core/group` (`tagName: "header"`, `align: "full"`) with a flex layout; often a registered theme pattern |
| `hero` | the first, dominant band | full-width `core/group`, `layout.type: "constrained"`, preset padding; `core/cover` **only** when a background image genuinely sits behind text |
| `features` | a repeated set of equivalent items | `core/columns` + N × `core/column`, or a `core/group` with `layout.type: "grid"` |
| `gallery` | a grid of images | `core/gallery` |
| `testimonial` | quote + attribution | `core/quote` inside `core/media-text`; if it carries structured data (a rating, a logo) that no core block models, that is R7 |
| `cta` | a call-to-action band | full-width `core/group` with `backgroundColor` + `core/heading` + `core/buttons` |
| `footer` | site footer | `core/group` (`tagName: "footer"`), usually a theme pattern |
| `section` | a generic band with no stronger role | `core/group`, `align: "full"`, `layout.type: "constrained"` |
| `column` | one track inside a row | `core/column` (only inside `core/columns`) |
| `item` | a leaf: one card, one button row, one media slot | whatever the content needs; often no wrapper at all |

Mapping principles:

- **A region is not always a block.** An `item` holding a single image is just `core/image`; do not
  wrap it in a `core/group` because the spec has a box for it. Extra wrappers change geometry and
  will show up as diffs.
- **`layout.direction` chooses the layout type,** not a class name. `row` → `core/columns`, or
  `core/group` with `layout.type: "flex"`. `column` → `layout.type: "constrained"` (the default
  stacking). `grid` → `layout.type: "grid"` with `columnCount`.
- **`gap_px` becomes a `blockGap` preset**, snapped to the nearest spacing step — and that snap
  goes in the log like any other.
- **`style_refs` are slugs, and they must be slugs that exist** in `tokens_candidates` (and,
  after `wp_tokens_apply`, on the instance). A `style_refs.palette_slug` naming a color you never
  defined is a lift that has not finished.
- **Roles survive into `wp_verify`.** Region-to-element matching uses role heuristics plus order
  plus accessibility name. Honest roles produce clean diffs; a `hero` that is really a footer
  produces `missing`/`extra` noise.

---

## 5. What `wp_spec_validate` checks

Fully local: no network, no config, no instance. Run it before you generate a single tree — that
is R6, and it is cheap.

`valid` is `true` iff there are **zero `E_*` diagnostics**. Warnings do not block, and you should
still clear them.

### `E_SPEC_SCHEMA` — the body fails the schema. **Stops every other check.**

You get schema errors and nothing else, so fix these first.

```
E_SPEC_SCHEMA  /regions/0/role
  Invalid option: expected one of "header"|"hero"|"features"|"gallery"|"testimonial"|"cta"|"footer"|"section"|"column"|"item"
  fix: Fix the spec against schemas/design-spec.schema.json. Every object in the spec is
       additionalProperties:false — an unexpected key is an error, not a hint.
```

Most common causes: a role outside the allowed set; an extra key you invented (`"description"`,
`"notes"`, `"z_index"`); `version` sent as `"1"` instead of `1`; a `box` missing one of
`x`/`y`/`w`/`h`; a `quantization_log` entry missing `delta`; `confidence` spelled anything other
than `observed` / `synthesized`.

**Satisfy it by:** reading the vendored schema rather than guessing. Required top-level keys are
exactly `version`, `source`, `tokens_candidates`, `content`, `regions` — all five, always.

### `E_BOX_OVERLAP` — a child region escapes its parent's box

Slack is **2% of the parent's width** (for left/right) and **2% of the parent's height** (for
top/bottom), applied outward on all four edges. One diagnostic per offending child, listing every
breached edge.

```
E_BOX_OVERLAP  /regions/0/children/1/box
  Region "hero-media" escapes its parent "hero" (2% slack applied): right 1652 > 1468.8.
  fix: Re-measure the child box in source pixels; a child box must sit inside its parent box.
       Nested regions are geometry, not z-order.
```

**Satisfy it by:** remembering that boxes are **absolute in the source image**, not relative to
the parent. Writing `x: 120` when you meant "120 from the parent's left edge" is the usual cause.
If a child genuinely overhangs its parent — a deliberately overlapping card — then the parent's
box is wrong: widen it to contain what it contains, and record the overlap as the child's
position within it.

### `E_ORPHAN_CONTENT` — a content item points at a region that does not exist

```
E_ORPHAN_CONTENT  /content/3/region_id
  Content item "c-cta" points at region "hero-buttons", which does not exist in regions[].
  fix: Every content item must live in a measured region. Add the region or repoint region_id
       at an existing region id.
```

Region ids are matched across the **whole recursive tree**, not just the top level, so nesting is
fine — spelling is not. Usually this means you renamed a region and left a content item behind, or
you inventoried a piece of text whose region you never measured. Both are real problems: content
with no region has no geometry, so `wp_verify` can never check it.

**Satisfy it by:** writing the regions first and the content inventory second, and keeping ids in
one naming scheme (`hero`, `hero-copy`, `hero-actions`, `hero-media`).

### `W_UNQUANTIZED` — a token value has no quantization entry

```
W_UNQUANTIZED  /tokens_candidates/typography/sizes/2/size
  font size "xx-large" value "3.5rem" has no quantization_log entry (no entry snapped_to === "3.5rem").
  fix: Every token value must be a deliberate snap of an observed measurement. Add
       {observed, snapped_to, delta} to tokens_candidates.quantization_log so the delta is reviewable.
```

The comparison is **string equality on `snapped_to`**. `"3.5rem"` does not match `"56px"`, and
`"#FFFFFF"` does not match `"#ffffff"`. Write the token value and the `snapped_to` value with the
same bytes.

**Satisfy it by:** adding the entry, not by deleting the token. A warning here means one of your
token values arrived from nowhere — which is precisely the thing this spec type exists to prevent.
If a value really is a free choice rather than a measurement, say so in `note` and log the delta
as `0`.

### `W_NO_RESPONSIVE` — a top-level region declares no responsive assumptions

```
W_NO_RESPONSIVE  /regions/0
  Top-level region "hero" declares no responsive_assumptions.
  fix: State at least one breakpoint behavior per top-level region. Mark anything you did not
       observe in the source with confidence:"synthesized" so a human can veto it.
```

Checked on **top-level regions only**. Children may inherit silently.

**Satisfy it by:** §3. One honest synthesized assumption beats an empty array, and an empty array
means you have decided the responsive behavior by accident.

---

## 6. A complete, valid spec

This is `x-agent/fixtures/specs/hero-sample.json`, which validates clean
(`{"valid": true, "diagnostics": []}`). Read it as a shape, not as content to copy.

```jsonc
{
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
      { "slug": "30", "size": "1rem" },   { "slug": "40", "size": "1.5rem" },
      { "slug": "50", "size": "3rem" },   { "slug": "60", "size": "4.5rem" } ] },
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
      { "observed": "#131313", "snapped_to": "#111111", "delta": "-2/255 on each channel" },
      { "observed": "#1b4ed4", "snapped_to": "#1a4fd6", "delta": "dE 0.9", "note": "brand blue" },
      { "observed": "#f6b200", "snapped_to": "#f5b301", "delta": "dE 0.7" },
      { "observed": "15px",   "snapped_to": "1rem",   "delta": "+1px" },
      { "observed": "25px",   "snapped_to": "1.5rem", "delta": "-1px" },
      { "observed": "46px",   "snapped_to": "3rem",   "delta": "+2px" },
      { "observed": "70px",   "snapped_to": "4.5rem", "delta": "+2px" },
      { "observed": "16.2px", "snapped_to": "1rem",   "delta": "-0.2px", "note": "body copy" },
      { "observed": "23px",   "snapped_to": "1.5rem", "delta": "+1px",   "note": "lede" },
      { "observed": "54px",   "snapped_to": "3.5rem", "delta": "+2px",
        "note": "hero headline; the single deliberate fidelity delta" },
      { "observed": "716px",  "snapped_to": "720px",  "delta": "+4px", "note": "measured text column" },
      { "observed": "1196px", "snapped_to": "1200px", "delta": "+4px" } ] },

  "content": [
    { "id": "c-eyebrow",  "kind": "other",     "text": "New in 2026", "region_id": "hero-copy" },
    { "id": "c-headline", "kind": "heading",   "text": "Ship the layout, not the guesswork.",
      "region_id": "hero-copy" },
    { "id": "c-lede",     "kind": "paragraph",
      "text": "Generate trees, compile them in the real editor, verify the geometry numerically.",
      "region_id": "hero-copy" },
    { "id": "c-cta",      "kind": "button",    "text": "Start building",     "region_id": "hero-actions" },
    { "id": "c-cta-alt",  "kind": "button",    "text": "Read the contract",  "region_id": "hero-actions" },
    { "id": "c-shot",     "kind": "image",
      "image_ref": "fixtures/images/hero-sample.png#media", "region_id": "hero-media" } ],

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
          "style_refs": { "background_palette_slug": "accent" } } ] } ]
}
```

Why it is clean, check by check: all thirteen concrete token values appear as a `snapped_to`
(no `W_UNQUANTIZED`); the single top-level region declares two assumptions (no `W_NO_RESPONSIVE`);
`hero-copy` (120…720 × 144…576) and `hero-media` (768…1320 × 120…600) both sit inside
`hero` (0…1440 × 0…720), and `hero-actions` sits inside `hero-copy` (no `E_BOX_OVERLAP`); all six
content items point at `hero-copy`, `hero-actions` or `hero-media` (no `E_ORPHAN_CONTENT`).

---

## 7. From spec to page

1. `wp_spec_validate` → `valid: true`. Fix warnings too.
2. `wp_tokens_apply({..., dry_run: true})` to see the compiled `theme.json` and the diff against
   the instance's current tokens; then for real, toolchain posture only. **Adopt the returned
   fingerprint** (R3, R9).
3. Walk `regions` depth-first, turning each into blocks per §4. Place `content` items into the
   blocks of their `region_id`.
4. `wp_validate` → `wp_compile`, exactly as in from-prompt mode.
5. `wp_verify` with `spec` and the source viewport. Use `spec_region_id` to focus one subtree when
   you are iterating on one band.
6. For every diff with `within_tolerance: false`, say which of three it is:
   - **a token decision** — it is in `quantization_log`; quote the entry, state the alternative,
     record the choice;
   - **a mapping approximation** — the region-to-block mapping is close but not exact (an extra
     wrapper, a `blockGap` that snapped one step); fix the tree;
   - **a gap in the available blocks** — the design needs something the block set cannot
     express; go to R7, and say which option.
7. One `wp_screenshot`.

Default tolerances: position and size 4px or 2%, gap one spacing step, font size 1px. They are
overridable per call via `tolerances`, but widening a tolerance to make a report pass — without
saying that you did — is misreporting the result. Change it only as an accepted policy, and say
so.
