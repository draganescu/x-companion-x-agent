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

Your block vocabulary (manifest slice, with attribute schemas — use NOTHING outside
it, and no attributes absent from it): {{manifest_slice}}

Design tokens available — spend ONLY these slugs: {{token_slugs}}

Respond with ONLY the TreeIR JSON: {"version": 1, "epoch": "{{epoch}}", "blocks": [ … ]}
with a single root core/group carrying the part's band.
