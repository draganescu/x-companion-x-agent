#!/usr/bin/env bash
# proof/run-all.sh — the one command that proves the two plugins work together.
#
#   bash proof/run-all.sh            # every scenario
#   bash proof/run-all.sh P3 P6      # just these
#
# Boots real WordPress (Playground, no Docker), drives the real MCP tools
# against it, writes proof/REPORT.md, and exits non-zero if anything failed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d tools/node_modules ]; then echo "→ installing tools deps"; (cd tools && npm install --silent); fi
if [ ! -d x-agent/mcp/node_modules ]; then echo "→ installing mcp deps"; (cd x-agent/mcp && npm install --silent); fi

echo "→ stopping any instance on the proof ports"
node tools/playground/stop.mjs --port 9460 >/dev/null 2>&1 || true
node tools/playground/stop.mjs --port 9461 >/dev/null 2>&1 || true

cleanup() {
  node tools/playground/stop.mjs --port 9460 >/dev/null 2>&1 || true
  node tools/playground/stop.mjs --port 9461 >/dev/null 2>&1 || true
}
trap cleanup EXIT

exec ./x-agent/mcp/node_modules/.bin/tsx proof/run.ts "$@"
