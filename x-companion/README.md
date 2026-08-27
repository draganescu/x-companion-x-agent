# `x-companion`

A WordPress plugin that turns a live instance into a **machine-readable, ground-truth target** for
agents that build block layouts.

It publishes what *this specific site* can do — its real block registry with verbatim attribute
schemas, its resolved theme tokens, its registered patterns — validates JSON block trees against
that registry, and hosts a browser harness that compiles those trees into canonical markup using
each block's own JavaScript `save()`. It also runs a small managed library for agent-authored
**dynamic** blocks.

It never authors content, never stores a credential, and never phones home.

The counterpart is [`x-agent`](../x-agent/README.md), a Claude Code plugin that holds the
credentials and supplies all the compute. The wire between them is frozen:
[`contract/CONTRACT.md`](../contract/CONTRACT.md).

---

## Requirements

| | |
|---|---|
| PHP | **8.1+** |
| WordPress | **6.5+** |
| Transport | **HTTPS** in anything that is not a loopback sandbox — WordPress refuses to issue or accept Application Passwords over plain HTTP |
| Dependencies | none. No Composer, no build step, no external service |

---

## Install

1. Copy the `x-companion` directory into `wp-content/plugins/`, or zip it and use
   **Plugins → Add New → Upload Plugin**.
2. Activate it. Activation creates the `x_agent` role and grants the three capabilities to
   administrators.
3. **Decide the posture** (next section) before you point anything at it. The default is the safe
   one.
4. Create the agent user and its Application Password — see [Auth](#auth).

Check it is alive:

```bash
curl -u "x_agent:xxxx xxxx xxxx xxxx xxxx xxxx" \
     https://example.com/wp-json/x-companion/v1/fingerprint
# {"fingerprint":"<64 hex>","posture":"production","interfaces_version":"1"}
```

If your site is on plain permalinks, `/wp-json/...` will not resolve; use
`https://example.com/?rest_route=/x-companion/v1/fingerprint`. Clients are required to probe
pretty first and fall back, so this only matters when you are testing by hand.

For a throwaway instance with no Docker, see [`tools/README.md`](../tools/README.md) —
`@wp-playground/cli` boots WordPress with this plugin mounted live in about ten seconds.

---

## Postures

The `X_COMPANION_POSTURE` constant decides how much of this plugin exists. It is the single most
important thing to get right.

| posture | meaning | tiers |
|---|---|---|
| `toolchain` | A disposable sandbox — Playground, Studio, `wp-env`, a scratch site. Its only job is to be a fidelity target, and it is deleted afterwards. | introspect + author + **extend** |
| `production` | A live brownfield site. | introspect + author only |

```php
// wp-config.php, above the /* That's all, stop editing! */ line
define( 'X_COMPANION_POSTURE', 'toolchain' );
```

**Undefined means `production`.** An unrecognised value also means `production`. A plugin that
lands on a live site without anyone thinking about it gets the safe posture, never the permissive
one — `x_companion_posture()` never guesses permissive.

On a `production` instance the extend-tier routes are **hard-disabled in code**:

- `POST /blocks/install`, `GET /blocks/library`, `POST /blocks/library/{slug}/rollback`,
  `DELETE /blocks/library/{slug}`, `POST /theme/tokens`, `POST /snapshot/export`
- all answer **403 `posture_forbidden`**, from the `permission_callback`, **before the request body
  is ever parsed**;
- they are also not registered as abilities;
- and the `x_agent` role is not granted `x_companion_extend` at all.

Administrators always hold all three capabilities, but the route-level posture gate still applies
to them. There is no header, no query parameter and no user role that lifts it.

Changing the constant is enough: the plugin stores the posture its role grant was built for and
re-syncs the `x_agent` role on the next request when it no longer matches.

**The intended workflow for structural work on a production site** is not to flip the constant. It
is: `POST /snapshot/export` from production → boot a `toolchain` sandbox from the snapshot → do the
block installs and token writes there → promote the resulting artifacts. The gate exists so that
step is the easy one.

---

## Auth

HTTP Basic with a **WordPress Application Password**, sent on **every** request including
`GET /harness`. No cookies, no nonces, no OAuth, no relay. This plugin stores no credential of any
kind; WordPress verifies the password and the secret lives only on the client machine.

### Create the `x_agent` user

Use a dedicated user, not your own administrator account. It is created with only the capabilities
the contract needs, so a leaked password cannot publish, delete or install anything outside the
block library.

**WP-CLI:**

```bash
wp user create x_agent agent@example.com --role=x_agent --display_name="X Agent"
```

**Admin UI:** **Users → Add New**. Set the role to **X Agent** — the role the plugin registered on
activation. If it is not in the dropdown, the plugin is not active.

The role holds `read`, `x_companion_read` and `x_companion_author`; it additionally holds
`x_companion_extend` **only** when the posture is `toolchain`.

### Create the Application Password

**WP-CLI:**

```bash
wp user application-password create x_agent "x-agent MCP" --porcelain
# xxxx xxxx xxxx xxxx xxxx xxxx      <- shown once, never again
```

**Admin UI:** **Users → X Agent → Application Passwords**, name it `x-agent MCP`, press
**Add New Application Password**, copy the value immediately.

The plaintext is displayed exactly once. Spaces are cosmetic — WordPress strips them — but it is
simplest to keep the string exactly as WordPress printed it.

### Hand it to the client

On the machine running `x-agent`, either write `.x-agent.json` in the working directory:

```json
{
  "url": "https://example.com",
  "user": "x_agent",
  "app_password": "xxxx xxxx xxxx xxxx xxxx xxxx"
}
```

```bash
chmod 600 .x-agent.json     # and keep it out of version control
```

…or export `X_WP_URL`, `X_WP_USER`, `X_WP_APP_PASSWORD`. Full precedence rules are in the
[`x-agent` README](../x-agent/README.md).

### Revoking

Delete the application password from the user's profile (or
`wp user application-password delete x_agent --all`). It takes effect immediately; nothing is
cached. Application passwords are per-application by design — revoke one client without touching
any other.

