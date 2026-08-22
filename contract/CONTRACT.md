# X Contract v1 — the wire between `x-companion` (WordPress) and `x-agent` (Claude Code)

**This file is normative and frozen for v1.** Both sides code against it. Where it and the
specs in `../specs/` disagree, the specs win and this file must be corrected — but neither
side may change a shape unilaterally.

- `interfaces.version` = `"1"`
- REST namespace = `x-companion/v1`
- Base URL = `{site_url}/wp-json/x-companion/v1` (pretty permalinks) or
  `{site_url}/?rest_route=/x-companion/v1/...` (plain permalinks). Clients MUST support both;
  probe pretty first, fall back to `rest_route` on 404.
- Auth = HTTP Basic with a WordPress Application Password. Sent on **every** request,
  including `GET /harness`. No cookies, no nonces, no relay.

## 1. Shared types

JSON Schemas are in `contract/schemas/` and are vendored (byte-identical copies) into:

- `x-companion/fixtures/schemas/`
- `x-agent/schemas/`

| Type | Schema |
|---|---|
| `TreeIR` | `tree-ir.schema.json` |
| `Diagnostics` | `diagnostics.schema.json` |
| `Manifest` | `manifest.schema.json` |
| `DesignTokens` | `design-tokens.schema.json` |
| `DesignSpecIR` | `design-spec.schema.json` (agent-side only; companion never sees it) |

**A tree never contains `innerHTML`.** `innerHTML` is a compiler output produced only by the
harness. `BlockNode` is `additionalProperties: false` precisely so a stray `innerHTML` is a
hard schema error.

## 2. Error envelope

Every non-2xx response is a standard `WP_Error` JSON body:

```json
{ "code": "posture_forbidden", "message": "human text", "data": { "status": 403 } }
```

Pinned codes (status in parentheses):

| code | status | meaning |
|---|---|---|
| `rest_forbidden` | 401 | no/failed authentication |
| `rest_forbidden_capability` | 403 | authenticated but lacks the tier capability |
| `posture_forbidden` | 403 | extend-tier route on a `production` posture instance |
| `rest_invalid_param` | 400 | request body failed route schema |
| `block_policy` | 422 | install package violated policy; `data.reasons: string[]` |
| `in_use` | 409 | delete refused; `data.posts: int[]` |
| `not_found` | 404 | unknown library slug |
| `no_previous` | 409 | rollback with no `.prev` |

## 3. Capability tiers

| tier | capability | routes |
|---|---|---|
| introspect | `x_companion_read` | `GET /manifest`, `GET /fingerprint`, `GET /patterns`, `GET /harness`, `POST /validate`, `POST /parse`, `POST /render` |
| author | `x_companion_author` | (reserved — no v1 routes) |
| extend | `x_companion_extend` | `POST /blocks/install`, `GET /blocks/library`, `POST /blocks/library/{slug}/rollback`, `DELETE /blocks/library/{slug}`, `POST /theme/tokens`, `POST /snapshot/export`, `POST /placeholder`, `POST /patterns` |

Order inside every handler, no exceptions: **capability check → input schema validation → work.**
Posture gate is part of the capability check (`permission_callback`) for extend-tier routes, so
`production` returns 403 `posture_forbidden` *before* the body is ever parsed.

## 4. Fingerprint (the epoch)

Pinned so both sides compute and compare it identically.

```
fingerprint = sha256( canonical_json( fingerprint_inputs ) )
```

`fingerprint_inputs` is exactly this object, keys in this order:

```json
{
  "interfaces_version": "1",
  "blocks": [
    { "name": "core/paragraph", "api_version": 3,
      "attributes": { ...verbatim registry attributes... },
      "parent": null, "ancestor": null }
  ],
  "theme": { "slug": "twentytwentyfive", "version": "1.3" },
  "plugins": [ { "slug": "x-companion", "version": "1.0.0" } ],
  "global_styles": "<sha256 of the user-origin global styles post content, or ''>",
  "agent_patterns": "<sha256 of the agent-saved pattern corpus, or ''>",
  "platform": "<sha256 of the canonical platform snapshot, or ''>"
}
```

