# Moulin Rouge — a full site built with the toolchain, unmodified

A single-page tourism landing site for the Moulin Rouge in Paris, built end to end
with this repo's tools exactly as they ship. It exists to convert paid social
traffic into newsletter signups: an inline form waits at scroll end, and a
back-button exit modal asks once on the way out. Every signup lands as a pending
`mr_subscriber` record in wp-admin, tagged with which form captured it
(`inline` / `exit_modal`).

Everything here is **source**, not output: block packages and the schema package
go through their build-test gates, trees compile through the instance's own
`save()` functions. Nothing in this directory is hand-written block markup.

## What's in here

- `trees/tokens.json` — the design system (palette nuit/rouge/gold/velvet/poudre,
  Didot/Boulevard + Futura/Affiche stacks, fluid `display` size). Apply with
  `wp_tokens_apply`; spacing and layout are Twenty Twenty-Five's own, passed
  through verbatim so the theme's template parts keep resolving.
- `schema/` — the `agent-schema-newsletter` package: `mr_subscriber` CPT with
  REST-visible `email` / `signup_source` meta, and a nonce+honeypot-guarded
  `POST /agent-newsletter/v1/subscribe`. A nonce'd call without an email is a
  200 ping (the build-test probe sends none); real submissions are validated,
  deduplicated, and stored `pending`.
- `blocks/` — four dynamic blocks (`agent/…`), each with a ServerSideRender
  canvas and inspector-only settings:
  - `moulin-sails` — full-screen hero; CSS-keyframe windmill rotor
    (`transform-box: fill-box`), reduced-motion aware.
  - `gaslight-marquee` — infinite ribbon; duplicated row, `translateX(-50%)`,
    pauses on hover.
  - `cancan-stats` — count-up numbers via IntersectionObserver; final values
    are server-rendered so the block is correct without JS.
  - `newsletter-capture` — one block, two modes. `inline`: a signup card whose
    form is a real POST (works without JS), upgraded to fetch-in-place.
    `exit`: the same card in a native `<dialog>`; a history sentinel is pushed
    on load, popstate opens the dialog once per session, and decline / Escape /
    a finished signup all really leave via `history.back()`.
- `trees/page-tree.json` — the page as TreeIR (hero, ribbon, two asymmetric
  story sections, stats band, secrets cards, pullquote, inline capture, exit
  capture). `nav-tree.json` and `footer-tree.json` replace the theme's demo
  header links and footer part.
- `tests/test-behavior.mjs` — the Playwright proof: inline signup, exit dialog
  on Back, decline-really-leaves, signup-then-leave, session re-arm guard,
  count-up completion.
- `rebrand-zip.py` — rewrites ONLY the plugin-header comment inside a gated
  block zip (Plugin Name "Moulin Rouge — …", wp.org-style description,
  `Update URI: false`). Needed because the factory hardcodes toolchain-facing
  headers in the loader it generates at zip time; the schema package needs no
  such step — its header is source, in `schema/newsletter.php`.

## Rebuild from scratch

```sh
node tools/playground/boot.mjs --profile core-only --posture toolchain --port 9400 --plugin ./x-companion
jq '{url, user: .admin.user, app_password: .admin.app_password}' \
    tools/.runtime/core-only-toolchain.json > .x-agent.json
node tools/mcp-bridge.mjs --port 9490   # HTTP POST /call {tool, args}
```

Then, in order (each install returns a new fingerprint — use it in the next tree):

1. `wp_tokens_apply` ← `trees/tokens.json`
2. `wp_schema_build_test` on `schema/` → `wp_schema_install`
3. per block: `wp_block_build_test` → `rebrand-zip.py` on the gated zip →
   `wp_block_install`
4. `wp_placeholder` for `gold` and `poudre`; patch the two image `id`/`url`
   values in `page-tree.json` to the returned attachments
5. `wp_validate` + `wp_compile` ← `page-tree.json` (with the current epoch) →
   `POST /wp/v2/pages` `{status: publish, template: "page-no-title"}` →
   `POST /wp/v2/settings` `{show_on_front: page, page_on_front: <id>}`
6. compile `nav-tree.json`, strip the wrapper delimiters (`sed '1d;$d'`),
   `POST /wp/v2/navigation/<id>`; compile `footer-tree.json`,
   `POST /wp/v2/template-parts/twentytwentyfive%2F%2Ffooter`
7. `node sites/moulin-rouge/tests/test-behavior.mjs` — all ten checks must pass

The two story images are minted 1×1 placeholders stretched by attributes; each
image node carries a `metadata.imageIntent` brief for a later image pass.
