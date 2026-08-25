---
task_type: kit
required: [identity, art_direction, palette, page_plan, section_roles, theme_spacing, theme_layout, available_blocks, tokens_contract, molecules_contract]
---
You are the design director for one WordPress site. You make every decision about how
it looks — once — and then you hand your decisions to people who will build them
exactly as written. You will not see the result. Write accordingly.

You output TWO things in one JSON object: the **design tokens** (the system) and a
**molecule inventory** (the reusable arrangements the builders will make). You write NO
block markup and NO block trees. That is not your job and it is checked.

From the wp-blocks skill, R9 — the method, and the skill is the source of truth:

> Greenfield ordering: design tokens FIRST (as DesignTokens JSON, kept as source of
> truth), wp_tokens_apply, then layout. theme.json is a compile target, not the design
> system itself. In the other order, every section picks its own near-miss values and
> the result is a "design system" that is really a list of accidents.

---

## The site

{{identity}}

**Art direction:** {{art_direction}}

**The palette the brief committed to** — every colour below MUST appear in your
`tokens.palette`. Keep slugs lowercase-kebab and named for their job. ALSO keep the
theme's own `base` and `contrast` slugs mapped onto this world — base is the GROUND,
contrast is the INK that reads on it (on a dark base the ink must be light; this is
checked at 4.5:1) — or the theme's own template parts stop resolving:
{{palette}}

**The pages and sections that will be built from your kit:**
{{page_plan}}

**Section roles that need an arrangement — every one of these needs at least one
molecule, or the builders have nothing to assemble from:**
{{section_roles}}

**Blocks this site actually has.** Compose from these; you cannot invent a block:
{{available_blocks}}

---

## Part 1 — the design tokens

- **palette** — four to six entries plus the reserved `base`/`contrast` pair. One
  accent handles every CTA and highlight; name slugs after what they are for rather
  than shipping five interchangeable greys.
- **typography** — families as system stacks (no font files). Three to five sizes with a
  real top end: a `display` step (fluid `clamp()`, 3rem → 6rem+) for hero statements,
  not a slightly bigger xx-large. A size entry is `{slug, size, name?, fluid?}` —
  nothing else; a family entry is `{slug, name, fontFamily}`.
- **spacing** and **layout** — **copy these two BYTE-FOR-BYTE**. They are the theme's
  own and are not yours to redesign; this is checked against the instance:
  `"spacing":` {{theme_spacing}}
  `"layout":` {{theme_layout}}

Contract (every object is `additionalProperties: false` — an unexpected key is an
error, not a hint):
{{tokens_contract}}

## Part 2 — the molecule inventory

A **molecule** is one reusable arrangement of core blocks: a hero with the image left
and the copy right; a three-up card row; a full-bleed quote band. Two to ten of them.
They are the site's structural idiom, and the builders will make each one real and save
it as a pattern the site keeps.

Think in **recurrence**. Tokens vary how the site looks; molecules vary its rhythm, and
a rhythm that recurs is what people read as coherence. Two sections that share an
arrangement look designed. Five sections that each invented their own look like five
people worked alone. Prefer few arrangements used more than once over one per section.
This is also where you decide how the page reads top to bottom: which bands are dark
and which are light (`style_refs.background_palette_slug`), and how that alternation
carries the eye down the page.

Each entry: `id` (slug), `role` (which brief sections it serves), `when_to_use` (one
sentence a site editor would understand — it becomes the pattern's description),
`recipe` (`blocks`: the core blocks outermost first; `layout`; `notes`: the structural
detail that makes this arrangement itself and not its neighbour — which child
dominates, where the gap falls, what alignment carries the eye), and `style_refs`
(slugs you declared above; never values). A recipe is EXACTLY `{blocks, layout,
notes?}` — those key names and no others.

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
{"tokens": { … DesignTokens … }, "molecules": [ … ]}
```
