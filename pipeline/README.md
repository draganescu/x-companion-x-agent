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

The site stays up afterwards. Iterate with more builds, inspect with
`./x-pipeline site status`, and stop it with `./x-pipeline site stop`.

## Commands

| command | what it does |
|---|---|
| `x-pipeline site new [--port 9430] [--slot NAME]` | boot a companion Playground on its own slot and write the connection into `.x-agent.json` |
| `x-pipeline site connect` | connect an existing x-companion site — prompts for url/user/app-password (or takes `--url --user --app-password`), verifies with `wp_connect`, warns on production posture |
| `x-pipeline site status` | running Playground slots + the current connection, verified live |
| `x-pipeline site stop [--slot NAME]` | stop the Playground and clear its connection (provider keys stay) |
| `x-pipeline config init [--provider P] [--model M]` | write `pipeline.config.json` with the proven per-task temperatures; stores the provider key in `.x-agent.json` if missing |
| `x-pipeline build "<prompt>"` | run the compiler; `--until STAGE` stops early, `--resume RUN_DIR` continues without re-spending, `--new-site` boots a site first |

## Where things live

- `.x-agent.json` (repo root, gitignored, mode 0600) — site connection + provider API
  keys (`cerebras_api_key`, `gemini_api_key`, `anthropic_api_key`, `openai_api_key`;
  `gemini_api_key` also drives the image pass).
- `pipeline.config.json` (gitignored) — task → `{provider, model, temperature}` routing.
  Swapping a provider is a config edit, never a code change.
- `runs/<timestamp>/` — every artifact of a run: `brief.json`, `tokens.json`, `trees/`,
  `blocks/`, `packages/`, `images/`, `ledger.json`, `report.md`, `screenshot.png`.

## Tests

- Unit: `node --test pipeline/tests/*.test.mjs` (no network, no instance).
- Milestone acceptance (live Playground + real provider keys in the environment):
  `pipeline/tests/accept/m1.sh` … `m6-full.sh` — these boot their own instance on
  port 9410 and tear it down.
