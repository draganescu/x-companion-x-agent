# x-pipeline

The deterministic, LLM-powered site compiler over the x-companion/x-agent toolchain
(`specs/pipeline.spec.json`): fixed stages S1→S9, a call budget fixed after the brief,
swappable models per task, every artifact born against a contract schema and shipped
only through the existing gates.

## Quickstart

```bash
./x-pipeline config init                      # writes pipeline.config.json; asks for a provider key if none is stored
./x-pipeline build "A one-page site for a small ceramics studio: hero, the work, workshop dates, and a mailing-list signup that stores subscribers." --new-site
```

That is the whole thing: `--new-site` boots a WordPress+x-companion Playground, wires
the connection, and the build runs S1→S9 — brief, design tokens, concurrent section
trees, block/schema factories, bounded repair, sequential installs, publish, image
pass, verification, one screenshot. The budget prints right after the brief
(`this brief costs at most N calls (S=…, B=…, P=…, I=…)`) and is hard-enforced.

The site stays up afterwards. Iterate with more builds (a rebuild **updates** the
page in place), and stop it with `./x-pipeline site stop`.

## Seeing what you have made

```bash
./x-pipeline builds        # every build, newest first, each marked LIVE or gone
./x-pipeline site status   # which Playground slots are actually answering right now
```

Playground sites are **ephemeral**: when a slot stops, its WordPress goes with it and
the build shows as `gone`. What persists is `runs/<timestamp>/` — brief, tokens, trees,
compiled markup, ledger, report, screenshot. To bring a design back, rebuild from the
same prompt; to look at what a past build produced, open its `report.md` and
`screenshot.png`.

## Removing things

```bash
# one at a time
./x-pipeline site stop --slot my-site            # stop a site (a stopped Playground is gone)
./x-pipeline site stop --slot my-site --purge    # …and delete its ~120MB WordPress directory
./x-pipeline builds rm 20260825-112451           # delete one build's artifacts

# in bulk
./x-pipeline site stop --all [--purge]           # stop every running site
./x-pipeline site prune                          # delete every STOPPED site's directory
./x-pipeline builds rm --failed                  # every build that failed or never got going
./x-pipeline builds rm --gone                    # every build whose site no longer answers
./x-pipeline builds rm --keep 5                  # keep the 5 newest, delete the rest
./x-pipeline builds rm --all
```

Safety, in every one of them: `--dry-run` shows exactly what would go and deletes
nothing; you are asked to confirm before anything is removed (`--yes` skips the
prompt, and is **required** when stdin is not a terminal — an unattended run never
deletes by default); a build whose site is still LIVE is kept back unless you pass
`--include-live`; a running slot's directory is never deleted; and deletion is
fenced to `runs/` and `tools/.runtime/sites/`, so a stray argument cannot reach
anything else.

## Commands

| command | what it does |
|---|---|
| `x-pipeline site new [--port 9430] [--slot NAME]` | boot a companion Playground on its own slot and write the connection into `.x-agent.json` |
| `x-pipeline site connect` | connect an existing x-companion site — prompts for url/user/app-password (or takes `--url --user --app-password`), verifies with `wp_connect`, warns on production posture |
| `x-pipeline site status` | every Playground slot, **probed live** (a descriptor is a claim, not proof), plus the current connection |
| `x-pipeline site use --slot NAME` | point builds at an already-running slot, using its stored credentials |
| `x-pipeline builds [--all] [--limit N]` | every site built from this checkout, newest first: title, budget, artifacts, and whether its URL still answers |
| `x-pipeline site stop [--slot NAME] [--all] [--purge]` | stop one site or all of them; `--purge` also deletes the site directory |
| `x-pipeline site prune` | delete the directories of already-stopped sites (each is ~120MB) |
| `x-pipeline builds rm …` | delete build artifacts: by run id, or `--failed` / `--gone` / `--keep N` / `--all` |
| `x-pipeline config init [--provider P] [--model M]` | write `pipeline.config.json` with the proven per-task temperatures; stores the provider key in `.x-agent.json` if missing |
| `x-pipeline build "<prompt>"` | run the compiler; `--until STAGE` stops early, `--resume RUN_DIR` continues without re-spending, `--new-site` boots a site first, `--brochure` ships composition only — the brief may declare no custom blocks and no schema packages, `--no-images` skips image generation and leaves the placeholder pixels in place, `--bespoke` (valid only with `--new-site`) authors a bespoke block theme as the ground |

## The bespoke ground (`--bespoke --new-site`)

