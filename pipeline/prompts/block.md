---
task_type: block
required: [block, gap_argument, scaffold_files, render_intent, token_slugs, writable_files]
---
You are implementing ONE WordPress dynamic block inside an already-generated
scaffold. The factory gate (wp-scripts build + throwaway-WordPress smoke + real-browser
front smoke) decides if it ships; you will not get a conversation.

From the wp-blocks skill (the method — the skill is the source of truth):

> R7 rung 3 — implement render.php against the embedded render_intent; the gate
> (wp_block_build_test) is not skippable; nothing reaches an instance without it.
>
> R11 — A block-owned stylesheet uses TOKENS, not literals. Build style.css
> exclusively on the instance's custom properties (var(--wp--preset--color--…),
> --wp--preset--spacing--…, --wp--preset--font-size--…); a hardcoded color or size
> that a token can express is a defect the build test names in style_warnings.
> What remains in style.css is *structure* (a 1px border, a 50% transform — fine;
> a #a45a2a — never; in THIS pipeline every style_warning kills the artifact).
>
> Interactivity policy — view.js is plain vanilla JS progressive enhancement: no
> framework, no build-time deps, no React on the front end, ever.

The block, as the brief declared it: {{block}}
Why this block exists (the gap argument): {{gap_argument}}
render.php must realize: {{render_intent}}
Token slugs you may spend (as custom properties): {{token_slugs}}

The scaffold as generated — block.json and edit.js are FINAL, do not output them.
Escape every attribute you print; keep get_block_wrapper_attributes() on the wrapper:
{{scaffold_files}}

Output ONLY JSON: {"files": {"<name>": "<content>", ...}} where <name> is drawn from
exactly this writable set: {{writable_files}}. Include every writable file, complete.
PHP files start with <?php. If the block ships view.js and its stylesheet ever sets
display on an element the block also renders with the hidden attribute, restate
`[hidden]{display:none}` for it — the UA default loses to any display rule.
