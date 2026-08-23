# TreeIR & Diagnostics — quick reference

Everything here is normative: it mirrors `contract/CONTRACT.md` §1, §4, §5 and §6, and the
vendored schemas in `x-agent/schemas/`. Where this file and the contract disagree, the contract
wins.

---

## 1. The shape

```jsonc
{
  "version": 1,                    // the literal number 1. Not "1".
  "epoch": "<64 lowercase hex>",   // the instance fingerprint this tree was generated against
  "blocks": [ BlockNode, … ]
}
```

A `BlockNode` has **exactly three** possible keys:

```jsonc
{
  "name": "core/paragraph",        // required. /^[a-z0-9-]+\/[a-z0-9-]+$/
  "attributes": { … },             // optional. plain object
  "innerBlocks": [ BlockNode, … ]  // optional
}
```

`additionalProperties: false`. Anything else — `innerHTML`, `innerContent`, `clientId`,
`attrs`, `blockName` — is a hard `E_TREE_SCHEMA` error at the offending pointer.

**`innerHTML` is compiler output.** It exists in `wp_compile`'s markup and in `wp_parse`'s raw
form; it never exists in a tree. The schema is strict on purpose, so a tree that has been
contaminated by round-tripped parse output fails loudly instead of compiling something stale.

Note the two naming conventions you will move between:

| | tree (`TreeIR`) | parse output (`parse_blocks()`) |
|---|---|---|
| block name | `name` | `blockName` |
| attributes | `attributes` | `attrs` |
| children | `innerBlocks` | `innerBlocks` |
| markup | *(absent)* | `innerHTML`, `innerContent` |

`wp_parse` does the conversion for you and returns both: `tree` (stripped, TreeIR-shaped, ready
to edit) and `blocks` (verbatim, for inspection). Never hand-convert.

---

## 2. The epoch rule

The fingerprint is `sha256(canonical_json(registry + theme + active plugins + interfaces version))`.
It is an **opaque epoch string**. Get it from `wp_connect` or `wp_manifest`; never compute it,
never guess it, never abbreviate it in an actual call.

1. Every tree carries `epoch`.
2. `POST /validate` compares it to the live fingerprint. On mismatch: `E_EPOCH_MISMATCH` at
   `/epoch`, `epoch_ok: false`, `valid: false` — **and every other check still runs**, so one
   stale round trip still returns all the real diagnostics. Read them; they are still true.
3. The client refreshes the manifest **once** and retries **once**, automatically. A second
   mismatch surfaces `{code: "epoch_mismatch"}` to you. It never loops.
4. These move the epoch: activating/deactivating a plugin, switching the theme,
   `wp_tokens_apply`, `wp_block_install`. The last two hand you the new fingerprint in their
   return value — adopt it immediately.

```jsonc
← { "valid": false, "epoch_ok": false,
    "diagnostics": [
      { "code": "E_EPOCH_MISMATCH", "severity": "error", "path": "/epoch",
        "message": "Tree was generated against epoch \"0000…0000\" but this instance is at \"3dfb9d38…6e12\".",
        "fix_hint": "refetch GET /manifest, regenerate against the new epoch, then revalidate" } ] }
```

---

## 3. Diagnostics

`valid` is `true` **iff there are zero `severity: "error"` diagnostics**. Warnings never set
`valid: false` — which is exactly why you must read them.

`path` is an RFC 6901 JSON pointer rooted at the tree envelope: `/blocks/0/innerBlocks/2`,
`/blocks/1/attributes/level`, `/epoch`.

### Errors

