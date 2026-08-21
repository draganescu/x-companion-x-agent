#!/usr/bin/env bash
#
# Every x-companion test, in one command.
#
#   bash x-companion/tests/run-all.sh            boot what is needed, run everything, tear down
#   bash x-companion/tests/run-all.sh --keep     leave the instances running afterwards
#
#   X_RUNTIME_CORE_ONLY=<file> X_RUNTIME_CORE_PLUS_SUITE=<file> bash …/run-all.sh
#     run against instances someone else booted; nothing is booted or stopped
#   X_PORT_CORE_ONLY=<n> X_PORT_CORE_PLUS_SUITE=<n> bash …/run-all.sh
#     pin the ports used when this script does boot
#
# What it runs:
#
#   offline (system php, no WordPress)
#     tests/test-manifest.php     fingerprint + manifest compiler
#     tests/test-validator.php    every diagnostic code against fixtures/trees
#
#   live, core-only + toolchain
#     tests/test-install.php      block library: install, policy, rollback, delete
#     tests/test-tokens.php       design tokens + snapshot export
#
#   live, core-plus-suite + toolchain
#     tests/test-tokens.php       the same, plus the Kadence adapter
#
#   live, both
#     tests/harness.spec.ts       GET /harness in a real browser
#
# An instance that is already running and answering is reused and left alone.
# Anything this script boots, this script stops — including when a test dies.
#
# Exit code is 0 only when every suite passed.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT"

KEEP=0

for argument in "$@"; do
	case "$argument" in
		--keep) KEEP=1 ;;
		-h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "run-all.sh: unknown option $argument" >&2; exit 2 ;;
	esac
done

BOLD=$'\033[1m'
RESET=$'\033[0m'

FAILED=()
BOOTED=()

cleanup() {
	if [ "$KEEP" = "1" ] || [ ${#BOOTED[@]} -eq 0 ]; then
		return
	fi

	echo
	echo "${BOLD}-- stopping instances started by this run --${RESET}"

	for key in "${BOOTED[@]}"; do
		profile="${key%%:*}"
		posture="${key##*:}"
		node tools/playground/stop.mjs --profile "$profile" --posture "$posture" >/dev/null 2>&1
		echo "stopped $profile/$posture"
	done
}
trap cleanup EXIT

require() {
	command -v "$1" >/dev/null 2>&1 || { echo "run-all.sh needs $1 on PATH" >&2; exit 2; }
}

require php
require node
require npm

if [ ! -d tools/node_modules ]; then
	echo "${BOLD}-- installing tools/node_modules --${RESET}"
	( cd tools && npm install ) || exit 2
fi

runtime_url() {
	node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('$1','utf8')).url||'')}catch(e){}"
}

# Is the instance this descriptor points at answering?
runtime_healthy() {
	local runtime="$1" url

	[ -f "$runtime" ] || return 1
	url="$(runtime_url "$runtime")"
	[ -n "$url" ] || return 1

	[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/wp-json/")" = "200" ]
}

# Reuse a live instance, boot one otherwise.
#
# No --port is passed unless one was asked for: boot.mjs then uses its
# deterministic default and walks to the first free port, which is what keeps
# this working next to whatever else is already on the 94xx range.
ensure_instance() {
	local profile="$1" posture="$2" port="${3:-}"
	local runtime="tools/.runtime/${profile}-${posture}.json"

	if [ -f "$runtime" ]; then
		local url
		url="$(runtime_url "$runtime")"

		if runtime_healthy "$runtime"; then
			echo "reusing $profile/$posture at $url"
			return 0
		fi

		# Stale bookkeeping. Clear it by key *and* by the port the descriptor
		# claims, so a process whose pid file was overwritten is not orphaned.
		node tools/playground/stop.mjs --profile "$profile" --posture "$posture" >/dev/null 2>&1

		local stale_port="${url##*:}"
		if [ -n "$stale_port" ] && [ "$stale_port" != "$url" ]; then
			node tools/playground/stop.mjs --port "$stale_port" >/dev/null 2>&1
		fi
	fi

	echo "booting $profile/$posture ..."

	local booted=1

	if [ -n "$port" ]; then
		node tools/playground/boot.mjs --profile "$profile" --posture "$posture" --port "$port" --plugin ./x-companion --json >/dev/null && booted=0
	else
		node tools/playground/boot.mjs --profile "$profile" --posture "$posture" --plugin ./x-companion --json >/dev/null && booted=0
	fi

	if [ "$booted" != "0" ]; then
		echo "failed to boot $profile/$posture; see tools/.runtime/${profile}-${posture}.log" >&2
		return 1
	fi

	BOOTED+=("${profile}:${posture}")

	return 0
}

