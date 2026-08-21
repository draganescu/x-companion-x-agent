# `tools/` — live test infrastructure

Boots a **real WordPress** for the `x-companion` plugin and the `x-agent` MCP server,
with **no Docker**. Everything runs on [WordPress Playground](https://developer.wordpress.org/playground/)
(PHP compiled to WebAssembly, SQLite, an Express server in front). One `npm install`,
no daemons, no containers.

```
tools/
  playground/
    boot.mjs                 boot an instance, provision auth, print the runtime JSON
    stop.mjs                 stop instances started by boot.mjs
    blueprints/
      core-only.json         WP latest + Twenty Twenty-Five, no extra plugins
      core-plus-suite.json   the above + Kadence Blocks (free, wordpress.org), active
  lib/rest-client.mjs        shared REST client (pretty -> ?rest_route= fallback)
  wpcall.mjs                 authenticated REST client for the shell and for tests
  .runtime/                  generated: runtime JSON, pid files, logs, site dirs (gitignored)
```

Setup, once:

```bash
cd tools && npm install
```

---

## Booting

```bash
# core-only, toolchain posture, with the companion plugin mounted live
node tools/playground/boot.mjs --profile core-only --posture toolchain \
     --port 9400 --plugin ./x-companion --json

# the same site in production posture (extend-tier routes must answer posture_forbidden)
node tools/playground/boot.mjs --profile core-only --posture production \
     --plugin ./x-companion --json

# WP latest + Kadence Blocks active
node tools/playground/boot.mjs --profile core-plus-suite --posture toolchain \
     --plugin ./x-companion --json

# stop them
node tools/playground/stop.mjs --profile core-only --posture toolchain
node tools/playground/stop.mjs --all
node tools/playground/stop.mjs --port 9402
```

`boot.mjs` detaches by default: it returns as soon as the instance is serving and
leaves the server running in a background process. Use `--foreground` to keep it in
the current process (Ctrl-C stops it).

Boot cost, measured on this machine: **~10 s** for `core-only`, **~14 s** for
`core-plus-suite` (Kadence is downloaded from wordpress.org), **~2 s** for a
`--persist` re-boot of an existing site directory.

### Options

| flag | meaning |
|---|---|
| `--profile <id>` | `core-only` \| `core-plus-suite` (default `core-only`) |
| `--posture <p>` | `toolchain` \| `production` (default `toolchain`) |
| `--port <n>` | default is deterministic per profile+posture: 9400 / 9401 / 9402 / 9403, then the first free port up to 9450 |
| `--plugin <dir>` | mount a plugin directory **live** and activate it. Repeatable. |
| `--mu-plugin <path>` | a directory (mounted live) or a single `.php` file (copied). Repeatable. |
| `--persist` | keep the site directory and its database between runs |
| `--permalinks pretty\|plain` | force the permalink mode (default: whatever Playground booted with, which is pretty) |
| `--php <v>` / `--wp <v>` | default `8.3` / `latest` |
| `--timeout <ms>` | default `180000` |
| `--foreground` | run the server in this process |
| `--json` | print the runtime descriptor (**includes the app passwords**) |

### Default ports

| profile | toolchain | production |
|---|---|---|
| `core-only` | 9400 | 9401 |
| `core-plus-suite` | 9402 | 9403 |

Two instances of the *same* profile+posture cannot run at once; `boot.mjs` refuses
rather than trampling the bookkeeping.

### The runtime descriptor

`--json` prints exactly this, and the same bytes are written to
`tools/.runtime/<profile>-<posture>.json` (mode `0600`):

```json
{
  "url": "http://127.0.0.1:9400",
  "admin": { "user": "x_admin", "app_password": "...", "login_pass": "..." },
  "agent": { "user": "x_agent_user", "app_password": "...", "login_pass": "...", "role": "x_agent" },
  "posture": "toolchain",
  "profile": "core-only",
  "wp_version": "7.1",
  "pid": 30580,
  "siteDir": "/…/tools/.runtime/sites/core-only-toolchain"
}
```

`agent.role` is `x_agent` when the companion plugin has registered that role, and
`subscriber` otherwise — `boot.mjs` prints a `[boot] NOTE:` to stderr when it falls
back, because capability-gating proofs are meaningless against a plain subscriber.

Alongside it, `tools/.runtime/` holds `<key>.pid` and `<key>.log` (the detached
process's stdout+stderr — read this first when a boot fails).

---

## Talking to an instance

```bash
node tools/wpcall.mjs --runtime tools/.runtime/core-only-toolchain.json \
     GET /x-companion/v1/fingerprint

# shorthand for the same file
node tools/wpcall.mjs --profile core-only --posture toolchain GET /wp/v2/users/me

# identities and error assertions
node tools/wpcall.mjs --profile core-only --posture toolchain --as agent GET /x-companion/v1/manifest
node tools/wpcall.mjs --profile core-only --posture toolchain --anon --allow-error GET /x-companion/v1/fingerprint

# bodies, uploads, binary responses
node tools/wpcall.mjs --profile … POST /x-companion/v1/validate --body @tree.json
node tools/wpcall.mjs --profile … POST /x-companion/v1/blocks/install --multipart package=@block.zip
node tools/wpcall.mjs --profile … --silent --raw-out snapshot.zip POST /x-companion/v1/snapshot/export
```

- Status line goes to **stderr**, body to **stdout**, so `… | jq` just works.
- Exit code is `1` on HTTP ≥ 400 unless `--allow-error` (proof tests assert 401 / 403 / 422),
  and `2` on bad usage or an unreachable server.
- The application password is **never printed**: every stream is passed through a
  redactor before it is written.
- Routes are probed at `/wp-json/<route>` first and retried at `/?rest_route=<route>`,
  per `contract/CONTRACT.md` §5. The fallback triggers on a 404 that is *not* a
  `rest_*` JSON error, and on a 3xx — a site on plain permalinks canonical-redirects
  `/wp-json/...` (301) rather than 404ing it. Boot with `--permalinks plain` to exercise
  that branch.
- In zsh, quote URLs containing `?`: `curl "$URL/?rest_route=/"`.

---

## Sandbox caveats

### Application Passwords over plain HTTP

WordPress refuses to issue or accept Application Passwords when the request is not
SSL (`wp_is_application_passwords_supported()` is `is_ssl()`). The Playground
instance is plain `http://127.0.0.1:<port>`, so the entire Basic-auth half of the
contract would be untestable.

`boot.mjs` therefore **generates** an mu-plugin into the instance:

```php
add_filter( 'wp_is_application_passwords_available', '__return_true' );
add_filter( 'wp_is_application_passwords_available_for_user', '__return_true' );
```

You never place this file by hand; it is written to
`tools/.runtime/work/<key>/mu-plugins/001-x-app-passwords.php` on every boot and
mounted at `/wordpress/wp-content/mu-plugins`.

**This is sandbox-only.** It exists because the sandbox is an ephemeral loopback
instance with throwaway credentials, on a site that is deleted when you stop it.
Do not carry it into anything reachable from a network: it disables the one check
that stops a bearer-equivalent credential from crossing the wire in clear text.
On a real site, run the companion over HTTPS and leave core's behaviour alone.

Note that the `x-agent` MCP server independently refuses plain `http://` unless the
host is loopback or a Playground host — which is exactly this case.

### Users created on every boot

| user | role | why |
|---|---|---|
| `x_admin` | `administrator` | the happy path; also the only identity that can read `/wp/v2/block-types` |
| `x_agent_user` | `x_agent`, or `subscriber` if that role does not exist | proves capability gating: a user that is authenticated but not privileged |

Both get a freshly minted application password on each boot (previous ones are
deleted first, so a `--persist` site does not accumulate them). The interactive
wp-admin login password is set to the same generated value recorded as
`login_pass` in the runtime descriptor — so `/wp-login.php` is one `jq` away
instead of a dead end. Passwords are
generated inside the sandbox by
`WP_Application_Passwords::create_new_application_password()` and are the only
place the plaintext ever exists.

### Posture injection

`X_COMPANION_POSTURE` is injected **twice**, deliberately:

1. **Primary** — Playground's `php.defineConstant()` (the CLI's `--define` /
   `RunCLIArgs.define`). This runs *before `wp-config.php`*, so the constant is
   already defined when mu-plugins load and when plugins load. Verified: a plugin
   mounted at boot reads the right value at plugin-load time.
2. **Fallback** — a generated mu-plugin `000-x-posture.php` with an
   `if ( ! defined( … ) )` guard. mu-plugins load *after* `wp-config.php` but
   *before* regular plugins, so this is still early enough for a plugin that reads
   the constant at load time. It matters only for code paths that bypass the CLI's
   `--define` (that mechanism is per-process, e.g. a separate `wp-playground-cli php`
   run pointed at the same site directory).

`boot.mjs` asserts, inside the sandbox after boot, that `X_COMPANION_POSTURE` really
is the requested value and refuses to hand back the instance otherwise.

The same plugin can be booted under both postures at once — that is what the
9400/9401 (and 9402/9403) port split is for. `posture_forbidden` proofs need a
production instance running next to a toolchain one.

### How the plugin directory is mounted — edits are live

`--plugin ./x-companion` mounts the **host directory** at
`/wordpress/wp-content/plugins/x-companion`. It is a real filesystem mount, not a
copy: **edit a PHP file on disk and the very next request sees it.** No restart, no
re-sync step, no watcher.

Verified end to end: change a mounted file, re-issue the request, get the new
response.

What this means for plugin authors:

- The plugin's own directory name is the folder name inside `wp-content/plugins`,
  so `x-companion/x-companion.php` is the activation path, exactly as in production.
- The entry file is detected by scanning top-level `.php` files for a
  `Plugin Name:` header, preferring `<dirname>.php`. A directory with no such header
  is a hard boot error, not a silent skip.
- Anything the plugin writes at runtime (e.g. installed agent blocks under
  `wp-content/uploads/x-agent-blocks/`) lands in `siteDir` on the host, where you can
  inspect it.
- `--persist` keeps `siteDir` (and the SQLite database, and the uploads) between
  boots. Without it the site directory is wiped and rebuilt each time — which is the
  right default for a proof suite that must not depend on leftover state.

### `core-plus-suite` never degrades

The blueprint installs Kadence Blocks from wordpress.org with `onError: "throw"`,
and `boot.mjs` additionally asserts after boot that `kadence-blocks/kadence-blocks.php`
is in `active_plugins`. If the download fails — offline, wordpress.org unreachable,
plugin renamed — the boot fails with an actionable message. It will never quietly
hand you a core-only instance wearing a `core-plus-suite` label.

---

## Driving the MCP server without Claude Code

`tools/mcp-bridge.mjs` spawns the built server over stdio and exposes it on local
HTTP, so shell scripts, CI jobs and other agents can call the `wp_*` tools with
nothing but curl — with the same warm browser session and epoch state a real MCP
client would get:

```bash
cd x-agent/mcp && npm install && npm run build     # once
node tools/mcp-bridge.mjs                          # --port 9490, --cwd <dir with .x-agent.json>

curl -s localhost:9490/tools
curl -s -X POST localhost:9490/call -H 'content-type: application/json' \
     -d '{"tool":"wp_connect","args":{}}'
```

Restart the bridge after `npm run build` — the spawned server holds the old code
in memory.

## Pointing the `x-agent` MCP server at a booted instance

`x-agent` resolves its connection from, in order: tool arguments, `.x-agent.json` in
the working directory, then `X_WP_URL` / `X_WP_USER` / `X_WP_APP_PASSWORD`.

Write the config from a runtime descriptor:

```bash
jq '{url, user: .admin.user, app_password: .admin.app_password}' \
   tools/.runtime/core-only-toolchain.json > .x-agent.json
chmod 600 .x-agent.json
```

…which produces:

```json
{
  "url": "http://127.0.0.1:9400",
  "user": "x_admin",
  "app_password": "…"
}
```

Use `.agent` instead of `.admin` to drive the server as the least-privileged identity.

Or, without a file:

```bash
export X_WP_URL=$(jq -r .url tools/.runtime/core-only-toolchain.json)
export X_WP_USER=$(jq -r .admin.user tools/.runtime/core-only-toolchain.json)
export X_WP_APP_PASSWORD=$(jq -r .admin.app_password tools/.runtime/core-only-toolchain.json)
```

`.x-agent.json` holds a live credential — keep it out of version control.

---

## Programmatic use (the proof suite)

`proof/lib/env.mjs` wraps all of the above:

```js
import { withInstance, assertStatus, assertWpError } from '../lib/env.mjs';

await withInstance(
  { profile: 'core-only', posture: 'production', plugins: ['x-companion'] },
  async (env) => {
    const res = await env.call('GET', '/x-companion/v1/blocks/library');
    assertWpError(res, { status: 403, code: 'posture_forbidden' });

    const page = await env.harnessPage();          // Playwright, Basic auth, awaits window.__ready
    const registry = await page.evaluate(() => window.__registry());

    await env.php(`<?php require_once '/wordpress/wp-load.php'; …`);  // run PHP in the sandbox
  },
);
```

`withInstance` boots **in-process** and always tears down — server, browser, runtime
files — even when the scenario throws. It uses the same
`tools/.runtime/<profile>-<posture>.json` slot as `boot.mjs`, so it refuses to start
while a detached instance of the same profile+posture is running; stop that one first,
or give the scenario a different posture.

Two things about `env.harnessPage()` that will otherwise cost you an afternoon:

- It authenticates with `extraHTTPHeaders: { Authorization: 'Basic …' }` **as well as**
  `httpCredentials`. `httpCredentials` alone does not authenticate a page navigation
  against WordPress — Chromium only replays Basic credentials after a 401 that carries
  `WWW-Authenticate`, and the WP REST API answers `rest_forbidden` 401s without one.
  Measured: `page.goto()` → 401 with `httpCredentials` only (even with `send: 'always'`),
  200 with the explicit header. Confusingly, `context.request.get()` *does* honour
  `httpCredentials`, so an API-level check will not reproduce the problem.
- The URL comes from probing `GET /x-companion/v1/harness` through the same
  pretty/`?rest_route=` logic as `env.call`, so it is correct on either permalink mode.

Playwright is pinned to **1.60.0** because that is the release whose Chromium build
(`chromium-1223`) is already in `~/Library/Caches/ms-playwright` on this machine.
Bumping it means downloading a browser.

---

## Troubleshooting

| symptom | what to do |
|---|---|
| boot fails with no obvious reason | read `tools/.runtime/<profile>-<posture>.log` |
| `Port NNNN is already in use` | `node tools/playground/stop.mjs --port NNNN` |
| stale pid, nothing serving | `node tools/playground/stop.mjs --all` (idempotent, cleans bookkeeping) |
| everything 401s | you are anonymous — pass `--runtime`/`--profile`, or check the runtime file still matches the running instance |
| a mounted plugin is not active | its entry file needs a `Plugin Name:` header; check the boot log for the `activatePlugin` step |
| `/wp-json/...` 301s | the instance is on plain permalinks; `wpcall.mjs` and `env.call` already fall back, raw `curl` needs `?rest_route=` |
| Playwright cannot find a browser | `(cd tools && npx playwright install chromium)` |

### wp-env / Docker

The spec allows either wp-env or Playground. Docker is installed on this machine but
not running, so Playground is the supported path here and the scripts do not shell out
to `wp-env`. Nothing in `boot.mjs` is Playground-specific above the `runCLI()` call —
a wp-env backend would have to reproduce the same runtime descriptor, the two mounts,
the two generated mu-plugins, and the two provisioned users.