- `blocks` sorted ascending by `name` (byte order, `strcmp`).
- `plugins` = **active** plugins only, sorted ascending by `slug`, where `slug` is the plugin
  file's dirname (or basename without `.php` for single-file plugins).
- `parent` / `ancestor` are `null` when unset, otherwise the registry array sorted ascending.
- `global_styles` is the sha256 of the user-origin global styles post's content, `''` when the
  post does not exist or is empty. It is an input **so that design-token writes move the epoch**:
  the manifest is cached by fingerprint, and without this component `POST /theme/tokens` changed
  `theme_tokens` while the cache key stayed put, serving stale tokens until a forced refresh.

- `platform` (interfaces v2) is the sha256 of the canonical platform snapshot: registered block
  styles, binding source names, post types with their registered meta keys, taxonomies, and
  server-registered variation names. It is an input **so that schema installs, meta registration
  and style/variation registration move the epoch** — each changes what a valid tree means.
  `''` on a v1 instance.

`canonical_json` = UTF-8 JSON with **object keys sorted ascending byte order at every depth**,
no insignificant whitespace, `/` not escaped, unicode not escaped.
PHP: `wp_json_encode( $v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE )` after a recursive
`ksort`. JS: the equivalent recursive key-sorted `JSON.stringify`.

The agent side MUST NOT recompute the fingerprint to decide freshness — it is an opaque epoch
string obtained from `GET /fingerprint`. The algorithm is pinned only so `POST /snapshot/export`
artifacts can be compared against a target instance's fingerprint offline.

**Epoch discipline:** every `TreeIR` carries `epoch`. `POST /validate` compares it to the current
fingerprint; on mismatch it emits `E_EPOCH_MISMATCH` at path `/epoch`, sets `epoch_ok: false` and
`valid: false`, **and still runs every other check** so the agent gets one useful round trip.

## 5. Routes

### `GET /fingerprint` — introspect
```json
{ "fingerprint": "<64 hex>", "posture": "toolchain|production", "interfaces_version": "1" }
```
Cheap. Called before every batch. Must not build the heavy manifest body.

### `GET /manifest` — introspect
Returns `Manifest` (see `manifest.schema.json`). Cached in a transient keyed by the hash of the
fingerprint inputs. Each request recomputes the *cheap* inputs hash and rebuilds the heavy body
only when it moved. Invalidated on `activated_plugin`, `deactivated_plugin`, `switch_theme`, and
after `POST /blocks/install`.

**interfaces v2** adds the manifest sections `global_styles`, `bindings`, `data_model`,
`features`, and per-block `styles` + `variations` (full entries beside the v1
`variations_count`), plus sectioned retrieval:

```
GET /manifest?section=styles|variations|global_styles|bindings|data_model|features
```

returns `{ fingerprint, posture, interfaces_version, section, <section> }` — for `styles` and
`variations` the payload is a `block name → entries` map extracted from `blocks`. All v2
additions are additive: every v1 field is unchanged, a v1 client keeps working, and a v2 client
must read `interfaces_version` before requesting v2 sections.

### `POST /validate` — introspect
Body: `TreeIR`. Returns `Diagnostics`. Diagnostic codes and their exact semantics:

| code | severity | path | when |
|---|---|---|---|
| `E_TREE_SCHEMA` | error | pointer to offending node, or `/` | body fails `TreeIR` schema. **Stops all further checks.** |
| `E_EPOCH_MISMATCH` | error | `/epoch` | `tree.epoch !== fingerprint`. Other checks still run. |
| `E_UNKNOWN_BLOCK` | error | node pointer | `name` not in registry. Children of an unknown block are not further checked. |
| `E_ATTR_TYPE` | error | `<node>/attributes/<key>` | value violates registered attribute `type` (`string,number,integer,boolean,array,object,null`; `type` may be an array of these) |
| `E_ATTR_ENUM` | error | `<node>/attributes/<key>` | value not in registered `enum` |
| `E_NEST_PARENT` | error | node pointer | child's registered `parent[]` does not include the immediate parent block name (or block has `parent[]` and sits at tree root) |
| `E_NEST_ANCESTOR` | error | node pointer | child's registered `ancestor[]` intersects none of the actual ancestor chain |
| `W_ATTR_UNKNOWN` | warning | `<node>/attributes/<key>` | key not declared and not globally whitelisted |
| `W_STATIC_NEEDS_HARNESS` | warning | first node of that block name | block `is_dynamic == false`. Emitted **once per distinct static block name**. `fix_hint` is exactly: `canonical markup must come from harness compile, do not hand-serialize` |
| `W_HINT_ALLOWED_BLOCKS` | warning | child node pointer | containing block's `agent_hints.allowed_blocks` excludes this child |
| `W_HINT_TEMPLATE_LOCK` | warning | containing node pointer | containing block's `agent_hints.template_lock` is `all`/`insert` and the tree adds children |

