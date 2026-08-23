---
name: wp-schema
description: >-
  Model a domain on a WordPress instance running the X Companion plugin: custom post types,
  taxonomies, custom fields/meta, block bindings, REST endpoints and admin screens, built as
  tested schema packages. Use whenever the task involves storage, orders, bookings,
  submissions, inventory, "where does the data live", registering a CPT or meta, binding block
  content to a field, an ordering/booking/reservation system, or any block whose behavior needs
  a backend. Companion skill to wp-blocks: the schema package owns the data, blocks are its
  views. Triggers on wp_schema_scaffold, wp_schema_build_test, wp_schema_install, data_model,
  bindings, or any mention of schema packages.
---

# WordPress backends

You are connected to **one specific WordPress instance**. This skill is the backend
counterpart of **wp-blocks**: the instance — not your memory of WordPress in general —
defines the data model, and the only way to extend it is a **schema package**: a
WordPress plugin that registers post types, taxonomies, REST-visible meta, binding sources
and REST routes through core APIs. The tools generate the package, test it in a throwaway
sandbox, and install it through the companion, which refuses installs on production
instances.

One hard rule, parallel to the wp-blocks rule against hand-written markup: **never fake a
data store.** Not comments-as-orders, not options-as-records, not transients-as-queues.
When a task needs storage, a lifecycle, or an admin surface, it needs a data model — and a
data model is a schema package.

---

## 1. The loop

| # | Step | Tool | Gate before moving on |
|---|---|---|---|
| 0 | Connect | `wp_connect` | You have `posture` and `fingerprint`. The fingerprint rule is wp-blocks R3, unchanged. |
| 1 | **Read the model** | `wp_manifest {section: "data_model"}` + `{section: "bindings"}` | You know what exists: every post type with its origin (`core`/`plugin`/`agent`), every REST-visible meta key, every binding source. |
| 2 | Design the package | — (you write the scaffold input) | Every registration justified against S2 — extend before you invent. |
| 3 | Scaffold | `wp_schema_scaffold` | The package exists with your `intent` embedded as its implementation contract. |
| 4 | Implement | — (you edit the PHP) | Handlers implement the intent; the scaffold's defaults are a working start, not the finish. |
| 5 | **Build test** | `wp_schema_build_test` | `built: true` — model in `/wp/v2/types`, meta REST-visible, routes answering as declared, uninstall clean. Never skippable. |
| 6 | Install | `wp_schema_install` | Returns a NEW fingerprint. Use it in the very next tree. |
| 7 | Build the views | → **wp-blocks** | Blocks (and bindings) display the model. The package holds the data; blocks never do. |

## 2. The eight rules

### S1 — Model before UI. Post types, taxonomies, meta and routes are designed and installed BEFORE the blocks that render them. The data model is the source of truth; blocks are views.

Same ordering principle as wp-blocks R9 (tokens before layout): decide what an
*order* / *booking* / *entry* is — its fields, its statuses, who writes it and who reads
it — install that, and only then build the form and the displays. A block designed first
tends to embed storage decisions that turn out wrong.

The URL map is part of the model. A public post type claims `/{rewrite_slug}/…` on the
site (default: its own slug), and `has_archive` decides whether that path itself lists
entries. Decide both in the scaffold input — the scaffold checks them against the
instance's existing page and post slugs and returns `warnings[]` on a collision, which
costs nothing now and a full rebuild-and-republish cycle after publish.

### S2 — Read the model first; extend before you invent. `wp_manifest {section: "data_model"}` at the current fingerprint, always. Do not register a parallel model beside an existing one.

If the instance already has an `event` post type, your ticketing feature extends it (a meta
key, a taxonomy term, a status) rather than adding a second event type. The `source` field
tells you where each model came from: `core`, `plugin`, or `agent` (an earlier package —
version it, do not duplicate it).

### S3 — Everything REST-visible. No meta without `show_in_rest` and a schema; no post type the agent cannot read back through `/wp/v2`. If it does not appear in the manifest afterwards, it does not exist.

This is enforced three times: the scaffold only generates REST-visible meta, the build test
fails naming any key that is not (`meta "hc_order:pickup_day" not REST-visible`), and the
companion's installer scans again. The scaffold also forces `custom-fields` into the post
type's `supports` whenever meta is declared — without it WordPress never puts registered
meta on the REST post object, no matter how the meta itself was registered. Meta that is not REST-visible is invisible to bindings,
to the manifest, and therefore to every future session — private state instead of a model.

