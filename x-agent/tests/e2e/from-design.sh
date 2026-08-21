#!/usr/bin/env bash
# x-agent/tests/e2e/from-design.sh — M7 acceptance, from-design mode.
#
# Validates a lifted Design Spec IR (the pre-authored fixture that simulates the
# lift), proves every wp_spec_validate diagnostic code is reachable, then
# implements against a spec measured from a real render and asserts every
# residual difference is within tolerance or attributable to a logged
# quantization delta.
#
# Implemented as proof scenario P15.
set -euo pipefail
cd "$(dirname "$0")/../../.."
exec bash proof/run-all.sh P15