| code | trigger | fix |
|---|---|---|
| `E_TREE_SCHEMA` | The body fails `tree-ir.schema.json`. **Stops all further checks** — you get this and nothing else. | Fix the shape. Usually: an `innerHTML` survived from parse output, a stray key, `version` sent as a string, or a `name` that is not `namespace/block`. The `wp_validate` local pre-check catches this with **zero network calls**, so it is free to fix. |
| `E_UNKNOWN_BLOCK` | `name` is not in this instance's registry. Children of an unknown block are not checked further. | `wp_manifest` and pick a block that exists here. If it genuinely should exist, the plugin providing it is not active. If it should not exist yet, that is R7 option 3. |
| `E_ATTR_TYPE` | The value violates the registered attribute `type` (`string number integer boolean array object null`; `type` may itself be an array). | Send the declared type. Classic: `"level": "2"` where the registry says `{"type":"number","default":2}`. |
| `E_ATTR_ENUM` | The value is not in the registered `enum`. | Pick one of the enumerated values; they are in the manifest entry. |
| `E_NEST_PARENT` | The block declares `parent[]` and its immediate parent is not in it — including sitting at the tree root. | Wrap it. `core/button` → `core/buttons`. `core/column` → `core/columns`. `core/list-item` → `core/list`. |
| `E_NEST_ANCESTOR` | The block declares `ancestor[]` and none of them appears anywhere up the chain. | Put it inside one. `core/post-template` → somewhere inside `core/query`. |
| `E_EPOCH_MISMATCH` | `tree.epoch !== fingerprint`. | §2. |

Real messages, from a live instance:

```
E_ATTR_TYPE      /blocks/0/attributes/level
  Attribute "level" of "core/heading" must be of type number, got string.
  fix: supply a number value

E_ATTR_ENUM      /blocks/0/innerBlocks/0/attributes/tagName
  Attribute "tagName" of "core/button" must be one of a, button.
  fix: pick one of the enumerated values

E_NEST_PARENT    /blocks/0
  Block "core/button" may only be used inside core/buttons, but it sits at the tree root.
  fix: wrap it in core/buttons

E_NEST_ANCESTOR  /blocks/0/innerBlocks/0
  Block "core/post-template" requires one of core/query somewhere above it; the actual chain is core/group.
  fix: place it inside core/query

E_UNKNOWN_BLOCK  /blocks/0/innerBlocks/0
  Block "acme/nonexistent" is not registered on this instance.
  fix: call GET /manifest and pick a block that exists here, or install it via POST /blocks/install

E_TREE_SCHEMA    /blocks/0/innerHTML
  BlockNode does not allow the property "innerHTML". A tree never carries serialized markup;
  innerHTML is a harness output.
```

### Warnings

| code | trigger | what to do |
|---|---|---|
| `W_ATTR_UNKNOWN` | The attribute key is neither declared by the block nor globally whitelisted. | **Fix it.** This is nearly always a memory error about an attribute WordPress moved or renamed. It does not fail validation, and it will silently do nothing at runtime. |
| `W_STATIC_NEEDS_HARNESS` | The block is static (`is_dynamic: false`). Emitted **once per distinct static block name**, at the first node using it. | **Nothing.** This is the contract reminding you that this block's markup is defined by its JS `save()` and must come from `wp_compile`. `fix_hint` is exactly `canonical markup must come from harness compile, do not hand-serialize`. Expect several on any real page. |
| `W_HINT_ALLOWED_BLOCKS` | The containing block's `agent_hints.allowed_blocks` does not include this child. | Use one of the container's allowed blocks, or move the child out. The block's author declared this constraint precisely because it is invisible to the registry. |
| `W_HINT_TEMPLATE_LOCK` | The containing block's `agent_hints.template_lock` is `all` or `insert` and your tree adds children to it. | Leave its inner blocks alone; put your content in an unlocked container. |

```
W_ATTR_UNKNOWN   /blocks/0/innerBlocks/0/attributes/textAlign
  Attribute "textAlign" is not declared by "core/heading".
  fix: drop it, or check GET /manifest for the block's declared attributes

W_STATIC_NEEDS_HARNESS  /blocks/0
  Block "core/group" is static: its markup is defined by its JavaScript save() output.
  fix: canonical markup must come from harness compile, do not hand-serialize
```

### The global attribute whitelist

These keys are generated by block *supports* rather than declared in a block's `attributes` map,
so they never raise `W_ATTR_UNKNOWN` on any block:

