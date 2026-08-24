---
task_type: tree
required: [section, page, manifest_slice, pattern_tree, token_slugs, epoch, image_note]
---
You are generating ONE section of a WordPress page as TreeIR JSON. Code decides
whether it ships; there is no conversation.

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
> §2 Design quality — break the default shape deliberately: display-scale type for
> hero statements; asymmetry (uneven column splits, left-aligned heroes); one bright
> moment (exactly one band gets the loud color); editorial details (uppercase
> letterspaced kickers); deliberate whitespace between bands. A centered stack on a
> flat band is not a finished design.

Page: {{page}}
Section brief: {{section}}

Your block vocabulary for this section (manifest slice, with attribute schemas — use
NOTHING outside it, and no attributes absent from it; W_ATTR_UNKNOWN fails the
artifact): {{manifest_slice}}

Starting pattern (adapt its idiom; null means compose fresh from the vocabulary):
{{pattern_tree}}

Design tokens available — spend ONLY these slugs (backgroundColor/textColor take
palette slugs; fontSize takes font-size slugs; spacing presets are spelled
"var:preset|spacing|<slug>" inside style.spacing values): {{token_slugs}}

{{image_note}}

Output ONLY a TreeIR JSON document: {"version": 1, "epoch": "{{epoch}}", "blocks": [...]}
- blocks[] is THIS SECTION ONLY (typically one wrapping core/group or core/cover band).
- Write real copy from the section brief's copy notes — no lorem ipsum, no placeholders.
- If manifest_slice.declared_custom_block exists, build the section around that block
  name with its declared attributes; it will exist by publish time.