### S4 — Bindings over bespoke rendering. When a core block plus a binding to registered meta can display the data, that beats a custom block. Check `wp_manifest {section: "bindings"}` before building a block that merely displays a field.

A paragraph bound to `pickup_day` needs zero new code:

```jsonc
{ "name": "core/paragraph",
  "attributes": { "metadata": { "bindings": {
    "content": { "source": "agent-orders/pickup-day", "args": {} } } } } }
```

The validator enforces this: an unregistered source is `E_BINDING_UNKNOWN` (error), a
non-bindable attribute is `E_BINDING_UNBINDABLE`. Core binds paragraph/heading `content`,
image `id/url/title/alt`, button `url/text/linkTarget/rel` — read
`bindings.bindable_attributes`, never assume.

### S5 — The build test is not skippable. scaffold → implement → `wp_schema_build_test` green → `wp_schema_install` → use the new fingerprint in the very next tree.

The build test boots a throwaway WordPress and checks the whole model: every declared post
type in `/wp/v2/types`, every meta key in the REST surface, taxonomies registered, every
route dispatched live (2xx for a valid nonce'd call, 401/403 for an unauthenticated
protected one), every binding source resolvable, and — after deactivation, in a fresh
request — **nothing left registered**. Before any of that, a static policy scan rejects
`$wpdb`, `eval`, `exec` and similar outright (`schema_policy`, with file and line). A
failure returns structured detail and **no zip**; `wp_schema_install` accepts nothing but
the zip this test produces.

### S6 — Anonymous write flows go through a package route: REST nonce + honeypot + server-side validation + a moderated status. Never comments, options or transients.

The scaffold's `auth: "public-nonce"` route already has the right shape: nonce verified in
the handler, honeypot checked, inputs sanitized, the entry created `pending` so nothing
publicly submitted is publicly visible by default. `auth: "capability"` routes name their
capability in `permission_callback`. The build test exercises both paths — including that
the protected route answers 401/403 to an unauthenticated caller.

### S7 — A schema package is owned code with an uninstall story. State that cost when you create one, exactly as wp-blocks R7 requires for blocks.

Registrations disappear with the code (the build test proves this with a post-uninstall
diff); stored content survives unless the site owner opts into
`X_AGENT_SCHEMA_UNINSTALL_CONTENT`. Version bumps reinstall over the previous copy
(`replaced_previous: true`) — identical registrations keep the fingerprint, changed ones
move it, which is the fingerprint doing its job.

### S8 — Posture: `POST /schema/install` is an extend-tier route and is refused on production (`posture_forbidden`, before the body is parsed). Snapshot → sandbox → promote. Do not try to bypass this.

Same rule and same answer as wp-blocks R8. Build on a toolchain sandbox, verify with the
build test, then promote the artifact — production receives finished artifacts, never
toolchain operations.

---

## 3. Worked example — an ordering system

> *"Add a simple ordering system to the bakery site — order for pickup, pay at the counter."*
> Instance: toolchain posture. (This exact flow is proof scenario P16; the transcripts below
> are its recorded values.)

**Step 1 — read the model.** `wp_manifest {section: "data_model"}` shows `post`, `page` —
nothing order-shaped, no prior `agent` package. `section: "bindings"` shows `core/post-meta`
registered. The model is genuinely missing; S2 is satisfied; this needs a package, not a
workaround in a block.

**Step 2+3 — design and scaffold.** An order is: what, when, who — plus a staff lifecycle.

```jsonc
→ wp_schema_scaffold {
    "slug": "orders",
    "intent": "Pickup orders for a bakery: customers submit through a public form, staff work orders through pending -> ready -> picked-up in the standard admin list.",
    "post_types": [{
      "slug": "hc-order", "label": "Orders",
      "meta": [ { "key": "pickup_day", "type": "string" },
                { "key": "contact",    "type": "string" } ],
      "statuses": [ { "slug": "ready", "label": "Ready" },
                    { "slug": "picked-up", "label": "Picked up" } ] }],
    "routes": [ { "path": "/submit", "methods": ["POST"], "auth": "public-nonce" },
                { "path": "/orders", "methods": ["GET"], "auth": "capability", "capability": "edit_posts" } ],
    "bindings": [ { "name": "pickup-day", "meta_key": "pickup_day", "label": "Pickup day" } ] }

← { "dir": "…/orders", "slug": "orders",
    "files": ["orders.php", "routes.php", "schema.json", "uninstall.php"] }
```