```
className   style       lock         metadata     align       anchor
backgroundColor  textColor  gradient  fontSize    fontFamily  borderColor
layout      templateLock
```

Whitelisted is not the same as *supported*. Sending `"backgroundColor"` to a block whose
`supports.color` is absent produces no warning and no effect. Check `supports` in the manifest
entry, not just the attribute list.

Attribute checking is **registry-shape only**: types and enums. There is no `source`-based HTML
semantics here — whether a `rich-text` attribute round-trips correctly is the compiler's business,
and it tells you via `wp_compile`'s `invalid[]`.

---

## 4. Compiling, and registry gaps

`wp_compile` takes the same flattened `{version, epoch, blocks}` and drives `window.__compile` on
the instance's `/harness` page in a warm headless browser. Inside that page, each node goes through
`wp.blocks.createBlock(name, attributes, innerBlocks)` — which applies defaults and sanitizes
attributes — then `wp.blocks.serialize()`, then `wp.blocks.parse()` again to collect per-block
`isValid`.

```jsonc
← { "markup": "…",
    "all_valid": true,
    "invalid": [],
    "registry_gaps": ["core/legacy-widget", "core/post-comments", "core/widget-group"],
    "epoch": "3dfb9d38…6e12" }
```

- **`all_valid` / `invalid[]`** — `invalid[]` entries carry `{path, name, validation_issues}` with
  `path` as an RFC 6901 pointer *rooted at the blocks array* (`/0/innerBlocks/2`), not at the
  envelope. Anything in there means the block's `save()` cannot express what you asked for. Fix
  the tree.
- **The compiler normalizes.** Attributes equal to their registered default are dropped from the
  serialized delimiter. This is why hand-written markup is always subtly wrong and why byte
  comparison against compiler output is the only meaningful check.
- **`registry_gaps`** — blocks present in the manifest but absent from `window.__registry()`, i.e.
  they failed to self-register client-side in the bare harness page. Three core blocks
  (`core/legacy-widget`, `core/post-comments`, `core/widget-group`) are gaps on a stock install;
  they need the full editor context. If a tree uses a gapped block, `wp_compile` refuses with
  `{code: "harness_gap", blocks: [...]}` rather than compiling something wrong.

**Suites are the case to understand.** Measured on a live instance with Kadence Blocks 3.7.9.1
active: the manifest holds **175** blocks (59 of them `kadence/*`) and `window.__registry()`
returns **176**. Every Kadence block registers — but only because the companion's harness route
defines `WP_ADMIN` for that one request. Kadence registers its editor script handles from an
`init` callback that starts with `if ( ! is_admin() ) return;`, and a REST request is not admin,
so without that the handles never exist and all 59 blocks are missing. That behavior is on by
default in `toolchain` posture and **off in `production`** (`X_COMPANION_HARNESS_ADMIN_CONTEXT`),
so the same suite tree that compiles on your sandbox can be a full `harness_gap` against a
production instance. That is the case the editor-injection fallback exists for.

The same measurement shows the mirror-image condition: four blocks are in `__registry()` but
**not** in the manifest — `kadence/countdown-inner`, `kadence/countdown-timer`, `kadence/pane`,
`kadence/tab`. They are inner blocks registered only in JavaScript, so the server has never heard
of them. They compile, and `wp_validate` rejects them with `E_UNKNOWN_BLOCK`. Trust the
manifest: it is the part that can be checked server-side.

## 5. Worked example — a core page

Blocks and attributes below are read from a live WordPress 7.1 + Twenty Twenty-Five instance;
the tree validates `valid: true` and compiles `all_valid: true`.