On a fresh Playground, one metered `theme` call authors a **ThemeSpec** — a parameter
object, never files (`contract/schemas/theme-spec.schema.json`): a name the admin
sees, ONE skeleton (`stacked | split | rail`), the measure (contentSize/wideSize),
the physics (blockGap, root padding), and a preset vocabulary (shadows, gradients,
duotones). A deterministic scaffolder compiles it into a complete block theme,
`wp_theme_build_test` MEASURES its physics in a throwaway sandbox (zero root seams,
the declared measure actually clamping), and `wp_theme_install` activates it **before
S2 ever reads the instance** — so every downstream gate operates on the bespoke world
unchanged. A failed gate gets one repair of the SPEC (never the files); a second
failure aborts the run: no ground, no site. The theme is deliverable — named,
versioned, deletable from wp-admin — and never removed at run end. Budget: `T=1`
enters the base; a rail skeleton adds a third furniture call (`F=3`). Connected
sites never see any of this: their own theme remains the law.

## Real typography (the Font Library lane)

Independent of `--bespoke`: a tokens family may carry
`source: {provider: "google", family, weights}`. S3 then downloads the woff2s
agent-side (hash-pinned cache in `tools/.runtime/fonts/`, license recorded beside
them), installs them through core's own `wp/v2/font-families` + `font-faces` REST,
and the constructed `fontFace` entries ride the one `wp_tokens_apply` into global
styles — which is what makes the instance serve them from `uploads/fonts`. The
instance never calls a font CDN, at install time or page view. Never metered, never
in the ledger; the report's `## Fonts` section is the record. S9 verifies the
RENDERED font-family and fails the run when a sourced face silently fell back to
its stack.

## The style combo

Every build is driven by a pairing decided in the brief: one **artistic style**
(mood, color story, texture, imagery) and one **UI design style** (layout, density,
component shapes) chosen from the two rosters in `pipeline/styles/` — hundreds of
names, each enriched with palette/typography/composition/texture cues, and curated
to name whole visual worlds: no single widgets, no corporate design systems, no
behaviors a static compiled page cannot keep. The brief call sees
both lists shuffled (seeded from the prompt, so the same prompt always sees the same
order — determinism and `--resume` survive, position bias does not), picks by exact
name, and argues the pairing in `style.rationale`; the chosen entries' cues then ride
into every writing call. A style the prompt itself names is detected in code and
**pinned — never overridden**; only the missing half is chosen.

## Where things live

- `.x-agent.json` (repo root, gitignored, mode 0600) — site connection + provider API
  keys (`cerebras_api_key`, `gemini_api_key`, `anthropic_api_key`, `openai_api_key`;
  `gemini_api_key` also drives the image pass).
- `pipeline.config.json` (gitignored) — task → `{provider, model, temperature}` routing.
  Swapping a provider is a config edit, never a code change.
- `runs/<timestamp>/` — every artifact of a run: `brief.json`, `tokens.json`, `trees/`,
  `blocks/`, `packages/`, `images/`, `theme/` (the ThemeSpec + scaffold on bespoke
  runs), `ledger.json`, `report.md`, `screenshot.png`.
- `tools/.runtime/fonts/<family>@<version>/` — the agent-side font cache: woff2s,
  LICENSE, hash-pinned `meta.json`. Repeat builds never re-download.

## After S9: the polish pass that is not built yet

S9 verifies structure — heading outline, images loaded, every band spanning the
viewport. It does not judge design. When a polish stage exists it takes this shape,
and until then this is the method for hand-QA of a run:

1. **Diagnose the whole page first, read-only.** Enumerate every section, then read
   the rendered DOM section by section — the screenshot is the symptom, the DOM is
   the cause; never diagnose from the screenshot alone (doubled button padding
   barely shows in pixels). The complete issue list — section, root cause, exact
   fix — is the gate into fixing. No edit before the list is complete.
2. **Fix the whole batch**, no screenshots in between.
3. **Verify once.** One pass for every page except the front page, which is worth
   looping — re-diagnose what remains, capped at 5 passes.

## Tests

- Unit: `node --test pipeline/tests/*.test.mjs` (no network, no instance).
- Milestone acceptance (live Playground + real provider keys in the environment):
  `pipeline/tests/accept/m1.sh` … `m6-full.sh` — these boot their own instance on
  port 9410 and tear it down.
- Theme-factory acceptance (`specs/theme-factory.spec.json`):
  `pipeline/tests/accept/tf-m1.sh` … `tf-m6.sh` — tf-m1/tf-m4 are offline,
  tf-m2/tf-m3/tf-m5 boot dedicated slots on 9491-9493 (fake provider or no model at
  all), tf-m6 is the full-promise run and spends real provider tokens.
