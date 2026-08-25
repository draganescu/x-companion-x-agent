---
task_type: tree
required: [section, page, art_direction, voice, page_plan, design, band_colors, manifest_slice, pattern_tree, token_slugs, epoch, image_note, heading_rule]
---
You are generating ONE section of a WordPress page as TreeIR JSON. Code decides
whether it ships; there is no conversation. The section must look like it belongs
to the same designed page as every other section — the page plan below is the
shared design language; do not improvise outside it.

From the wp-blocks skill (the method — the skill is the source of truth):

> R1 — NEVER hand-write serialized block markup ('<!-- wp:'). A tree is
> {version: 1, epoch, blocks: [...]}, and a BlockNode is {name, attributes?,
> innerBlocks?} — nothing else. innerHTML in a tree is a hard schema error
> (E_TREE_SCHEMA) precisely because it is compiler output appearing in an input.
>
> R2 — The available blocks and attributes are whatever the manifest returns at the
> current fingerprint. Never assume a block exists; never use attributes not in the
> manifest entry. When your memory and the manifest disagree, the manifest is correct.
> (Real example: core/heading no longer declares textAlign; text alignment lives at
> style.typography.textAlign.)
>
> R4 — Style through the instance's styling mechanisms, in order: (1) block supports —
> preset attributes backgroundColor, textColor, fontSize, spacing presets, layout,
> align; (2) global styles / tokens. Raw inline CSS and hand-rolled class-plus-
> stylesheet styling are forbidden at every level.
>
> R5 — retrieve first: adapt the starting pattern's idiom before inventing.
>
> §2 Design quality — a centered stack on a flat band is not a finished design.
> Display-scale type for hero statements; asymmetry (uneven column splits,
> left-aligned heroes); editorial details (uppercase letterspaced kickers); generous,
> deliberate whitespace between bands. EVERY section gets this attention — a section
> below the fold with default alignment and no band treatment is unfinished work.

Site art direction (every decision serves it): {{art_direction}}
Voice: {{voice}}

Page: {{page}}
The page's design plan — every section in order, with its band and layout; YOURS is
the one matching your section id. Respect the rhythm: bands alternate down the page
and only the accent band is loud: {{page_plan}}

Your section brief: {{section}}
Your section's design: {{design}}

BAND DISCIPLINE (non-negotiable): your root node is ONE core/group with
attributes {"align": "full", "backgroundColor": "<band background slug>",
"textColor": "<band text slug>", "layout": {"type": "constrained"}} and vertical
padding from the spacing presets (style.spacing.padding top and bottom, spelled
"var:preset|spacing|<slug>"). Padding is PROPORTIONAL: one large slug top and
bottom, never more — a band's height comes from its CONTENT, and inflating
padding to fake presence produces empty fields, not design.
Your band's colors (chosen by measured contrast — use them): {{band_colors}}
Inner content uses the constrained width; use "wide" on individual inner blocks
where the layout calls for breadth.

CONTENT DENSITY: realize the copy notes FULLY. Notes promising a list (taps,
menu items, hours, features) become an ACTUAL styled list or card grid with 4-6
real entries — invented faithfully in the site's voice, never summarized into
one thin paragraph. A section whose band is mostly empty background is
unfinished work.

IMAGE GEOMETRY: every image is a composition element, never a thumbnail. In a
split or left-aligned layout the image fills its column (core/columns with the
image column at 50-58%, or core/media-text with the image side). A lone hero
image is large (sizeSlug "large", or the band's media half). Gallery images
share one consistent aspectRatio. Set width/aspectRatio deliberately on every
core/image — a default-sized image floating in a band is a defect.

STATEMENT SCALE: hero and cta sections carry one display-scale statement (the
largest font-size slug available) — a cta whose text whispers in a loud band is
a defect.

LAYOUT: realize design.layout, not a default stack —
- "centered": constrained column, display-scale heading, deliberate whitespace.
- "left-aligned": headings and copy ranged left; no auto-centering.
- "split": core/columns with an UNEVEN split (58/42 or 45/55), verticalAlignment set.
- "asymmetric": offset content — an inner group with extra top padding on one column,
  media-text with the media on one side, or staggered card rows.
- "grid": core/columns rows (or the block's own grid) with consistent card treatment —
  every card the same band-aware styling.

Your block vocabulary for this section (manifest slice, with attribute schemas — use
NOTHING outside it, and no attributes absent from it; W_ATTR_UNKNOWN fails the
artifact): {{manifest_slice}}

Starting pattern (adapt its idiom to YOUR band and layout; null means compose fresh):
{{pattern_tree}}

Design tokens available — spend ONLY these slugs (backgroundColor/textColor take
palette slugs; fontSize takes font-size slugs; spacing presets are spelled
"var:preset|spacing|<slug>" inside style.spacing values): {{token_slugs}}

{{image_note}}

Heading discipline (the verifier fails the whole run on a broken outline):
{{heading_rule}}

Output ONLY a TreeIR JSON document: {"version": 1, "epoch": "{{epoch}}", "blocks": [...]}
- blocks[] is THIS SECTION ONLY: exactly one root core/group band as specified above.
- Write real copy from the section brief's copy notes — no lorem ipsum, no placeholders.
- If manifest_slice.declared_custom_block exists, build the section around that block
  name with its declared attributes; it will exist by publish time.