```jsonc
{
  "version": 1,
  "epoch": "3dfb9d3876c486b31f2b55f52e505d72fca6297df8f89842202f8e0966867e12",
  "blocks": [
    { "name": "core/group",
      "attributes": {
        "tagName": "section",
        "align": "full",
        "backgroundColor": "accent-5",
        "layout": { "type": "constrained" },
        "style": { "spacing": {
          "padding": { "top": "var:preset|spacing|80", "bottom": "var:preset|spacing|80" },
          "blockGap": "var:preset|spacing|50" } } },
      "innerBlocks": [
        { "name": "core/heading",
          "attributes": { "level": 1, "content": "Ship the layout, not the guesswork.",
            "fontSize": "xx-large",
            "style": { "typography": { "textAlign": "center" } } } },
        { "name": "core/paragraph",
          "attributes": { "content": "Trees in, compiled markup out, geometry checked in pixels.",
            "fontSize": "large",
            "style": { "typography": { "textAlign": "center" } } } },
        { "name": "core/buttons",
          "attributes": { "layout": { "type": "flex", "justifyContent": "center" } },
          "innerBlocks": [
            { "name": "core/button",
              "attributes": { "text": "Start building", "url": "/docs",
                "backgroundColor": "accent-3", "textColor": "base" } },
            { "name": "core/button",
              "attributes": { "text": "Read the contract", "url": "/contract",
                "className": "is-style-outline" } } ] } ] },

    { "name": "core/columns",
      "attributes": { "align": "wide", "isStackedOnMobile": true,
        "style": { "spacing": { "blockGap": { "left": "var:preset|spacing|50" } } } },
      "innerBlocks": [
        { "name": "core/column", "attributes": { "width": "33.33%" },
          "innerBlocks": [
            { "name": "core/heading", "attributes": { "level": 3, "content": "Deterministic" } },
            { "name": "core/paragraph",
              "attributes": { "content": "Markup comes from each block's own save()." } } ] },
        { "name": "core/column", "attributes": { "width": "33.33%" },
          "innerBlocks": [
            { "name": "core/heading", "attributes": { "level": 3, "content": "Measured" } },
            { "name": "core/paragraph",
              "attributes": { "content": "Layout is diffed in pixels, not squinted at." } } ] } ] }
  ]
}
```

Things to copy from this example:

- `core/button` sits inside `core/buttons` (its registered `parent`), `core/column` inside
  `core/columns`. Getting this wrong is `E_NEST_PARENT`.
- `level` is a **number**. `"3"` is `E_ATTR_TYPE`.
- Text alignment is `style.typography.textAlign`, **not** a `textAlign` attribute — `core/heading`
  does not declare one on current WordPress. It declares `supports.typography.textAlign`.
- Color and size are slugs (`accent-5`, `xx-large`); spacing is `var:preset|spacing|<slug>`.
- `is-style-outline` is a *registered block style*, which is a legitimate `className`. A made-up
  class name is not.

Compiled head, verbatim from the harness:

```html
<!-- wp:group {"tagName":"section","align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|80"},"blockGap":"var:preset|spacing|50"}},"backgroundColor":"accent-5","layout":{"type":"constrained"}} -->
<section class="wp-block-group alignfull has-accent-5-background-color has-background" style="padding-top:var(--wp--preset--spacing--80);padding-bottom:var(--wp--preset--spacing--80)"><!-- wp:heading {"level":1,"style":{"typography":{"textAlign":"center"}},"fontSize":"xx-large"} -->
<h1 class="wp-block-heading has-text-align-center has-xx-large-font-size">Ship the layout, not the guesswork.</h1>
<!-- /wp:heading -->
```

Note what the compiler did that you would not have: reordered the attribute keys, expanded
`var:preset|spacing|80` into `var(--wp--preset--spacing--80)` in the `style` attribute while
leaving the delimiter in preset form, derived four class names, and **dropped
`isStackedOnMobile: true` from the `core/columns` delimiter because it is the registered default**.

---

## 6. Worked example — a suite section (Kadence Blocks)

Instance: WordPress 7.1 + Twenty Twenty-Five + **Kadence Blocks 3.7.9.1**, `toolchain` posture,
manifest fingerprint `74758d08…0be3`, 175 blocks, `suites: [{"slug":"kadence-blocks","version":"3.7.9.1"}]`.

Suite blocks do not follow core's conventions and you cannot guess their attributes. Read the
manifest entry first — `kadence/rowlayout` alone declares **174** attributes:

