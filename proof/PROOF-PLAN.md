# Interop proof plan

The two plugins are only interesting if they are interoperating. "It compiles" and "unit tests
pass" prove neither side. This document defines what must be *demonstrated*, end to end, against
a real WordPress instance, with machine-checkable assertions and captured evidence.

Every scenario below produces a row in `proof/REPORT.md` with: what it proves, the command, the
assertion, and the actual observed output. A scenario that cannot run states why, in the report.

## Ground rules

1. **Real WordPress.** Every P-scenario runs against a live `@wp-playground/cli` instance with
   `x-companion` actually activated. Mock-companion is for unit tests only and proves nothing here.
2. **Real browser.** Compilation goes through Playwright driving the instance's own `/harness`
   page, executing the instance's own registered `save()` functions.
3. **No hand-written markup, anywhere.** Any expected markup is *captured* from a round trip, never
   authored. This is the domain's original sin and the suite must not commit it.
4. **Assertions are numeric or exact-string.** No "looks right".

## The scenarios

### P1 — Handshake and epoch agreement
The agent connects to the companion and both sides agree on the same opaque epoch.
- `wp_connect` → `{site_url, posture, fingerprint, wp_version, blocks_count, suites}`
- Assert the returned `fingerprint` is byte-equal to `GET /x-companion/v1/fingerprint`.
- Assert `blocks_count` equals the manifest's `counts.blocks` and the count of `wp/v2/block-types`.
**Proves:** the client speaks the companion's dialect, and the epoch is a shared value, not two guesses.

### P2 — Auth and capability gating are real
- Anonymous `GET /manifest` → 401.
- Authenticated as the `x_agent` role → 200.
- The same user against an extend-tier route on a **production-posture** instance → 403
  `posture_forbidden`, from the permission callback, *before* body parsing.
**Proves:** tiering and posture are enforced in code, not hidden in a UI.

### P3 — Tree → validate → compile → parse round trip (the core loop)
A TreeIR authored against the live manifest:
- `wp_validate` → `valid: true`, `epoch_ok: true`, zero error diagnostics.
- `wp_compile` → `all_valid: true`, markup contains `<!-- wp:`.
- Feed that markup back to `POST /parse`; assert the parsed tree's block names + attribute values
  match the input tree node-for-node (attributes compared after default-fill).
- Re-`wp_compile` the parsed-back tree; assert **byte-identical markup** (whitespace-normalised).
**Proves:** the loop is closed and idempotent. The agent's JSON and WordPress's canonical markup
are two views of one thing — and the markup came from WordPress's own `save()`, not from a model.

### P4 — The validator actually catches things the compiler would choke on
For each diagnostic code, a fixture tree → exact `{code, path}` from the live `/validate`.
Then, for the *error* fixtures, assert `wp_compile` on the same tree either fails or produces
`all_valid: false` — i.e. the validator is a real pre-filter, not decoration.
**Proves:** validation is grounded in this instance's registry, and catches errors before a round trip.

### P5 — Epoch invalidation is live, not cached optimism
- Compile successfully at epoch E1.
- Change the instance's registry (activate/deactivate a plugin, or install an agent block).
- Assert `GET /fingerprint` now returns E2 ≠ E1.
- Assert a tree still carrying `epoch: E1` gets `E_EPOCH_MISMATCH` + `epoch_ok:false` + `valid:false`,
  **and still receives the other diagnostics** in the same response.
- Assert the agent's session auto-reloads to E2 and the next compile succeeds.
**Proves:** ground truth moves and both sides notice — the whole reason epochs exist.

### P6 — Vocabulary gap ladder, end to end (the headline)
The agent hits a design need core blocks cannot express, and *extends the instance's vocabulary*:
1. `wp_block_scaffold` a dynamic block → local dir.
2. `wp_block_build_test` → builds, smoke-tests in a **local throwaway Playground**, produces a zip.
3. `wp_block_install` → `POST /blocks/install` → new fingerprint E3.
4. Assert the new block now appears in `GET /manifest` blocks map **and** in the harness's
   `window.__registry()`.
5. Author a tree *using* the new block; `wp_validate` clean at E3; `wp_compile` `all_valid: true`.
6. `POST /render` that markup; assert the rendered HTML contains the sample attribute value.
**Proves:** the two plugins form a closed loop where the agent can grow the instance's block
vocabulary and immediately use it. This is the single most load-bearing claim in both specs.