run_suite() {
	local name="$1"
	shift

	echo
	echo "${BOLD}=== ${name} ===${RESET}"

	if "$@"; then
		return 0
	fi

	FAILED+=("$name")

	return 1
}

echo "${BOLD}-- building block install fixtures --${RESET}"
bash x-companion/fixtures/packages/build.sh || exit 2

echo
echo "${BOLD}-- instances --${RESET}"

# X_RUNTIME_* points the whole run at a descriptor someone else owns: nothing is
# booted and nothing is stopped. That is the escape hatch for a machine where
# several agents share the tools/.runtime/<profile>-<posture> bookkeeping.
if [ -n "${X_RUNTIME_CORE_ONLY:-}" ]; then
	runtime_healthy "$X_RUNTIME_CORE_ONLY" || { echo "X_RUNTIME_CORE_ONLY=$X_RUNTIME_CORE_ONLY is not answering" >&2; exit 2; }
	CORE_ONLY_RUNTIME="$X_RUNTIME_CORE_ONLY"
	echo "using the supplied core-only descriptor $CORE_ONLY_RUNTIME"
else
	ensure_instance core-only toolchain "${X_PORT_CORE_ONLY:-}" || exit 2
	CORE_ONLY_RUNTIME="tools/.runtime/core-only-toolchain.json"
fi

if [ -n "${X_RUNTIME_CORE_PLUS_SUITE:-}" ]; then
	runtime_healthy "$X_RUNTIME_CORE_PLUS_SUITE" || { echo "X_RUNTIME_CORE_PLUS_SUITE=$X_RUNTIME_CORE_PLUS_SUITE is not answering" >&2; exit 2; }
	SUITE_RUNTIME="$X_RUNTIME_CORE_PLUS_SUITE"
	echo "using the supplied core-plus-suite descriptor $SUITE_RUNTIME"
else
	ensure_instance core-plus-suite toolchain "${X_PORT_CORE_PLUS_SUITE:-}" || exit 2
	SUITE_RUNTIME="tools/.runtime/core-plus-suite-toolchain.json"
fi

# Offline: pure functions of fixtures/registry-snapshot.json.
run_suite "manifest + fingerprint (offline)" php x-companion/tests/test-manifest.php
run_suite "validator (offline)" php x-companion/tests/test-validator.php

# Live.
run_suite "block library (core-only)" php x-companion/tests/test-install.php --runtime "$CORE_ONLY_RUNTIME"
run_suite "tokens + snapshot (core-only)" php x-companion/tests/test-tokens.php --runtime "$CORE_ONLY_RUNTIME"
run_suite "tokens + snapshot (core-plus-suite)" php x-companion/tests/test-tokens.php --runtime "$SUITE_RUNTIME"

case "$CORE_ONLY_RUNTIME" in /*) HARNESS_CORE_ONLY="$CORE_ONLY_RUNTIME" ;; *) HARNESS_CORE_ONLY="$REPO_ROOT/$CORE_ONLY_RUNTIME" ;; esac
case "$SUITE_RUNTIME"     in /*) HARNESS_SUITE="$SUITE_RUNTIME"         ;; *) HARNESS_SUITE="$REPO_ROOT/$SUITE_RUNTIME" ;; esac

X_RUNTIME_CORE_ONLY="$HARNESS_CORE_ONLY" \
X_RUNTIME_CORE_PLUS_SUITE="$HARNESS_SUITE" \
	run_suite "harness (core-only + core-plus-suite)" node --test x-companion/tests/harness.spec.ts

echo
echo "${BOLD}========================================${RESET}"

if [ ${#FAILED[@]} -eq 0 ]; then
	echo "${BOLD}PASS${RESET}  every x-companion suite is green"
	exit 0
fi

echo "${BOLD}FAIL${RESET}  ${#FAILED[@]} suite(s) failed:"
for name in "${FAILED[@]}"; do
	echo "  - $name"
done

echo
echo "If the harness suite failed to launch a browser:  ( cd tools && npx playwright install chromium )"

exit 1
