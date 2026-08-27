#!/usr/bin/env bash
# theme-factory M4: skeleton-aware authoring, publishing and verification —
# the milestone's own clauses are fixture-asserted (split pane declarations and
# pane-width audits, the rail's third furniture call and declared-width audit,
# stacked byte-identity with and without the skeleton option).
set -euo pipefail
cd "$(dirname "$0")/../../.."

node --test pipeline/tests/s4-sections.test.mjs pipeline/tests/s8-s9-publish.test.mjs pipeline/tests/gates.test.mjs

echo "TF-M4 ACCEPTED"