### Troubleshooting

| symptom | cause |
|---|---|
| `401 rest_forbidden` | Wrong user or password, or the `Authorization` header is being stripped. Some Apache configurations drop it; add `SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1`. |
| Application Passwords section missing from the profile | The site is not on HTTPS. `wp_is_application_passwords_supported()` is `is_ssl()`. |
| `403 rest_forbidden_capability` | The user authenticated but lacks the tier capability. Check the role really is `x_agent`. |
| `403 posture_forbidden` | The route is extend-tier and the instance is `production`. Working as designed — see [Postures](#postures). |

---

## Contract v1

The wire format is normative and frozen, and lives in **[`contract/CONTRACT.md`](../contract/CONTRACT.md)**.
Read it before writing a client. Summary only:

- `interfaces.version` = `"1"`, REST namespace `x-companion/v1`.
- Base URL `{site_url}/wp-json/x-companion/v1`, or `?rest_route=` on plain permalinks. Clients must
  support both.
- Shared JSON Schemas (`TreeIR`, `Diagnostics`, `Manifest`, `DesignTokens`) are authored once in
  `contract/schemas/` and vendored byte-identically into `x-companion/fixtures/schemas/` and
  `x-agent/schemas/`.
- `POST /theme/tokens` optionally accepts `styles.background` (x-surfaces: the page canvas —
  a media-library background image written into global styles, WP ≥ 6.6, admin-undoable in the
  Styles UI); capability is probed via `features.global_styles_background`, never assumed.

| tier | capability | routes |
|---|---|---|
| introspect | `x_companion_read` | `GET /manifest`, `GET /fingerprint`, `GET /patterns`, `GET /harness`, `POST /validate`, `POST /parse`, `POST /render` |
| author | `x_companion_author` | *(reserved — no v1 routes; this plugin authors no content)* |
| extend | `x_companion_extend` | `POST /blocks/install`, `GET /blocks/library`, `POST /blocks/library/{slug}/rollback`, `DELETE /blocks/library/{slug}`, `POST /theme/tokens`, `POST /snapshot/export` |

Order inside every handler, no exceptions: **capability check → input schema validation → work.**

Every non-2xx is a standard `WP_Error` body:
`{"code": "...", "message": "...", "data": {"status": 403}}`. The pinned codes are
`rest_forbidden`, `rest_forbidden_capability`, `posture_forbidden`, `rest_invalid_param`,
`block_policy`, `in_use`, `not_found`, `no_previous`.

**The fingerprint is the epoch.** It is a SHA-256 over the canonical JSON of the block registry,
the theme and the active plugins. Clients treat it as opaque: `GET /fingerprint` is cheap and is
called before every batch. Every `TreeIR` carries the epoch it was generated against;
`POST /validate` emits `E_EPOCH_MISMATCH` on `/epoch` when it is stale — **and still runs every
other check**, so one stale round trip is never wasted.

**Block install policy** (all violations → 422 `block_policy` with `data.reasons[]`): one
top-level directory with `block.json` at the block root; `name` matching `^agent/[a-z0-9-]+$`;
a `render` entry pointing at a file that exists in the zip; no `../` or absolute paths; ≤ 5 MB;
every file referenced by `block.json` present. Validation is **structural only** — there is no
`php -l` and no `exec` here. The real safety gate is on the agent side, which smoke-tests every
block in a local Playground before it is ever POSTed.

---

## Harness fallback

`GET /harness` serves a minimal HTML page — no theme, no admin chrome — that boots the real block
registry in a browser and exposes `window.__compile()`. That is how a JSON tree becomes canonical
markup: the block's own `save()` produces it.

For this to work, every block must **register itself client-side on that page**. The harness
bootstraps server-side block settings exactly as core's editor does, enqueues `wp-blocks`,
`wp-block-library`, `wp-element`, `wp-data`, `wp-dom-ready` and `wp-i18n`, then enqueues every
handle in each block type's `editor_script_handles`, fires `enqueue_block_editor_assets` inside a
shutdown guard, and loads `harness/harness.js` last.

**Some blocks still do not register**, and there are two distinct reasons.

### 1. Suites that gate script registration on `is_admin()`

Measured against Kadence Blocks 3.7.9.1: its editor script handles are declared by the block types
but only *registered* from an `init` callback beginning `if ( ! is_admin() ) return;`. A REST
request is not admin, so the handles do not exist when the harness route runs, and all 59 Kadence
blocks are absent from `wp.blocks.getBlockTypes()`.

This is a **server-side** gate, so the plugin fixes it server-side: for the harness request only,
it defines `WP_ADMIN` before `init` fires. `is_admin()` becomes true, the suite registers its
handles, and the harness finds them. Nothing else of the admin bootstrap runs — `admin_init` is
fired by `wp-admin/admin.php`, which is not in play — so the blast radius is exactly "plugins that
ask `is_admin()`", on a route whose entire purpose is to be the editor minus the editor.

**Default: on in `toolchain` posture, off in `production`.** Override explicitly:

```php
define( 'X_COMPANION_HARNESS_ADMIN_CONTEXT', false );   // or true
```

Measured effect on a `core-plus-suite` sandbox: **176** blocks in `window.__registry()` with it on,
against a manifest of 175; measured without it, 113 — every Kadence tree fails to compile.

If a suite registers its blocks from some handle other than `editor_script_handles`, add it:

```php
add_filter(
	'x_companion_harness_block_handles',
	function ( array $handles, WP_Block_Type $type ): array {
		if ( str_starts_with( $type->name, 'mysuite/' ) ) {
			$handles[] = 'mysuite-blocks-editor';
		}
		return $handles;
	},
	10,
	2
);
```

### 2. Blocks that need the full editor — the editor-injection fallback

Some blocks cannot register anywhere but a real editor. On every instance measured, including bare
core, three are permanently in this class: `core/legacy-widget`, `core/post-comments`,
`core/widget-group`.

**Detection is always on.** The client diffs `window.__registry()` against `manifest.blocks` and
reports the difference as `registry_gaps` on every compile. If a tree actually *uses* a gapped
block, `wp_compile` fails with a structured `harness_gap` error instead of compiling something
wrong. This matters more than it sounds: `wp.blocks.createBlock()` on an unregistered name yields
nothing to serialize, so an unguarded compile returns *valid, silently empty* markup. Refusing is
strictly better.

**The documented fallback** (contract §6) is to load `wp-admin/post-new.php` in Playwright and
inject `harness.js` into the editor iframe — the real editor loads every block's editor script by
construction. It is implemented on the agent side and **default off**, behind
`X_AGENT_HARNESS_FALLBACK=1`.

It is off by default for a reason you hit immediately if you turn it on: WordPress core refuses
Application Password authentication for non-API requests
(`wp_validate_application_password()` bails unless `application_password_is_api_request` says
otherwise), so `wp-admin` redirects to `wp-login.php` regardless of how correct the Basic header
is. The fallback therefore needs a real cookie session, supplied as a pre-recorded Playwright
storage state in `X_AGENT_STORAGE_STATE`. It will never ask for an account password.

The harness also guards `enqueue_block_editor_assets`: if a plugin fatals inside that action, the
page is served **without** it and carries the response header
`X-Harness-Degraded: enqueue_block_editor_assets`. A degraded harness still compiles core blocks;
treat the header as a warning that `registry_gaps` is about to be larger than usual.

---

## Uninstall

Deleting the plugin through WordPress runs `uninstall.php`, which does exactly this — verified
against the file:

**Removed**

- the `x_agent` role (`remove_role`);
- the capabilities `x_companion_read`, `x_companion_author` and `x_companion_extend` from **every
  role that holds them** — not only `administrator`, so a custom role that was granted one is
  cleaned too;
- the options `x_companion_caps_posture` and `x_companion_manifest_cache_key`;
- every `_transient_x_companion_*` and `_transient_timeout_x_companion_*` option (manifest caches
  are keyed by fingerprint, so the prefix is swept rather than named), and the site-transient
  equivalents on multisite.

**Deliberately left in place**

> ⚠️ **Installed agent packages are not deleted.** They are standard, independently activated
> plugins under `wp-content/plugins/` (`agent-block-*`, `agent-schema-*`) and keep running
> after x-companion is uninstalled, exactly like any other plugin.

That is not an oversight. Published content may still contain `<!-- wp:agent/... -->` delimiters,
and deleting the block that renders them turns those posts into "This block has encountered an
error" — permanently, and with no undo. Removing a package has to be a deliberate act.

To remove packages properly, **before** deleting the plugin:

1. `GET /blocks/library` to list what is installed.
2. `DELETE /blocks/library/{slug}` for each. That route refuses with **409 `in_use`** and
   `data.posts: [ids]` when published content still references the block — which is the check you
   want.
3. Edit or remove the referencing posts, then delete again.

After x-companion is gone, every agent package is still a normal row in plugins.php: deactivate
and delete it there, like any plugin — a schema package's own `uninstall.php` runs on delete,
exactly as WordPress intends.

Users created for the agent are **not** deleted either — WordPress never deletes users on plugin
uninstall, and their application passwords go with them. Delete the `x_agent` user yourself if you
are done with it.

---

## Constants

All are optional; every one has a safe default.

| constant | default | effect |
|---|---|---|
| `X_COMPANION_POSTURE` | `'production'` | `'toolchain'` \| `'production'`. See [Postures](#postures). Anything unrecognised is treated as `production`. |
| `X_COMPANION_ALLOW_STATIC_BLOCKS` | `false` | When false, `POST /blocks/install` rejects any package whose `block.json` has no `render` entry (422 `block_policy`). Dynamic-by-default is a hard rule: a static block freezes its `save()` output into post content and breaks that content on every iteration. |
| `X_COMPANION_HARNESS_ADMIN_CONTEXT` | posture-dependent (`true` on `toolchain`, `false` on `production`) | Whether `GET /harness` presents itself as an editor request. See [Harness fallback](#harness-fallback). |

Defined by the plugin, read-only, listed so you do not collide with them: `X_COMPANION_VERSION`,
`X_COMPANION_FILE`, `X_COMPANION_DIR`, `X_COMPANION_URL`, `X_COMPANION_REST_NAMESPACE`
(`x-companion/v1`), `X_COMPANION_INTERFACES_VERSION` (`1`), `X_COMPANION_ROLE` (`x_agent`),
`X_COMPANION_CAPS_OPTION`.

---

## The `x_companion_agent_hints` filter

The registry is a good description of a block's *shape* and a poor description of how it is meant
to be *used*. "This container only makes sense with these children", "do not add inner blocks to
this", "here is a set of attribute values that actually works" — none of that is machine-visible.

This filter is how a block author declares it, and the hints are merged into the manifest per
block, so every client sees them before generating anything.

```php
apply_filters( 'x_companion_agent_hints', array $hints, string $block_name, ?WP_Block_Type $type )
```

`$hints` keys, all optional:

| key | type | meaning |
|---|---|---|
| `allowed_blocks` | `string[]` \| `null` | Children that make sense inside this block. A tree that puts something else inside gets a `W_HINT_ALLOWED_BLOCKS` warning. |
| `template_lock` | `'all'` \| `'insert'` \| `'contentOnly'` \| `false` \| `null` | With `all` or `insert`, a tree that adds children gets `W_HINT_TEMPLATE_LOCK`. |
| `usage_notes` | `string` | Free text, read by the agent. Say the non-obvious thing. |
| `example_attributes` | `array` | A known-good attribute set. Cheap and effective — agents copy it. |

Copy-paste this into a plugin or `functions.php`:

```php
/**
 * Tell block-generating agents how to use acme/pricing-table.
 *
 * @param array              $hints      Existing hints.
 * @param string             $block_name Block being described.
 * @param WP_Block_Type|null $type       The live block type, when available.
 * @return array
 */
function acme_agent_hints( array $hints, string $block_name, $type ): array {
	if ( 'acme/pricing-table' === $block_name ) {
		$hints['allowed_blocks']     = array( 'acme/pricing-tier' );
		$hints['template_lock']      = 'insert';
		$hints['usage_notes']        = 'Exactly three tiers renders correctly; more overflows the grid. '
			. 'Set `featured` on at most one tier. Currency is taken from site options, not from an attribute.';
		$hints['example_attributes'] = array(
			'columns'  => 3,
			'featured' => 'middle',
			'interval' => 'monthly',
		);
	}

	return $hints;
}
add_filter( 'x_companion_agent_hints', 'acme_agent_hints', 10, 3 );
```

Hints appear on the block's manifest entry only when they differ from the defaults, so a site with
no hints pays nothing:

```json
"acme/pricing-table": {
  "title": "Pricing table",
  "attributes": { "…": "…" },
  "agent_hints": {
    "allowed_blocks": ["acme/pricing-tier"],
    "template_lock": "insert",
    "usage_notes": "Exactly three tiers renders correctly; …",
    "example_attributes": { "columns": 3, "featured": "middle", "interval": "monthly" }
  }
}
```

`$type` is the live `WP_Block_Type` when one is available and `null` when the manifest is being
built offline from a registry snapshot — always null-check it.

### Other filters

| filter | default | use |
|---|---|---|
| `x_companion_block_namespace` | `'agent'` | The namespace an installable block must declare in `block.json`. |
| `x_companion_harness_block_handles` | `editor_script_handles` | Extra script handles the harness should enqueue for a block type. |
| `x_companion_harness_admin_context` | posture-dependent | Whether the harness request enters admin context. Only mu-plugins and plugins loading before priority 5 on `plugins_loaded` can usefully hook it; the constant is the supported switch. |
| `x_companion_token_adapters` | built-in adapters | The suite adapter classes `POST /theme/tokens` runs. |
| `x_companion_write_theme_json_file` | `false` | Also rewrite the active theme's `theme.json` file. Off by default: the primary write path is the user-origin global styles CPT, which works on read-only theme directories and survives theme updates. |
| `x_companion_abilities` | built-in set | The abilities registered when the WordPress Abilities API is present. |

---

## Development

```bash
# boot a real WordPress with this plugin mounted live (no Docker)
node tools/playground/boot.mjs --profile core-plus-suite --posture toolchain --plugin ./x-companion --json

# talk to it
node tools/wpcall.mjs --profile core-plus-suite --posture toolchain --as agent GET /x-companion/v1/manifest

# the plugin's own tests
bash x-companion/tests/run-all.sh

# WordPress Plugin Check, inside a throwaway Playground sandbox
bash x-companion/bin/plugin-check.sh
```

`bin/plugin-check.sh` boots a Playground site, installs `plugin-check` from wordpress.org, mounts
this directory, and runs the real `wp plugin check x-companion` inside it. It scans the
distribution surface by default (excluding `tests`, `bin`, `fixtures`); pass `--include-dev` to
scan everything, or `-- <flags>` to forward options to the WP-CLI command. Exit code 1 means at
least one ERROR-severity finding.

Mounted plugin directories are live: edit a PHP file and the next request sees it. See
[`tools/README.md`](../tools/README.md).

## Licence

GPL-2.0-or-later.