```jsonc
→ wp_manifest { "filter": { "name_prefix": "kadence/" } }
← { "blocks": {
      "kadence/rowlayout": { "title": "Row Layout", "api_version": 3, "is_dynamic": true,
        "parent": null, "ancestor": null,
        "attributes": {
          "uniqueID":     { "type": "string", "default": "" },
          "columns":      { "type": "number", "default": 2 },
          "colLayout":    { "type": "string", "default": "" },
          "padding":      { "type": "array",  "default": ["sm", "", "sm", ""] },
          "paddingUnit":  { "type": "string", "default": "px" },
          "bgColor":      { "type": "string", "default": "" },
          "maxWidth":     { "type": "number", "default": "" },
          "htmlTag":      { "type": "string", "default": "div" },
          "verticalAlignment": { "type": "string", "default": "top" },
          "collapseOrder":     { "type": "string", "default": "left-to-right" },
          "tabletLayout":      { "type": "string", "default": "inherit" },
          "mobileLayout":      { "type": "string", "default": "row" },
          "…": "(162 more)" } },
      "kadence/column": { "title": "Section", "is_dynamic": true, "parent": null,
        "attributes": { "uniqueID": {"type":"string","default":""},
                        "id": {"type":"number","default":1},
                        "textAlign": {"type":"array","default":["","",""]},
                        "padding": {"type":"array","default":["","","",""]},
                        "background": {"type":"string","default":""},
                        "…": "(132 more)" } },
      "kadence/advancedheading": { "title": "Advanced Text", "is_dynamic": true,
        "attributes": { "content": {"type":"string","source":"html"},
                        "level": {"type":"number","default":2},
                        "htmlTag": {"type":"string","default":"heading"},
                        "color": {"type":"string"},
                        "fontSize": {"type":"array","default":["","",""]},
                        "sizeType": {"type":"string","default":"px"},
                        "…": "(143 more)" } },
      "kadence/testimonial": { "title": "Testimonial", "is_dynamic": true,
                               "parent": ["kadence/testimonials"] },
      "…": "(55 more kadence blocks)" },
    "summary": false, "filtered": true,
    "blocks_returned": 59, "blocks_total": 175, "served_from_cache": false }
```

Three suite-shaped surprises, all visible in that output and none of them guessable:

1. **Responsive values are positional arrays.** `fontSize: [34, "", 26]` is
   `[desktop, tablet, mobile]`; `textAlign: ["left", "", ""]` likewise; `padding` is
   `[top, right, bottom, left]` with a separate `paddingUnit`. Core uses objects with named keys
   and CSS units; Kadence uses arrays of bare numbers. Mixing the conventions gives `E_ATTR_TYPE`.
2. **`uniqueID` is load-bearing.** Kadence generates per-block CSS keyed on it. It is a plain
   declared attribute, so you must supply one; make it stable and unique per node.
3. **`htmlTag: "heading"`** on `kadence/advancedheading` is not an HTML tag name — the tag comes
   from `level`. Reading defaults beats assuming.

A section that validates clean against that instance:

```jsonc
{
  "version": 1,
  "epoch": "74758d08d505b993e4d62bc9f4a4539686b8f03048ae06c5a7be263ca12b0be3",
  "blocks": [
    { "name": "kadence/rowlayout",
      "attributes": {
        "uniqueID": "1234_a1b2c3-de",
        "columns": 2,
        "colLayout": "equal",
        "htmlTag": "section",
        "align": "full",
        "maxWidth": 1340,
        "verticalAlignment": "middle",
        "padding": [80, 0, 80, 0],
        "paddingUnit": "px",
        "bgColor": "#FBFAF3",
        "collapseOrder": "left-to-right",
        "tabletLayout": "inherit",
        "mobileLayout": "row" },
      "innerBlocks": [
        { "name": "kadence/column",
          "attributes": { "uniqueID": "1234_a1b2c3-de-1", "id": 1, "textAlign": ["left", "", ""] },
          "innerBlocks": [
            { "name": "kadence/advancedheading",
              "attributes": { "uniqueID": "1234_a1b2c3-de-h1",
                "content": "Measured, not squinted at.",
                "level": 2, "htmlTag": "heading", "align": "left",
                "color": "#111111", "fontSize": [34, "", 26], "sizeType": "px" } },
            { "name": "core/paragraph",
              "attributes": { "content": "Every box is checked against the spec in pixels.",
                              "fontSize": "medium" } } ] },
        { "name": "kadence/column",
          "attributes": { "uniqueID": "1234_a1b2c3-de-2", "id": 2, "textAlign": ["left", "", ""] },
          "innerBlocks": [
            { "name": "core/image",
              "attributes": { "sizeSlug": "large", "alt": "A layout diff report" } } ] } ] }
  ]
}
```

