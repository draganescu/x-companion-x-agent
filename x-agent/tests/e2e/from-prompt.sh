#!/usr/bin/env bash
# x-agent/tests/e2e/from-prompt.sh — M7 acceptance, from-prompt mode.
#
# Boots a fresh toolchain instance and runs the skill's R5 loop end to end:
#   wp_manifest -> wp_patterns -> wp_validate -> wp_compile -> wp_verify -> wp_screenshot
# Asserts a three-section page, verify pass=true, and EXACTLY ONE screenshot.
#
# Implemented as proof scenario P14 so its evidence lands in proof/REPORT.md
# alongside everything else rather than in a second, separate place.
set -euo pipefail
cd "$(dirname "$0")/../../.."
exec bash proof/run-all.sh P14
