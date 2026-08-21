=== X Companion ===
Contributors: xcontract
Tags: block editor, gutenberg, patterns, rest api, developer
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 8.1
Stable tag: 1.0.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Turns this site into a machine-readable, ground-truth target for agents that build block layouts.

== Description ==

X Companion publishes what this specific WordPress instance can actually do, so that a
code-generating agent stops guessing at "what WordPress has" and starts reading the truth.

It serves four things over the `x-companion/v1` REST namespace:

* **A manifest.** Every registered block with its verbatim attribute schema, supports, parent
  and ancestor constraints; the resolved theme tokens; the registered patterns; the active
  suites. All of it stamped with a `fingerprint` — an epoch that changes when the site's
  vocabulary changes.
* **A validator.** `POST /validate` takes a JSON block tree (Tree IR) and returns structured
  diagnostics: unknown blocks, attribute type and enum violations, illegal nesting, stale epoch.
* **A harness.** A minimal page that boots the real block registry in a browser, so a client can
  compile a JSON tree into canonical markup using each block's own JavaScript `save()` function
  instead of hand-writing block delimiters.
* **A block library.** An extend-tier route that installs agent-authored *dynamic* blocks into
  `wp-content/uploads/x-agent-blocks/`, with single-level rollback.

The plugin never authors content and never phones home. It stores no credentials: authentication
is HTTP Basic with a standard WordPress Application Password, held by the client.

= Postures =

The `X_COMPANION_POSTURE` constant decides how much of the plugin exists:

* `toolchain` — a disposable sandbox. All tiers enabled.
* `production` — a live site. Introspect and author tiers only; the extend tier (block install,
  theme token writes, snapshot export) is refused in code with a 403 `posture_forbidden`, not
  merely hidden from the UI.

**The default when the constant is undefined is `production`.** A plugin that lands on a live
site without anyone thinking about it gets the safe posture.

= Companion client =

The counterpart is `x-agent`, a Claude Code plugin (a skill plus a local MCP server) that holds
the credentials, drives the harness in a warm headless browser, verifies layout geometry
numerically, and builds new dynamic blocks in a local sandbox before installing them here.

== Installation ==

1. Upload the `x-companion` directory to `wp-content/plugins/`, or install the zip through
   **Plugins → Add New → Upload Plugin**.
2. Activate the plugin. Activation creates the `x_agent` role and grants the three capabilities
   to administrators.
3. On a sandbox, set the posture in `wp-config.php` **above** the `/* That's all, stop editing! */`
   line:

   `define( 'X_COMPANION_POSTURE', 'toolchain' );`

4. Create a dedicated `x_agent` user and an Application Password for it, and give the pair to the
   client. See the plugin's `README.md` for the exact steps.

Requires HTTPS in production: an Application Password is a bearer-equivalent credential and
WordPress will not issue or accept one over plain HTTP.

== Frequently Asked Questions ==

= Does this plugin store my credentials? =

No. It has no credential storage, no OAuth server and no relay. Authentication is WordPress
Application Passwords, verified by WordPress itself, and the secret lives only on the client
machine.

= Can it write to my production site? =

Only if you deliberately set `X_COMPANION_POSTURE` to `toolchain`. With the default posture the
extend-tier routes answer 403 `posture_forbidden` before the request body is ever parsed.

= Why does it refuse static blocks? =

A static block freezes its `save()` output into post content. Change the block and every post
that used it becomes invalid. Installed agent blocks must therefore be dynamic — they render at
request time. The `X_COMPANION_ALLOW_STATIC_BLOCKS` constant exists to lift that rule, and
defaults to `false`.

= What happens when I uninstall it? =

The `x_agent` role, the three capabilities and the plugin's options and transients are removed.
Blocks previously installed into `wp-content/uploads/x-agent-blocks/` are deliberately left in
place, because published content may still reference them.

== Changelog ==

= 1.0.0 =
* Initial release. Contract v1: manifest, fingerprint, validate, parse, render, patterns,
  harness, block library, theme tokens, snapshot export.
