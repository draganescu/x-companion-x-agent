# `x-agent`

A **Claude Code plugin** — a skill plus a local MCP server — that makes an agent a precise
designer and builder of WordPress block layouts against a live instance running
[`x-companion`](../x-companion/README.md).

The model never writes block markup. It writes **JSON block trees** (Tree IR), validated against
the connected instance's real registry, compiled to canonical markup by a warm headless browser
driving that instance's own `save()` functions, and verified **numerically** against a measured
design spec. A screenshot is taken exactly once, at the end, as human acceptance evidence — never
as part of the loop.

When the instance's block vocabulary cannot express a design region, the agent scaffolds a
**dynamic** block, smoke-tests it in a local WordPress Playground, and installs it — which
immediately makes it part of that instance's vocabulary.

```
  wp_manifest ──► you write TreeIR ──► wp_validate ──► wp_compile ──► wp_verify ──► wp_screenshot
   (vocabulary)      (never markup)     (diagnostics)   (real save())   (numbers)      (once)
        ▲                                                                   │
        └───────────────── epoch moved, or a vocabulary gap ◄────────────────┘
```

## What is in the box

| | |
|---|---|
| `skills/wp-blocks/SKILL.md` | The page discipline. Eleven rules (the expression ladder, the R7 ladder with its wp-schema handoff, R11's token-only stylesheets), three worked examples with literal tool transcripts. |
| `skills/wp-blocks/references/` | `tree-ir.md` (Tree IR + every diagnostic code) and `design-spec.md` (lifting an image into the Design Spec IR). Loaded on demand. |
| `skills/wp-schema/SKILL.md` | The backend discipline. Eight rules (model before UI, everything REST-visible, bindings over bespoke rendering, the unskippable gate) and the ordering-system worked example, transcripts recorded from proof scenario P16. |
| `mcp/` | The MCP server: 23 tools over stdio. TypeScript, `@modelcontextprotocol/sdk`, Playwright, zod, adm-zip, `@google/genai` for the image pass. Nothing else. |
| `templates/dynamic-block/` | The scaffold `wp_block_scaffold` copies: `block.json` (apiVersion 3, `agent/{slug}`, `render`), `render.php`, `src/edit.js`, `package.json`. |
| `templates/theme-json/` | `DesignTokens` → `theme.json` settings emitter; a local mirror of the companion's server-side compiler, used for previews and diffs. |
| `schemas/` | Vendored copies of the contract's JSON Schemas, byte-identical to `contract/schemas/`. |
| `fixtures/` | Golden trees, invalid trees (one per diagnostic code), design specs, sample tokens. |
| `tests/` | Vitest units, a mock companion that implements the contract with zero WordPress, and opt-in live-instance scripts. |

---

## Requirements

- **Node ≥ 20**
- **Playwright with a Chromium build** — `npx playwright install chromium` inside `mcp/`
- Claude Code
- A WordPress instance running `x-companion`, and an Application Password for it

---

## Install into Claude Code

The packaging format below was verified against the live Claude Code plugin documentation, not
recalled: `.claude-plugin/plugin.json` for the manifest, a top-level `skills/` directory for skills,
and `.mcp.json` at the plugin root for MCP servers.

```
x-agent/
  .claude-plugin/
    plugin.json          <- the manifest; ONLY this file goes in .claude-plugin/
  .mcp.json              <- MCP server declaration, at the plugin ROOT
  skills/
    wp-blocks/
      SKILL.md           <- auto-discovered as skills/<name>/SKILL.md
      references/
  mcp/                   <- the server implementation
```

Build the server once, then load the plugin:

```bash
cd x-agent/mcp
npm install
npx playwright install chromium
npm run build            # -> mcp/dist/mcp/src/server.js, which .mcp.json points at

# validate the plugin, then run Claude Code with it
claude plugin validate ./x-agent
claude --plugin-dir ./x-agent
```

`.mcp.json` is deliberately boring:

```json
{
  "mcpServers": {
    "x-agent": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/dist/mcp/src/server.js"],
      "env": {
        "X_AGENT_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}",
        "X_AGENT_DATA_DIR": "${CLAUDE_PLUGIN_DATA}"
      }
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are substituted by Claude Code, so the plugin
works from any checkout path.

The skill fires on requests like *"build me a landing page on my WordPress site"*, *"turn this
Figma into a WordPress page"*, *"add a testimonial section"*, or anything mentioning Gutenberg
blocks, block themes, patterns, `theme.json` or X Companion. Check it loaded with `/skills` and
confirm the server with `/mcp` — you should see 23 tools.

Skills, commands, agents and hooks must **not** live inside `.claude-plugin/`; only `plugin.json`
does. That is a real constraint of the format, not a stylistic choice.

---

## Configuration

Connection settings resolve **per field**, highest priority first:

| # | source | shape |
|---|---|---|
| 1 | **tool arguments** | `{url, user, app_password}` on any connected tool |
| 2 | **`.x-agent.json`** in the working directory | `{"url": "...", "user": "...", "app_password": "..."}` (`site_url` is accepted as an alias for `url`) |
| 3 | **environment** | `X_WP_URL`, `X_WP_USER`, `X_WP_APP_PASSWORD` |

Per field, so `X_WP_URL` in the environment plus a `user` in `.x-agent.json` plus an
`app_password` passed as a tool argument is a valid combination. `wp_connect` reports where each
one came from:

```jsonc
← { "site_url": "https://example.com", "posture": "production", "fingerprint": "…",
    "config_sources": { "url": "env", "user": "file", "app_password": "arguments" } }
```

`config_sources` values are `arguments` | `file` | `env` | `missing`. It tells you *where*, never
*what*.

**Plain `http://` is refused** with `{code: "https_required"}` unless the host is
`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, or a `playground` host. An Application Password
is bearer-equivalent; it does not travel in clear text to anything that is not on your machine.

```bash
export X_WP_URL=https://example.com
export X_WP_USER=x_agent
export X_WP_APP_PASSWORD='xxxx xxxx xxxx xxxx xxxx xxxx'
```

### Profiling

Set `"profile": true` in `.x-agent.json` (or `X_AGENT_PROFILE=1`) and every tool call's duration
is recorded: raw events append to `x-agent-profile.jsonl` in the working directory, and
`x-agent-profile.md` beside it is rewritten after each call — per-tool counts, total/avg/max
durations, error codes, and the slowest individual calls. Only tool names, durations and error
codes are recorded — never arguments or results — so nothing sensitive can reach the report.
Delete the `.jsonl` to start a fresh report; profiling is off by default and costs nothing when
off.

Other environment variables:

| var | default | effect |
|---|---|---|
| `X_AGENT_PROFILE` | off | `1` enables per-tool-call profiling (same as `"profile": true` in `.x-agent.json`). |
| `X_AGENT_HARNESS_FALLBACK` | off | `1` enables the documented editor-injection fallback for blocks that will not register on the harness page. Also needs `X_AGENT_STORAGE_STATE`. See the companion README's *Harness fallback*. |
| `X_AGENT_STORAGE_STATE` | — | Path to a pre-recorded Playwright storage state (a logged-in browser profile) for that fallback. |
| `X_AGENT_DEBUG` | off | `1` adds stack traces to unexpected agent-side failures. |

---

## Where the credential lives

**On your machine. That is the whole design.**

- The Application Password is read from tool arguments, `.x-agent.json`, or the environment, and
  is used for exactly one thing: an `Authorization: Basic` header to the site you named.
- **There is no relay.** No hosted service sits between the agent and the instance. Nothing is
  proxied, brokered or escrowed.
- **There is no telemetry.** The server makes no network call to any host other than the WordPress
  instance you configured (plus, during `wp_block_build_test`, whatever `npm` and
  `@wp-playground/cli` fetch locally to build and smoke-test a block).
- **This package never writes the password anywhere.** Not to a cache, not to a log, not to a
  config file. The only file that may hold it is a `.x-agent.json` **you** created.
- **It is redacted on the way out.** The password is registered as a secret the moment it is
  resolved; from then on every log line, error message, URL and tool output passes through a
  redactor that scrubs registered secrets, `Authorization: Basic …` values, `https://user:pass@host`
  userinfo, and the literal `xxxx xxxx xxxx xxxx xxxx xxxx` shape WordPress uses.
- **The skill forbids echoing it** (rule R10): never into conversation, files, commits or tool
  output.

This is a deliberate architectural position, not a missing feature. Credential custody is the
thing that turns a local tool into a service you have to trust, and the division of labour here
is the other way round: the instance serves *capability*, and this machine supplies *all* the
compute — the browser, the builds, the sandbox, the model.

Rotate by deleting the application password in **Users → Profile → Application Passwords** (or
`wp user application-password delete x_agent --all`). It takes effect immediately.

---

## The 23 tools

| tool | what it does |
|---|---|
| `wp_connect` | Resolve config, probe `GET /fingerprint` and `GET /manifest`, cache the manifest by fingerprint. Returns the posture and the epoch every tree must carry. |
| `wp_disconnect` | Close the warm browser session, drop the block factory, clear all caches, forget pinned overrides. Use before switching instances. |
| `wp_manifest` | The vocabulary at the current epoch: blocks with verbatim attribute schemas, theme tokens, patterns, suites. Supports `summary:true` and `filter{name_prefix, dynamic_only}` — the full map is large. |
| `wp_patterns` | Search the instance's registered pattern corpus. The retrieval step: adapt a registered idiom before inventing a composition. |
| `wp_validate` | Validate a Tree IR against the live registry. A local schema pre-check short-circuits malformed trees with **zero** network calls. |
| `wp_compile` | **The only legitimate source of block markup.** Drives `window.__compile` on the instance's harness page in a warm Chromium, so markup comes from each block's real `save()`. |
| `wp_render` | `POST /render` — `do_blocks()` server-side, for dynamic-block output and the stylesheet URLs the oracle needs. |
| `wp_parse` | Lift existing `post_content` into a Tree IR. Returns both the verbatim parse output and the stripped tree. |
| `wp_verify` | **The oracle.** Renders markup or a URL, extracts per-element geometry, computed styles and an accessibility outline, and diffs numerically against a Design Spec IR. Use this instead of comparing screenshots. |
| `wp_screenshot` | One full-page PNG, for human acceptance at the end of a build. Deliberately not a loop primitive. |
| `wp_spec_validate` | Fully local check of a Design Spec IR: schema, box containment, content/region resolution, quantisation log coverage, responsive assumptions. Must pass before any tree is generated in from-design mode. |
| `wp_tokens_apply` | Write a `DesignTokens` set into the instance. `dry_run:true` returns the compiled `theme.json` preview and a diff for free, on any posture. Extend tier otherwise. |
| `wp_block_scaffold` | Copy `templates/dynamic-block` and interpolate slug, title, attributes and a `render_intent` comment. Always dynamic; static blocks are never generated. |
| `wp_block_build_test` | **The safety gate.** Syntax-gate every shipped script (no build step — blocks are vanilla no-build JS), boot `@wp-playground/cli`, register the block, assert it appears in `/wp/v2/block-types`, render sample attributes, emit the install zip. Nothing reaches an instance without passing here. |
| `wp_block_install` | POST the zip, refresh the manifest, reload the harness onto the new epoch, and return the new fingerprint. Extend tier. |
| `wp_snapshot` | Stream `POST /snapshot/export` to disk: theme, agent blocks, patterns, WXR content, manifest. The clone-to-sandbox and promotion-gate primitive. Extend tier. |
| `wp_pattern_save` | `POST /patterns` — saves a composed section as a registered pattern in the `agent/` namespace, so the corpus grows its own idiom and future pages assemble from it. Moves the epoch. Extend tier. |
| `wp_placeholder` | `POST /placeholder` — an idempotent 1×1 solid-colour GIF attachment per colour (hex or palette slug). The default image source while a layout is fabricated: stretch it with block attributes and record the intended picture in `metadata.imageIntent` for a later image-generation pass. Extend tier. |
| `wp_schema_scaffold` | The backend factory: generates a schema package — post types, taxonomies, REST-visible meta, workflow statuses, binding sources and nonce-guarded routes, all through core APIs — with the `intent` embedded as the implementation contract. Local. |
| `wp_schema_build_test` | THE schema gate: static policy scan (no `$wpdb`, no `eval`/`exec`), then a throwaway WordPress proves every declared registration, dispatches every route live, and diffs a post-uninstall fresh request. No zip without green. Local. |
| `wp_schema_install` | `POST /schema/install` with the gated zip. The package's model registers in-request; the returned fingerprint is the new epoch and `data_model` lists it with `source: "agent"`. Extend tier. |
| `wp_images_generate` | The first half of the image pass: find every wp_placeholder pixel carrying a `metadata.imageIntent` brief (parsed with the editor's own parser on the harness page, since `url` is a sourced attribute), generate one image per brief with a Gemini image model (Nano Banana; `gemini_api_key` in `.x-agent.json`), write JPEGs + a manifest locally. Site untouched. |
| `wp_images_apply` | The second half: upload the manifest's files to the media library (alt = the brief), swap url/id on the exact nodes, recompile through the harness, update the post. Refuses nodes that changed since the scan. |

Every tool validates input **and** output against its zod schema. Failures are always structured —
`{code, message, hint}`, never a bare throw — with codes `https_required`, `posture_forbidden`,
`harness_gap`, `epoch_mismatch`, `companion_unreachable`, `companion_error`, `invalid_input`,
`build_failed`, `smoke_failed`, plus the agent-local `not_implemented` and `internal`.

The extend-tier tools (`wp_tokens_apply`, `wp_block_install`, `wp_snapshot`, `wp_placeholder`, `wp_pattern_save`) refuse with
`posture_forbidden` against a `production` instance, by design. The answer is
`wp_snapshot` → sandbox → promote, never a way around the gate.

---

## Try it against a local Playground instance

No Docker, no MySQL, about ten seconds. Full details in [`tools/README.md`](../tools/README.md).

```bash
cd tools && npm install

# WordPress + Twenty Twenty-Five + this repo's companion plugin, mounted live
node tools/playground/boot.mjs --profile core-only --posture toolchain \
     --port 9400 --plugin ./x-companion --json

# or with a third-party suite active, to see a bigger vocabulary
node tools/playground/boot.mjs --profile core-plus-suite --posture toolchain \
     --port 9402 --plugin ./x-companion --json
```

`--json` prints the runtime descriptor, **including the generated application passwords**. Turn it
into a config file for this plugin:

```bash
jq '{url, user: .admin.user, app_password: .admin.app_password}' \
   tools/.runtime/core-only-toolchain.json > .x-agent.json
chmod 600 .x-agent.json
```

Use `.agent` instead of `.admin` to drive the server as the least-privileged identity (`x_agent`
role) — which is what a real deployment looks like, and what proves the capability gating works.

Then, in Claude Code with the plugin loaded, just ask for a page. Or poke the instance directly:

```bash
node tools/wpcall.mjs --profile core-only --posture toolchain --as agent \
     GET /x-companion/v1/fingerprint

# extend-tier refusal, from a production-posture instance
node tools/playground/boot.mjs --profile core-only --posture production --plugin ./x-companion --json
node tools/wpcall.mjs --profile core-only --posture production --as agent --allow-error \
     GET /x-companion/v1/blocks/library      # 403 posture_forbidden
```

Stop instances when you are done:

```bash
node tools/playground/stop.mjs --profile core-only --posture toolchain
```

Two things worth knowing about the sandbox: it runs on plain `http://127.0.0.1:<port>`, which this
server permits because the host is loopback; and `boot.mjs` generates an mu-plugin that lets
WordPress issue Application Passwords over non-SSL, which is **sandbox-only** and must never be
carried anywhere network-reachable.

---

## Development

```bash
cd x-agent/mcp
npm install
npm run typecheck
npm test                 # vitest: units + the mock companion, zero WordPress required
npm run list-tools       # prints all 23 tools with their full input schemas
npm run build
```

`tests/mock-companion/` implements the contract from the vendored schemas plus canned fixtures, so
the whole unit suite runs with no WordPress at all. Live-instance tests are opt-in under
`tests/live/`.

The repo-wide interop suite lives in [`proof/`](../proof/); start at `proof/PROOF-PLAN.md`.

## Licence

MIT.