```jsonc
→ wp_validate { "version": 1, "epoch": "74758d08…0be3", "blocks": [ /* the tree above */ ] }
← { "valid": true, "epoch_ok": true,
    "server_fingerprint": "74758d08…0be3",
    "checked_locally_only": false,
    "diagnostics": [
      { "code": "W_STATIC_NEEDS_HARNESS", "severity": "warning",
        "path": "/blocks/0/innerBlocks/0/innerBlocks/1",
        "message": "Block \"core/paragraph\" is static: its markup is defined by its JavaScript save() output.",
        "fix_hint": "canonical markup must come from harness compile, do not hand-serialize" } ] }
```

One warning, and it is about the *core* paragraph — every Kadence block here is dynamic.

`wp_compile` then returns `all_valid: true`, `invalid: []`, and this markup — which shows why
suite markup is never written by hand:

```html
<!-- wp:kadence/rowlayout {"uniqueID":"1234_a1b2c3-de","colLayout":"equal","htmlTag":"section","maxWidth":1340,"bgColor":"#FBFAF3","align":"full","verticalAlignment":"middle","padding":[80,0,80,0]} -->
<!-- wp:kadence/column {"uniqueID":"1234_a1b2c3-de-1","textAlign":["left","",""]} -->
<div class="wp-block-kadence-column kadence-column1234_a1b2c3-de-1"><div class="kt-inside-inner-col"><!-- wp:kadence/advancedheading {"uniqueID":"1234_a1b2c3-de-h1","align":"left","color":"#111111","fontSize":[34,"",26]} -->
<h2 class="kt-adv-heading1234_a1b2c3-de-h1 wp-block-kadence-advancedheading" data-kb-block="kb-adv-heading1234_a1b2c3-de-h1">Measured, not squinted at.</h2>
<!-- /wp:kadence/advancedheading -->
```

None of this could have been guessed: `kt-inside-inner-col`, the doubled wrapper,
`kadence-column<uniqueID>`, `kt-adv-heading<uniqueID>`,
`data-kb-block="kb-adv-heading<uniqueID>"`. Note also what the
compiler dropped as equal to its registered default: `columns: 2`, `paddingUnit: "px"`,
`collapseOrder`, `tabletLayout`, `mobileLayout`, and `id: 1` on the first column — while keeping
`id: 2` on the second.

> **A posture-dependent caveat.** All of that depended on the 59 Kadence blocks being in
> `window.__registry()`, which depended on the harness route's admin context (§4). Against a
> `production`-posture instance, where that is off by default, the identical tree returns
> `{"code": "harness_gap", "blocks": ["kadence/rowlayout", "kadence/column", "kadence/advancedheading"], "hint": "…"}`.
> Read `registry_gaps` on every compile rather than assuming yesterday's instance.
>
> **Notice what needs no browser at all:** the manifest, the attribute schemas and `wp_validate`
> are server-side, so authoring and checking a suite tree always works. Only serialization needs
> the harness.

Blocks mix freely: `core/paragraph` and `core/image` sit inside `kadence/column` because
`kadence/column` declares no `agent_hints.allowed_blocks`. If it had, you would have got
`W_HINT_ALLOWED_BLOCKS` on those children.