### P7 — The local safety gate is the gate
- Sabotage the scaffolded `render.php` with a syntax error.
- Assert `wp_block_build_test` reports `smoke.php_error` non-empty, produces **no zip**, and that
  **nothing was sent to the instance** (assert via the companion's request log / library listing).
- Assert the companion, by design, does no PHP linting — the gate is upstream.
**Proves:** the division of labour in the specs is honoured, not just described.

### P8 — Install policy is enforced server-side
Against a toolchain instance, `POST /blocks/install` with:
- a **static** block zip (no `render`) → 422 `block_policy`
- a zip containing a `../` path traversal entry → 422 `block_policy`
- a zip with a name outside `agent/*` → 422 `block_policy`
- a valid zip twice → second creates `.prev`; `rollback` restores the previous render output
**Proves:** the companion does not trust the agent, even though the agent is the safety gate.

### P9 — Numeric oracle, not screenshot squinting
- `wp_verify` the compiled landing markup against `fixtures/specs/hero-sample.json` → `pass: true`,
  every diff within tolerance.
- Mutate exactly one thing in the tree (hero font size, one preset step).
- Assert **exactly one** diff outside tolerance, of `kind: "font_size"`, pointing at the hero region id.
**Proves:** the oracle is sensitive and specific — it catches a one-step change and reports nothing else.

### P10 — Tokens flow through both sides to computed pixels
- `wp_tokens_apply(design-tokens.sample.json)` → companion writes user-origin global styles.
- Assert `GET /manifest` `theme_tokens.color.palette` now contains the token slugs.
- Assert the agent's local `theme-json/emitter.ts` output for the same tokens matches the
  companion's server-side result (same slugs/values) — the two compilers agree.
- Assert WordPress actually serves `--wp--preset--color--<slug>` with the token hex, and that the
  compiled block carries the `has-<slug>-background-color` class that consumes it.
- Re-render and assert `wp_verify`'s **computed** colour for a token-styled element equals the
  token hex.
**Proves:** the design-token system is one system across both plugins, all the way to rendered CSS.

### P11 — Posture wall holds from the agent side
Against a production-posture instance: `wp_tokens_apply` and `wp_block_install` each return the
exact structured `{code:'posture_forbidden', hint:'...sandbox...'}` — and no request that would
mutate ever reaches the instance.
**Proves:** R8. The agent surfaces the constraint instead of routing around it.

### P12 — Snapshot is a promotion gate
`wp_snapshot` → zip containing exactly `theme/`, `agent-blocks/`, `patterns.json`, `content.xml`,
`manifest.json`; assert `manifest.json.fingerprint` equals the live `GET /fingerprint`.
**Proves:** the "production receives artifacts, not the toolchain" pipeline has a real wire format.

### P13 — Schema drift tripwire
Assert `contract/schemas/*.json` are byte-identical to both vendored copies, and that the agent's
zod mirrors agree with the JSON Schemas on a corpus of valid/invalid documents.
**Proves:** the two codebases cannot silently diverge on shared types.

### P14 — End-to-end from-prompt demo (the R5 loop)
The skill's prescribed loop, start to finish, on a fresh instance:
`wp_manifest` → `wp_patterns` (retrieval before invention) → `wp_validate` → `wp_compile` →
`wp_verify` → `wp_screenshot`. Assert a three-section page, `pass: true`, that no registry gap is
used by the tree, and that **exactly one** screenshot was taken in the whole run.
**Proves:** the discipline in SKILL.md is executable, and the screenshot is terminal evidence
rather than a step inside the loop.

### P15 — End-to-end from-design demo (lift → implement → attribute the delta)
`wp_spec_validate` must pass before any tree exists; every `E_`/`W_` code is reachable from a
fixture; then implement against a spec measured from a real render and assert every residual
difference is within tolerance or attributable to a logged quantization delta.
**Proves:** fidelity gaps are itemised decisions, not vibes.

## Scenario ordering

Execution order is deliberately **not** numeric. P10 rewrites the site's global styles, while P9
and P15 measure geometry and computed colour against specs captured from the untouched theme — so
P10 runs last. Both passed alone and failed in sequence before this was pinned; the order lives in
`proof/scenarios.ts` with the reasoning, not in anyone's memory.

## Evidence

- `proof/REPORT.md` — generated, human-readable, one row per scenario with real output.
- `proof/results.json` — the same run in structured form; anything that renders a run reads this.
- `proof/report.html` — shareable HTML report, generated from `results.json` by
  `node proof/report-html.mjs` (so it cannot drift from what was observed).
- `proof/artifacts/` — captured markup, the single acceptance screenshot, the snapshot zip listing,
  raw JSON responses.
- `proof/run-all.sh` — one command runs everything and exits non-zero if any scenario fails.
