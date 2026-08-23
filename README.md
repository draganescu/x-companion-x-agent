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

## Setting up your agent

Four steps. Put the companion plugin on your WordPress site, give the agent a
key, install the agent plugin in Claude Code, and tell it where your site is.

### 1. Put the companion plugin on your WordPress site

Download `x-companion-<version>.zip` from the [Releases](../../releases) page.
In your site's admin, go to **Plugins → Add New → Upload Plugin**, choose the
zip, and activate it. (From a clone of this repo, copying the `x-companion/`
folder into `wp-content/plugins/` does the same thing.)

Out of the box the plugin only lets the agent **read** your site — list blocks,
check work, take measurements. It will not install anything or change your
theme. To let the agent build for real, add this line to `wp-config.php`:

```php
define( 'X_COMPANION_POSTURE', 'toolchain' );
```

Do that on a test site, not on the live one. The intended way to work is:
build on a copy you are willing to break, and move the finished result over.

No WordPress site at hand? This repo can start a throwaway one on your machine —
see "Trying it without a WordPress site" below. It prints everything step 4 needs.

### 2. Give the agent a key

The agent signs in to your site the same way any app does: with an Application
Password, a key you can revoke at any time without changing your real password.

In your site's admin, go to **Users → Profile → Application Passwords**. Type a
name like `x-agent`, press **Add New Application Password**, and copy the key it
shows. It looks like `abcd EFGH 1234 wxyz 5678 9012`.

The key stays on your machine. Nothing is ever sent anywhere except your own site.

### 3. Install the agent plugin in Claude Code

In Claude Code, run:

```
/plugin marketplace add draganescu/x-companion-x-agent
/plugin install x-agent@x-companion-x-agent
```

That is the whole install. The first start takes an extra minute: the plugin
finishes setting itself up and, in the background, downloads the browser it
uses to run your site's editor. There is nothing for you to install or build.

Two other ways in, if you prefer them:

- Download `x-agent-<version>.zip` from Releases, unzip it anywhere, and add
  that folder as a local plugin in Claude Code. Everything inside is already
  built, so nothing is fetched on first start except that same browser.
- Clone this repo and add the `x-agent/` folder as a local plugin. It sets
  itself up on first start exactly like the marketplace install.

### 4. Tell it where your site is

Create a file called `.x-agent.json` in the folder where you run Claude Code,
with the site address, your WordPress username, and the key from step 2:

```json
{
  "url": "https://your-site.example",
  "user": "your-wp-username",
  "app_password": "abcd EFGH 1234 wxyz 5678 9012"
}
```

If the folder is a git repository, add `.x-agent.json` to `.gitignore` — the
file contains a key.

Prefer environment variables? `X_WP_URL`, `X_WP_USER` and `X_WP_APP_PASSWORD`
do the same job. And adding `"profile": true` to the file keeps a live report
of how long every step takes, in `x-agent-profile.md` next to it.

One optional extra: add `"gemini_api_key"` (a [Google AI key](https://aistudio.google.com/apikey))
to the same file and the agent can also generate real images for the
placeholder pictures it lays out — each one already carries a written brief of
what belongs there.

That is the setup. Ask for what you want — the next section shows how that
conversation goes.

*(Changing the plugin's own code? `x-agent/mcp/dist/` is committed on purpose,
so installs never need a build step — run `npm run build` in `x-agent/mcp`
after editing `src/` and commit the result.)*

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
| `wp_placeholder` | Makes a solid-colour placeholder image for layouts built before real photos exist |
| `wp_pattern_save` | Saves a section you built as a reusable pattern on the site |
| `wp_schema_scaffold` | Starts a schema package: post types, fields, routes — the backend of a feature |
| `wp_schema_build_test` | Proves the whole model in a throwaway WordPress before anything ships |
| `wp_schema_install` | Installs the package; orders, bookings and the like become real site data |
| `wp_images_generate` | Turns each placeholder's written brief into a real image with Google's image model |
| `wp_images_apply` | Uploads those images and swaps them into the page, exactly where the placeholders were |

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

The last one starts WordPress, runs 16 checks covering both plugins working together,
and writes the results to `proof/REPORT.md`. It takes about 90 seconds.

Current result: 16 of 16 pass, 206 recorded values, on WordPress 7.1.

## What is in this repo

| Folder | Contents |
|---|---|
| `x-companion/` | The WordPress plugin |
| `x-agent/` | The Claude Code plugin: the skill and the MCP server |
| `contract/` | The agreed API format both plugins follow, and the shared JSON schemas |
| `FLOW.md` | Diagrams of how requests and processes flow between the agent and the instance |
| `tools/` | Scripts that start a throwaway WordPress for testing |
| `proof/` | Tests that check the two plugins work together, and the results |
| `specs/` | The original specifications |

## Licence

MIT. See `LICENSE`.