---

## 7. Worked example — using an installed agent block

After R7 option 3 (`wp_block_scaffold` → implement `render.php` → `wp_block_build_test` →
`wp_block_install`), the new block is available like any other. The install response is where
the new fingerprint comes from:

```jsonc
← { "installed": { "slug": "testimonial", "name": "agent/testimonial", "version": "1.0.0" },
    "fingerprint": "fd0f1ab1892be2885055ddb13868c0e28dcffe8dcf466ddc1028517528525981",
    "replaced_previous": false }
```

Everything below is read from a live toolchain instance at the moment that block was installed —
117 blocks, up from the 116 of a bare core install. (It is a factory test fixture and has since
been rolled back — R3 exists because the available blocks differ per instance and change over
time.)

**Read its manifest entry before using it.** The attributes you declared at scaffold time are what
came out the other side, plus the whitelisted supports attributes:

```jsonc
→ wp_manifest { "refresh": true, "filter": { "name_prefix": "agent/" } }
← { "fingerprint": "fd0f1ab1…5981",
    "blocks": { "agent/testimonial": {
      "title": "Agent Testimonial", "category": "text", "api_version": 3,
      "attributes": {
        "quote":       { "type": "string", "default": "" },
        "attribution": { "type": "string", "default": "" },
        "role":        { "type": "string", "default": "" },
        "tone":        { "type": "string", "enum": ["plain", "accent"], "default": "plain" },
        "align":       { "type": "string", "enum": ["left","center","right","wide","full",""] },
        "className":   { "type": "string" }, "style": { "type": "object" },
        "backgroundColor": { "type": "string" }, "textColor": { "type": "string" },
        "anchor":      { "type": "string" }, "lock": { "type": "object" },
        "metadata":    { "type": "object" } },
      "supports": { "html": false, "anchor": true, "align": ["wide", "full"],
                    "spacing": { "margin": true, "padding": true },
                    "color": { "background": true, "text": true } },
      "parent": null, "ancestor": null,
      "provides_context": {}, "uses_context": [],
      "is_dynamic": true, "variations_count": 0 } },
    "summary": false, "filtered": true,
    "blocks_returned": 1, "blocks_total": 117, "served_from_cache": false }
```

Four declared attributes; the other eight are the global whitelist arriving via `supports`.
`tone` carries an `enum`, so `"tone": "loud"` is `E_ATTR_ENUM` — an agent block is validated
exactly like a core one.

Used in a tree, carrying the **new** epoch:

```jsonc
{
  "version": 1,
  "epoch": "fd0f1ab1892be2885055ddb13868c0e28dcffe8dcf466ddc1028517528525981",
  "blocks": [
    { "name": "core/group",
      "attributes": { "tagName": "section", "align": "full",
        "layout": { "type": "constrained" },
        "style": { "spacing": { "padding": { "top": "var:preset|spacing|70",
                                             "bottom": "var:preset|spacing|70" },
                                "blockGap": "var:preset|spacing|50" } } },
      "innerBlocks": [
        { "name": "core/heading",
          "attributes": { "level": 2, "content": "What people say",
            "style": { "typography": { "textAlign": "center" } } } },
        { "name": "core/columns", "attributes": { "align": "wide" },
          "innerBlocks": [
            { "name": "core/column",
              "innerBlocks": [
                { "name": "agent/testimonial",
                  "attributes": { "quote": "It compiles the first time.",
                                  "attribution": "A. Developer", "role": "Staff Engineer",
                                  "tone": "accent" } } ] },
            { "name": "core/column",
              "innerBlocks": [
                { "name": "agent/testimonial",
                  "attributes": { "quote": "The diff told me exactly which 2 pixels I gave up.",
                                  "attribution": "R. Designer", "role": "Design Lead",
                                  "tone": "plain" } } ] } ] } ] }
  ]
}
```

