#!/usr/bin/env bash
# x-agent/tests/e2e/ordering.sh — canon-factory M7 acceptance, end to end.
#
# The wp-schema discipline's worked example run for real: a fresh toolchain
# instance -> wp_schema_scaffold (orders package) -> wp_schema_build_test
# (THE GATE: sandbox model/route/uninstall probes) -> wp_schema_install
# (epoch moves; data_model lists hc_order source "agent") -> an anonymous
# nonce'd submit lands as a moderated hc_order entry with structured meta ->
# the agent-created binding source validates -> ZERO comments created.
#
# Implemented as proof scenario P16 so its evidence lands in proof/REPORT.md
# alongside everything else rather than in a second, separate place.
set -euo pipefail
cd "$(dirname "$0")/../../.."
exec bash proof/run-all.sh P16