Globally whitelisted attribute keys (supports-generated, never `W_ATTR_UNKNOWN`):
`className`, `style`, `lock`, `metadata`, `align`, `anchor`, `backgroundColor`, `textColor`,
`gradient`, `fontSize`, `fontFamily`, `borderColor`, `layout`, `templateLock`.

`valid` is `true` iff there are **zero** `severity: "error"` diagnostics.
Attribute type checking is registry-shape only — **no `source`-based HTML attribute semantics**;
that is the harness's job.

JSON pointer format: `/blocks/0/innerBlocks/2`, RFC 6901.

### `POST /parse` — introspect
Body `{ "markup": string }` → `{ "blocks": <parse_blocks() output verbatim> }`
(each node: `blockName`, `attrs`, `innerBlocks`, `innerHTML`, `innerContent`).

### `POST /render` — introspect
Body `{ "markup": string }` → `{ "html": <do_blocks() output>, "enqueued_styles": string[] }`
`enqueued_styles` are absolute URLs of styles enqueued during the render, `[]` if not determinable.
Runs inside a faux main-query guard.

### `GET /patterns` — introspect
`[{ name, title, categories, content, parsed }]` where `content` is serialized markup and
`parsed` is `parse_blocks(content)`.

### `GET /harness` — introspect
`text/html`. Registered as a REST route whose callback echoes HTML and exits, so Basic auth is
uniform. See §6.

### `POST /blocks/install` — extend
`multipart/form-data`, field `package` = zip →
```json
{ "installed": { "slug": "...", "name": "agent/...", "version": "..." },
  "fingerprint": "<new epoch>", "replaced_previous": false }
```
Policy (all violations → 422 `block_policy` with `data.reasons`):
- exactly one top-level dir, or flat files, with `block.json` at the block root
- `name` matches `^agent/[a-z0-9-]+$` (namespace filterable via `x_companion_block_namespace`)
- `render` entry present pointing at a file that exists in the zip, unless
  `X_COMPANION_ALLOW_STATIC_BLOCKS`
- no `../` or absolute paths in any zip entry; total size ≤ 5 MB
- `block.json` parses; every file referenced by `block.json` exists in the zip

Structural validation only. **No `php -l`, no `exec`.** The safety gate lives on the agent side
(Playground smoke-test before POSTing). Install target `wp_upload_dir()['basedir']/x-agent-blocks/{slug}/`;
an existing slug is moved to `{slug}.prev/` first (single-level rollback).

### `GET /blocks/library` — extend
`[{ slug, name, version, installed_at, has_prev }]`

### `POST /blocks/library/{slug}/rollback` — extend → `{ "fingerprint": "..." }`
### `DELETE /blocks/library/{slug}` — extend → `{ "fingerprint": "..." }`
409 `in_use` with `data.posts` if published content contains `<!-- wp:{name}`.

### `POST /theme/tokens` — extend
Body: `DesignTokens` → `{ theme_json_written: bool, adapters_applied: string[], fingerprint }`
Primary write path is the **user-origin global styles CPT** (`wp_global_styles`), because it works
on read-only theme dirs and survives theme updates.

### `POST /snapshot/export` — extend
`application/zip` stream containing exactly: `theme/`, `agent-blocks/`, `patterns.json`,
`content.xml` (WXR), `manifest.json`.

### `POST /patterns` — extend

Body `{ "slug": "agent/...", "title", "content", "categories"?, "description"? }`. Saves a
composed section as a registered block pattern: stored in an option, registered on every init
in the `x-agent` category (plus any given), listed by `GET /patterns` and the manifest like any
theme pattern, and idempotent per slug (same slug replaces). `content` must be serialized
markup produced by the harness compile; content that parses to zero blocks answers 422
`{ code: "pattern_policy" }`, as does a slug outside the `agent/` namespace. Answers
`{ saved, replaced, total, fingerprint }` — the fingerprint is NEW (see §4): saving a pattern
moves the epoch.