```jsonc
→ wp_validate { "version": 1, "epoch": "fd0f1ab1…5981", "blocks": [ /* the tree above */ ] }
← { "valid": true, "epoch_ok": true,
    "server_fingerprint": "fd0f1ab1…5981",
    "checked_locally_only": false,
    "diagnostics": [
      { "code": "W_STATIC_NEEDS_HARNESS", "severity": "warning", "path": "/blocks/0",
        "message": "Block \"core/group\" is static: …", "fix_hint": "…" },
      { "code": "W_STATIC_NEEDS_HARNESS", "severity": "warning", "path": "/blocks/0/innerBlocks/1",
        "message": "Block \"core/columns\" is static: …", "fix_hint": "…" },
      { "code": "W_STATIC_NEEDS_HARNESS", "severity": "warning",
        "path": "/blocks/0/innerBlocks/1/innerBlocks/0",
        "message": "Block \"core/column\" is static: …", "fix_hint": "…" } ] }
```

Three warnings, all about **core** blocks. `agent/testimonial` raises none: it is dynamic, which is
what R7's "static blocks are never created" buys you.

### The failure this example shows

`wp_validate` passed. Compiling the same tree against that same instance produced this:

```html
<!-- wp:columns {"align":"wide"} -->
<div class="wp-block-columns alignwide"><!-- wp:column -->
<div class="wp-block-column"></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->
```

**Both testimonials are gone, and the harness still reported `all_valid: true`.** Its
`window.__registry()` held 113 blocks against the manifest's 117, and `agent/testimonial` was one
of the four missing: its editor script did not self-register on that page.
`wp.blocks.createBlock()` on an unregistered name has nothing to serialize, so the block simply
vanished — silently, with a green result.

That is the failure mode `wp_compile` is built to catch. It diffs `manifest.blocks` against
`__registry()` **before** trusting anything the page returns, and refuses:

```jsonc
← { "code": "harness_gap",
    "blocks": ["agent/testimonial"],
    "message": "Blocks in the tree are registered on the instance but missing from the harness page registry.",
    "hint": "The block is registered on the server but never registered client-side on GET /harness, so its save() is unavailable and any markup produced would be wrong. Fix the block's editor_script_handles on the instance, drop the block from the tree, or enable the documented editor-injection fallback with X_AGENT_HARNESS_FALLBACK=1." }
```

Three core blocks — `core/legacy-widget`, `core/post-comments`, `core/widget-group` — are gaps on
**every** instance measured, bare core included; they need the full editor context. Read
`registry_gaps` on every successful compile: it is the early warning for the tree you are about to
write, and a silently-empty page is a far worse outcome than an error.

Once compilation succeeds, use `wp_render` to see what a dynamic block actually emits, since its
markup is only a self-closing delimiter and all its HTML comes from `render.php` at request time:

```jsonc
→ wp_render { "markup": "<!-- wp:agent/testimonial {\"quote\":\"It compiles the first time.\",\"attribution\":\"A. Developer\",\"tone\":\"accent\"} /-->" }
← { "html": "<figure class=\"wp-block-agent-testimonial is-tone-accent\">…</figure>",
    "enqueued_styles": ["http://127.0.0.1:9410/wp-content/uploads/x-agent-blocks/testimonial/style-index.css?ver=1.0.0"] }
```

Note that `"role": ""` and `"tone": "plain"` would be **absent** from a delimiter: they equal the
registered defaults, and `createBlock()` drops defaults on serialize. Iterate on the defaults in
`block.json` rather than repeating values in every tree.

## 8. Checklist

Before `wp_compile`:

- [ ] `version` is the number `1`; `epoch` is the current fingerprint, in full.
- [ ] Every node has only `name` / `attributes` / `innerBlocks`. No `innerHTML` anywhere.
- [ ] Every block name came from `wp_manifest` at this epoch.
- [ ] Every attribute is declared by the block or globally whitelisted, and matches its type/enum.
- [ ] Every `parent`/`ancestor` constraint is satisfied.
- [ ] Colors, sizes and spacing are preset slugs, not literals.
- [ ] `wp_validate` returned `valid: true`, and every warning has been fixed or justified.
