---
task_type: block
required: [block, gap_argument, scaffold_files, render_intent, token_slugs, writable_files]
---
You are implementing ONE WordPress dynamic block inside an already-generated
scaffold. The factory gate (per-script syntax check + throwaway-WordPress smoke +
real-browser front smoke) decides if it ships; you will not get a conversation.

From the wp-blocks skill (the method — the skill is the source of truth):

> R7 rung 3 — implement render.php against the embedded render_intent; the gate
> (wp_block_build_test) is not skippable; nothing reaches an instance without it.
>
> R11 — A block does not own a colour scheme. Its text INHERITS the band's ink —
> the markup that places the block already guaranteed that pair reads — so
> style.css NEVER sets `color` or `background` on the block root (a gate rejects
> the wholesale repaint). Surfaces — a card, a panel — come from the block's
> colour supports, set on the INSTANCE by the markup that places it, never from
> the stylesheet. What style.css owns is STRUCTURE: layout mechanics, spacing
> spent as --wp--preset--spacing--*, type sizes as --wp--preset--font-size--*,
> hairlines and dividers via currentColor. A hardcoded colour or size that a
> token can express is a defect the build test names in style_warnings (in THIS
> pipeline every hard style_warning kills the artifact).
>
> The FEW colour moments a block legitimately owns — a meter fill, a status dot,
> a rating star: data elements that must be one specific colour — are spent as
> var(--wp--preset--color--<slug>) and chosen by VALUE: every palette entry
> below carries its hex and measured tone. NEVER pick a colour by the sound of
> its slug — on this site "base" may be near-black, and a slug named like ink
> may share its hex with the very band your block lands on (a real block shipped
> invisible exactly this way). The rendered page is measured at the end of the
> run: text under 3:1 against its actual ground fails the whole build.
>
> Interactivity policy — view.js is plain vanilla JS progressive enhancement: no
> framework, no build-time deps, no React on the front end, ever.

The block, as the brief declared it: {{block}}
Why this block exists (the gap argument): {{gap_argument}}
render.php must realize: {{render_intent}}
Design tokens you may spend as custom properties (palette entries carry hex +
tone — the few colours you own are checked against values, never guessed from
names): {{token_slugs}}

The scaffold as generated — block.json and edit.js are FINAL, do not output them.
Escape every attribute you print; keep get_block_wrapper_attributes() on the wrapper:
{{scaffold_files}}

Output ONLY JSON: {"files": {"<name>": "<content>", ...}} where <name> is drawn from
exactly this writable set: {{writable_files}}. Include every writable file, complete.
PHP files start with <?php. If the block ships view.js and its stylesheet ever sets
display on an element the block also renders with the hidden attribute, restate
`[hidden]{display:none}` for it — the UA default loses to any display rule.