**Step 4 — implement.** The scaffolded `/submit` handler already verifies the nonce and
honeypot and creates a `pending` `hc_order`; extend it against the intent (quantities,
validation messages). The admin list already shows `pickup_day` and `contact` columns —
the post type's standard admin UI is the order inbox, no custom admin screens.

**Step 5 — build test.**

```jsonc
→ wp_schema_build_test { "dir": "…/orders" }
← { "built": true,
    "smoke": {
      "types_registered": { "hc_order": true },
      "meta_in_rest": { "hc_order:pickup_day": true, "hc_order:contact": true },
      "routes": [ { "path": "/submit", "method": "POST", "status": 200, "ok": true },
                  { "path": "/orders", "method": "GET", "status": 200, "unauth_status": 401, "ok": true } ],
      "bindings_registered": { "agent-orders/pickup-day": true },
      "uninstall_clean": true },
    "zip_path": "…/agent-schema-orders-1.0.0.zip" }
```

Failure messages are specific: strip `show_in_rest` from `pickup_day` and the test answers
`meta "hc_order:pickup_day" not REST-visible (show_in_rest with a schema is policy)`;
add a `$wpdb` call and it answers `schema_policy: routes.php:73 — direct $wpdb use` before
any sandbox boots. No zip either way.

**Step 6 — install. The fingerprint changes because the install changed the instance.**

```jsonc
→ wp_schema_install { "zip_path": "…/agent-schema-orders-1.0.0.zip" }
← { "installed": { "slug": "orders", "version": "1.0.0" },
    "fingerprint": "b09c47b7e68d…",   // NEW — use it in the very next tree
    "replaced_previous": false }

→ wp_manifest { "section": "data_model" }
← { "data_model": { "post_types": [ …,
      { "slug": "hc_order", "label": "Orders", "show_in_rest": true, "rest_base": "hc_order",
        "meta_keys": ["contact", "pickup_day"], "source": "agent" } ] } }
```

**Step 7 — the views (wp-blocks territory).** The form block is now thin: `wp_block_scaffold`
with `interactivity: "view-script"` — `view.js` collects the fields and POSTs
`{_wpnonce, pickup_day, contact, …}` to `/agent-orders/v1/submit`; render.php stays a plain
form that works without JS. Displays bind instead of render: the paragraph bound to
`agent-orders/pickup-day` from S4. Verified live:

```
anonymous nonce'd submit          → 200 {"created": 5}
the same call without a nonce     → 403
GET /wp/v2/hc_order/5 (as staff)  → status "pending", meta.pickup_day "Saturday"
comments created by the flow      → ZERO
```

That last line matters. An earlier version of this feature, built without a schema package,
stored orders as pending comments — a usable inbox, but unstructured records in a screen
whose "Approve" button means *publish*. The missing piece was the data model, and a schema
package is how one is added.

---

## 4. When something fails

| code | what happened | what to do |
|---|---|---|
| `schema_policy` | the static scan (build test) or the companion installer (422, `reasons[]`) found forbidden code | Remove the `$wpdb`/`eval`/`exec`; registrations go through core APIs, always. |
| `smoke_failed` | the sandbox disproved a declaration; the message names each one | Fix the named registration/route and rerun. Nothing was sent anywhere. |
| `posture_forbidden` | `/schema/install` on a production instance | S8: snapshot → sandbox → promote. Do not try to bypass it. |
| `E_BINDING_UNKNOWN` / `E_BINDING_UNBINDABLE` | a tree binds to a source that does not exist / an attribute that cannot bind | Read `wp_manifest {section: "bindings"}`; install the package that provides the source first. |
| `epoch_mismatch` | the fingerprint moved (often: *you* just installed a package) | `wp_manifest {refresh: true}`, regenerate with the new fingerprint — wp-blocks R3, unchanged. |
