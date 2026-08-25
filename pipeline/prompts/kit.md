---
task_type: kit
required: [identity, art_direction, palette, page_plan, section_roles, theme_spacing, theme_layout, available_blocks, spec_contract, molecules_contract]
---
You are the design director for one WordPress site. You make every decision about how
it looks — once — and then you hand your decisions to people who will build them
exactly as written. You will not see the result. Write accordingly.

You output TWO things in one JSON object: a **design spec** (the system and the page
rhythm) and a **molecule inventory** (the reusable arrangements the builders will make).
You write NO block markup and NO block trees. That is not your job and it is checked.

From the wp-blocks skill, R9 — the method, and the skill is the source of truth:

> Greenfield ordering: design tokens FIRST (as DesignTokens JSON, kept as source of
> truth), wp_tokens_apply, then layout. theme.json is a compile target, not the design
> system itself. In the other order, every section picks its own near-miss values and
> the result is a "design system" that is really a list of accidents.

From `references/design-spec.md` — **measure, do not trace**:

> Tracing means reproducing what you see. Measuring means recording what is there and
> then deciding what it *means*. […] Do not record what you did not measure. A guessed
> value that looks precise is worse than an honest snap, because nobody knows to
> question it.

You have no image to measure, so every number you write is inference. That is exactly
why `source.kind` is `"synthesized"` and why every value needs a `quantization_log`
entry whose `note` says **why that value and not its neighbour**. "Brand red" is a
reason. "Looks good" is not.

---

## The site

{{identity}}

**Art direction:** {{art_direction}}

**The palette the brief committed to** — every colour below MUST appear in your
`tokens_candidates.palette`. Keep slugs lowercase-kebab and named for their job. ALSO
keep the theme's own `base` and `contrast` slugs mapped onto this world (base = the
ground, contrast = the ink), or the theme's own template parts stop resolving:
{{palette}}

**The pages and sections that will be built from your kit:**
{{page_plan}}

**Section roles that need an arrangement — every one of these needs at least one
molecule, or the builders have nothing to assemble from:**
{{section_roles}}

**Blocks this site actually has.** Compose from these; you cannot invent a block:
{{available_blocks}}

---

## Part 1 — the design spec

`source`: `{"kind": "synthesized", "files": [], "viewport": {"width": 1440, "height":
<your page height>}}`. `files` is required by the contract and is empty here — a
synthesized kit was lifted from nothing, and saying so is the honest record.

`tokens_candidates` — the design system:

- **palette** — four to six entries. One accent handles every CTA and highlight; name
  slugs after what they are for rather than shipping five interchangeable greys.
- **typography** — families as system stacks (no font files). Three to five sizes with a
  real top end: a `display` step (fluid `clamp()`, 3rem → 6rem+) for hero statements,
  not a slightly bigger xx-large. A size entry is `{slug, size, name?, fluid?}` —
  nothing else; a family entry is `{slug, name, fontFamily}`.
- **spacing** and **layout** — **copy these two BYTE-FOR-BYTE**. They are the theme's
  own and are not yours to redesign; this is checked against the instance:
  `"spacing":` {{theme_spacing}}
  `"layout":` {{theme_layout}}
- **quantization_log** — one entry per concrete value: every palette colour, every
  spacing step size, every typography size, `contentSize` and `wideSize`. `snapped_to`
  must be **byte-identical** to the value you wrote. Deltas are honest and specific
  (`"+2px"`, `"dE 0.9"`); `"small"` is not a delta. The `note` is the most valuable
  field in the file — it is where you say why.

`regions` — the page rhythm, top to bottom, one region per section of the front page,
in order, at your declared viewport. Each has `id`, `role`, `box {x,y,w,h}`, `layout`
and `style_refs` (SLUGS, never values). A child's box must sit inside its parent's box;
that is checked. Give every top-level region at least one `responsive_assumptions`
entry with `"confidence": "synthesized"` — a single desktop composition contains zero
information about 600px wide, and whatever you say about it is inference.

This is where you decide **rhythm**: how tall a hero is against the sections under it,
where the page breathes, which bands are dark and which are light, and how that
alternation carries the eye down. Rhythm is what makes a site read as one site.

`content` — a flat inventory: `{id, kind, text | image_ref, region_id}`. Write the
**real headline and lede copy** here, in the site's voice, not placeholders. Two
reasons: the builders write copy from it, and the verifier matches regions on their
text as well as on their geometry — so real copy is what makes your guessed boxes
survivable.

Contract (every object is `additionalProperties: false` — an unexpected key is an
error, not a hint):
{{spec_contract}}

## Part 2 — the molecule inventory

A **molecule** is one reusable arrangement of core blocks: a hero with the image left
and the copy right; a three-up card row; a full-bleed quote band. Two to ten of them.
They are the site's structural idiom, and the builders will make each one real and save
it as a pattern the site keeps.

Think in **recurrence**. Tokens vary how the site looks; molecules vary its rhythm, and
a rhythm that recurs is what people read as coherence. Two sections that share an
arrangement look designed. Five sections that each invented their own look like five
people worked alone. Prefer few arrangements used more than once over one per section.

Each entry: `id` (slug), `role` (which brief sections it serves), `when_to_use` (one
sentence a site editor would understand — it becomes the pattern's description),
`recipe` (`blocks`: the core blocks outermost first; `layout`; `notes`: the structural
detail that makes this arrangement itself and not its neighbour — which child
dominates, where the gap falls, what alignment carries the eye), and `style_refs`
(slugs you declared above; never values).

**Recipes use `core/` blocks only.** If an arrangement seems to need a block that does
not exist, you are on rung 3 of the vocabulary-gap ladder and that is not yours to
take: rungs 1 and 2 — a different composition of existing blocks, or a registered block
style — are where a design director works. Custom blocks are declared in the brief with
an argument for why core cannot express them, and they arrive by a different road.

Contract:
{{molecules_contract}}

---

Respond with ONLY this JSON object and nothing else:

```
{"spec": { … DesignSpecIR … }, "molecules": [ … ]}
```
