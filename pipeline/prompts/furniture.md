---
task_type: furniture
required: [part, part_note, identity, art_direction, voice, palette, nav_items, footer_intent, footer_items, band_colors, manifest_slice, token_slugs, epoch]
---
You are designing ONE site template part — the {{part}} — as TreeIR JSON. It bookends
EVERY page: it is the first or the last thing every visitor sees, and it must read as
designed by the same hand as the sections between. Code decides whether it ships;
there is no conversation.

From the wp-blocks skill (the method — the skill is the source of truth):

> R1 — NEVER hand-write serialized block markup ('<!-- wp:'). A tree is
> {version: 1, epoch, blocks: [...]}, and a BlockNode is {name, attributes?,
> innerBlocks?} — nothing else.
>
> R2 — The available blocks and attributes are whatever the manifest returns at the
> current fingerprint. Never assume a block exists; never use attributes not in the
> manifest entry. When your memory and the manifest disagree, the manifest is correct.
>
> R4 — Style through the instance's styling mechanisms, in order: (1) block supports —
> preset attributes backgroundColor, textColor, fontSize, spacing presets, layout,
> align; (2) global styles / tokens. Raw inline CSS and hand-rolled class-plus-
> stylesheet styling are forbidden at every level.

{{part_note}}

Design values live in the applied tokens, never in your tree: NO hex colours anywhere,
and no px/rem font sizes or spacing values under `style` — spend palette slugs, the
`fontSize` slug attribute, and `var:preset|spacing|NN`. Mechanics the token system
cannot express are fine as literals: letter-spacing (`em`), hairline border widths,
border radii.

Site identity: {{identity}}
Art direction (every decision serves it): {{art_direction}}
Voice: {{voice}}
The brief's palette, roles included: {{palette}}

The site's pages (the header's navigation links are injected at publish from EXACTLY
these; the footer links to them through its own items): {{nav_items}}

**The brief's footer intent** — when you are designing the footer, this is your design
brief; follow it the way a section call follows its section brief:
{{footer_intent}}
Footer page links (href="/<page_slug>/" only): {{footer_items}}

Band colours for this part — the resolved slugs to spend, not your own reading of the
palette: {{band_colors}}

BAND DISCIPLINE (non-negotiable): your root node is ONE core/group with attributes
{"align": "full", "backgroundColor": "<band background slug>", "textColor":
"<band text slug>", "layout": {"type": "constrained"}} and vertical padding from the
spacing presets. Without "align": "full" the root layout clamps the part to the
theme's contentSize and it ships as a narrow strip in the content column — a real
header once rendered at 645px of a 1440px viewport this way. The clamp is
`.is-layout-constrained > *` CSS that nothing in a stylesheet outranks: width lives
in these attributes, and a gate rejects a root that is not a full band. Inner
content that must span the whole band (a header row with the brand left and the
navigation right) carries "align": "wide".

THE SEAM: WordPress inserts a default margin (--wp--style--block-gap, 24px even
when no theme declares it) between the header part, the page content, and the
footer part. Your band owns its vertical rhythm through its OWN padding — design
the part as if it butts flush against the page, and never add margins to
compensate for a seam that belongs to the theme.

Your block vocabulary (manifest slice, with attribute schemas — use NOTHING outside
it, and no attributes absent from it): {{manifest_slice}}

Design tokens available — spend ONLY these slugs; each palette entry carries its hex
and tone so colour choices are CHECKED, never guessed from a slug's name (base and
contrast may be inverted from the WordPress default): {{token_slugs}}
Any textColor you set must read at 4.5:1 against the background it actually sits on;
the band pair below is measured and always safe. And never set the flat borderColor
attribute alongside a per-side style.border — WordPress paints the undeclared sides
at the browser's 3px default.

Respond with ONLY the TreeIR JSON: {"version": 1, "epoch": "{{epoch}}", "blocks": [ … ]}
with the single full-band root core/group specified above carrying the part.
