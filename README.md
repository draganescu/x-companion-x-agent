# x-companion + x-agent

Two plugins that let an AI agent build WordPress pages correctly.

- **`x-companion/`** is a WordPress plugin. You install it on a WordPress site.
- **`x-agent/`** is a Claude Code plugin. You install it on your own machine.

They talk to each other over the WordPress REST API.

## What problem this solves

WordPress stores block content as HTML with JSON inside comment markers, like this:

```html
<!-- wp:paragraph {"backgroundColor":"accent"} -->
<p class="has-accent-background-color has-background">Hello</p>
<!-- /wp:paragraph -->
```

The exact format is decided by each block's JavaScript `save()` function. If an AI
writes this text by hand it usually gets it slightly wrong, and the WordPress editor
then shows a "this block contains unexpected content" error.

So the agent never writes that text. Instead it writes plain JSON:

```json
{ "name": "core/paragraph", "attributes": { "content": "Hello", "backgroundColor": "accent" } }
```

The companion plugin checks that JSON against the blocks your site actually has, and a
headless browser then runs your site's own `save()` functions to turn the JSON into
markup. The output is correct because WordPress produced it, not the model.

## Requirements

- Node.js 20 or newer
- PHP 8.1 or newer (for the WordPress plugin)
- WordPress 6.5 or newer on the target site
- A WordPress user with an Application Password

Docker is not required.

## Setup

### 1. Install the WordPress plugin

Copy the `x-companion/` folder into `wp-content/plugins/` on your site and activate it.

By default the plugin runs in **production mode**, which means it will only read from
your site. It will not install blocks or change your theme settings. To allow those
things, add this to `wp-config.php` on a test site:

```php
define( 'X_COMPANION_POSTURE', 'toolchain' );
```

Only do that on a site you are willing to break. See `x-companion/README.md`.

### 2. Create an Application Password

In WordPress: **Users → your user → Application Passwords**. Give it a name and copy
the generated password. It looks like `abcd EFGH 1234 wxyz 5678 9012`.

The password stays on your machine. Nothing is sent anywhere except your own site.

### 3. Install the Claude Code plugin

```bash
cd x-agent/mcp
npm install
npx playwright install chromium
```

Then point it at your site. Create a file called `.x-agent.json` in the folder where
you run Claude Code:

```json
{
  "url": "https://your-site.example",
  "user": "your-wp-username",
  "app_password": "abcd EFGH 1234 wxyz 5678 9012"
}
```

You can use the environment variables `X_WP_URL`, `X_WP_USER` and
`X_WP_APP_PASSWORD` instead if you prefer.

Add `.x-agent.json` to your `.gitignore`. It contains a password.

Finally, add the `x-agent/` folder as a plugin in Claude Code. It provides one skill
(`wp-blocks`) and one MCP server with 16 tools.

## Usage

Once it is connected, ask Claude Code for what you want in normal language:

> Build a three-section landing page on my WordPress site.

> Turn this screenshot into a WordPress page.

> Add a testimonial section. If no block fits, make one.

The skill tells the agent how to do this properly. Behind the scenes it:

1. Reads the list of blocks your site actually has.
2. Looks at your existing patterns before inventing a new layout.
3. Writes a JSON block tree.
4. Checks it against your site and fixes any errors.
5. Compiles it to real markup using your site's own code.
6. Measures the result and compares the numbers against what was asked for.
7. Takes one screenshot at the end so you can look at it.

You can also call the tools directly. The main ones:

| Tool | What it does |
|---|---|
| `wp_connect` | Connects and reports what the site has |
| `wp_manifest` | Lists every block, with its real attributes |
| `wp_patterns` | Lists the site's existing patterns |
| `wp_validate` | Checks a JSON block tree for errors |
| `wp_compile` | Turns a JSON block tree into WordPress markup |
| `wp_verify` | Measures the rendered result in pixels |
| `wp_screenshot` | Takes one picture for you to look at |
| `wp_block_scaffold` | Starts a new custom block |
| `wp_block_build_test` | Builds and tests it in a throwaway WordPress |
| `wp_block_install` | Installs it on your site |
| `wp_tokens_apply` | Writes colours, spacing and fonts to your theme |
| `wp_snapshot` | Exports the site as a zip |

The full list is in `x-agent/README.md`.

## Two things to know

**Nothing you make is guessed.** The agent only uses blocks your site really has. If
you activate or deactivate a plugin, the site's "fingerprint" changes, and any work
based on the old list is rejected instead of silently breaking.

**Production sites are read-only by default.** Installing blocks and changing theme
settings only work on a site set to `toolchain` mode. On a normal site those requests
are refused. The intended way to work is to make changes on a test copy, then export
them with `wp_snapshot`.

## Trying it without a WordPress site

The repo can start a throwaway WordPress on your machine. No Docker, no setup.

```bash
cd tools && npm install && cd ..

node tools/playground/boot.mjs --profile core-only --posture toolchain \
  --port 9400 --plugin ./x-companion --json
```

That prints a URL, a username and an Application Password you can put straight into
`.x-agent.json`. Stop it with:

```bash
node tools/playground/stop.mjs --port 9400
```

## Running the tests

```bash
# WordPress plugin, no WordPress needed
php x-companion/tests/test-validator.php
php x-companion/tests/test-manifest.php

# WordPress plugin, against a real site it starts itself
bash x-companion/tests/run-all.sh

# Claude Code plugin
cd x-agent/mcp && npm test

# Both plugins together, against a real WordPress site
bash proof/run-all.sh
```

The last one starts WordPress, runs 15 checks covering both plugins working together,
and writes the results to `proof/REPORT.md`. It takes about 90 seconds.

Current result: 15 of 15 pass, 187 recorded values, on WordPress 7.1.

## What is in this repo

| Folder | Contents |
|---|---|
| `x-companion/` | The WordPress plugin |
| `x-agent/` | The Claude Code plugin: the skill and the MCP server |
| `contract/` | The agreed API format both plugins follow, and the shared JSON schemas |
| `tools/` | Scripts that start a throwaway WordPress for testing |
| `proof/` | Tests that check the two plugins work together, and the results |
| `specs/` | The original specifications |

## Licence

MIT. See `LICENSE`.