### `POST /placeholder` — extend

Body `{ "color": "#rrggbb" | "<palette-slug>", "width"?: 1-4000, "height"?: 1-4000 }`.
Creates — idempotently, one attachment per colour and size — a solid-colour image in the
media library and answers
`{ id, url, color, slug, reused }`. Palette slugs resolve against the instance's global
settings (user origin wins over theme, theme over default), so placeholders land on the design
system. At the default 1×1 the file is a GIF meant to be stretched by block attributes;
with `width`/`height` it is a real-sized PNG for markup that renders images at intrinsic
size (e.g. WooCommerce product images). Unknown colours answer 400
`{ code: "invalid_color" }`.

This is the default image source while a layout is being fabricated: the client stretches the
pixel with block attributes (`width`/`aspectRatio`/`scale`, or `imageFill` on media-text) and
records the intended picture in the node's `attributes.metadata.imageIntent`, which serializes
into the block delimiter and round-trips through `POST /parse` for a later image-generation
pass to fulfil.

## 6. Harness page contract

Server emits a minimal page (no theme, no admin chrome) that:

1. prints `get_block_editor_server_block_settings()` into an inline bootstrap for
   `wp.blocks.unstable__bootstrapServerSideBlockDefinitions` (exactly as core's editor does)
2. enqueues `wp-blocks`, `wp-block-library`, `wp-element`, `wp-data`, `wp-dom-ready`, `wp-i18n`
3. for every `WP_Block_Type`, enqueues all handles in `editor_script_handles`
4. fires `do_action( 'enqueue_block_editor_assets' )` guarded by a shutdown handler; on fatal,
   serves the page **without** that action and sets header `X-Harness-Degraded: enqueue_block_editor_assets`
5. enqueues `harness/harness.js` last

`harness.js` exposes exactly:

```ts
window.__version: string            // === "1"
window.__ready: Promise<void>       // resolves after DOMContentLoaded + one tick
window.__registry(): string[]       // wp.blocks.getBlockTypes().map(t => t.name)
window.__compile(blocks: BlockNode[]): {
  markup: string,
  all_valid: boolean,
  invalid: { path: string, name: string, validation_issues: any }[]
} | { error: string }
```

`__compile` takes **`TreeIR.blocks`** — the array, not the envelope. It recursively
`wp.blocks.createBlock(name, attributes, innerBlocks)` (which applies defaults and sanitizes
attrs), `wp.blocks.serialize(blocks)` → markup, then `wp.blocks.parse(markup)` and walks the
result collecting `isValid` per block with its path. `path` is the same RFC 6901 pointer style
rooted at the passed array: `/0/innerBlocks/2`. The entire body is wrapped in try/catch and
returns `{ error: message }` on throw — it never leaves the caller hanging.

**Registry gap detection:** the agent diffs `__registry()` against `manifest.blocks` keys. Blocks
present in the manifest but missing from `__registry()` failed to self-register client-side. If a
tree uses one, `wp_compile` returns a structured `harness_gap` error rather than compiling
something wrong. Documented fallback (detection is implemented, fallback is behind a default-off
flag): load `wp-admin/post-new.php` in Playwright and inject `harness.js` into the editor iframe.

## 7. Agent-side error envelope

MCP tools never throw bare errors to the client. Every failure is:

```json
{ "code": "https_required|posture_forbidden|harness_gap|epoch_mismatch|companion_unreachable|companion_error|invalid_input|build_failed|smoke_failed", 
  "message": "human text", "hint": "what to do instead" }
```

plus code-specific fields (`harness_gap` → `blocks: string[]`; `companion_error` → `status`, `wp_code`).

## 8. Epoch retry rule (agent side)

Every companion call carries the expected fingerprint. On `E_EPOCH_MISMATCH` (in `Diagnostics`) or
HTTP 409 epoch conflict, the client refreshes the manifest **once** and retries **once**. If it
mismatches again, it surfaces `epoch_mismatch` to the caller. Never loop.
