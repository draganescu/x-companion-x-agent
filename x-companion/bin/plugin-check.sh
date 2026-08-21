#!/usr/bin/env bash
#
# Run the WordPress Plugin Check against x-companion — for real, with no Docker.
#
# WHY THIS IS NOT JUST `wp plugin check x-companion`
# --------------------------------------------------
# WP-CLI is not installed on this machine and Docker is not running, so there is
# no local WordPress to point WP-CLI at. What there IS, is @wp-playground/cli:
# WordPress + PHP compiled to WebAssembly, booted from a Blueprint in ~30 s.
#
# So this script boots a throwaway Playground site, installs `plugin-check` from
# wordpress.org into it, mounts THIS plugin directory into the site's
# wp-content/plugins/, pulls wp-cli.phar in via the Blueprint's `extraLibraries`,
# and then runs the real `wp plugin check` command inside that sandbox. The
# findings below are the findings the wordpress.org submission tooling produces —
# same plugin, same checks, same WP-CLI command.
#
# Nothing is installed on the host and nothing is left running: the sandbox is a
# single process that exits when the check finishes.
#
# USAGE
#   bash x-companion/bin/plugin-check.sh                    # distribution scan (default)
#   bash x-companion/bin/plugin-check.sh --include-dev      # also scan tests/ and bin/
#   bash x-companion/bin/plugin-check.sh --format=json
#   bash x-companion/bin/plugin-check.sh -- --checks=late_escaping
#
# Everything after a bare `--` is passed straight through to `wp plugin check`.
#
# EXIT CODES
#   0  no ERROR-severity findings
#   1  at least one ERROR-severity finding
#   2  the sandbox could not be booted (network, node, or Playground failure)
#
set -uo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" && pwd )"
PLUGIN_DIR="$( cd -- "${SCRIPT_DIR}/.." && pwd )"
PLUGIN_SLUG="$( basename "${PLUGIN_DIR}" )"
REPO_ROOT="$( cd -- "${PLUGIN_DIR}/.." && pwd )"

# Directories that exist for development and never ship to wordpress.org.
# `.git`, `vendor*` and `node_modules` are already excluded by Plugin Check itself.
DEV_DIRS="tests,bin,fixtures"

FORMAT="csv"
INCLUDE_DEV=0
KEEP_WORKDIR=0
PHP_VERSION="8.3"
WP_VERSION="latest"
PASSTHRU=()

while [ $# -gt 0 ]; do
  case "$1" in
    --format=*)      FORMAT="${1#*=}" ;;
    --include-dev)   INCLUDE_DEV=1 ;;
    --keep)          KEEP_WORKDIR=1 ;;
    --php=*)         PHP_VERSION="${1#*=}" ;;
    --wp=*)          WP_VERSION="${1#*=}" ;;
    -h|--help)       sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --)              shift; PASSTHRU=("$@"); break ;;
    *)               echo "plugin-check: unknown option '$1' (use -- to pass options to wp plugin check)" >&2; exit 2 ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || { echo "plugin-check: node is required and was not found on PATH." >&2; exit 2; }

# Prefer the pinned copy the repo already installed; fall back to a one-shot npx.
PLAYGROUND_BIN="${REPO_ROOT}/tools/node_modules/.bin/wp-playground-cli"
if [ -x "${PLAYGROUND_BIN}" ]; then
  PLAYGROUND=( "${PLAYGROUND_BIN}" )
else
  echo "plugin-check: tools/node_modules not found, falling back to npx (first run downloads @wp-playground/cli)." >&2
  PLAYGROUND=( npx --yes @wp-playground/cli@3.1.50 )
fi

WORKDIR="$( mktemp -d "${TMPDIR:-/tmp}/x-plugin-check.XXXXXX" )"
cleanup() { [ "${KEEP_WORKDIR}" -eq 1 ] || rm -rf "${WORKDIR}"; }
trap cleanup EXIT

# ---------------------------------------------------------------- blueprint --
# `extraLibraries: ["wp-cli"]` is what puts /tmp/wp-cli.phar inside the sandbox.
cat > "${WORKDIR}/blueprint.json" <<JSON
{
  "\$schema": "https://playground.wordpress.net/blueprint-schema.json",
  "description": "Throwaway site whose only job is to run WordPress Plugin Check against ${PLUGIN_SLUG}.",
  "preferredVersions": { "php": "${PHP_VERSION}", "wp": "${WP_VERSION}" },
  "extraLibraries": [ "wp-cli" ],
  "steps": [
    {
      "step": "installPlugin",
      "pluginData": { "resource": "wordpress.org/plugins", "slug": "plugin-check" },
      "options": { "activate": true, "onError": "throw", "humanReadableName": "Plugin Check" }
    }
  ]
}
JSON

# ------------------------------------------------------------- wp-cli shim --
# @wp-playground/cli has a `wp-cli` Blueprint step, but it swallows stdout, which
# is useless for a report. So we run wp-cli.phar ourselves through the sandbox's
# `php` command, which does stream stdout/stderr back to this terminal.
cat > "${WORKDIR}/run-cli.php" <<'PHP'
<?php
/**
 * Emulate a shell invocation of wp-cli.phar inside the Playground sandbox.
 *
 * SHELL_PIPE=0 keeps WP-CLI's ASCII table formatting; see wp-cli/wp-cli#1102.
 */
putenv( 'SHELL_PIPE=0' );

$args = json_decode( (string) file_get_contents( __DIR__ . '/args.json' ), true );
if ( ! is_array( $args ) ) {
	fwrite( STDERR, "run-cli.php: args.json is not a JSON array\n" );
	exit( 2 );
}

$GLOBALS['argv'] = array_merge( array( '/tmp/wp-cli.phar', '--path=/wordpress' ), $args );

defined( 'STDIN' )  || define( 'STDIN', fopen( 'php://stdin', 'rb' ) );
defined( 'STDOUT' ) || define( 'STDOUT', fopen( 'php://stdout', 'wb' ) );
defined( 'STDERR' ) || define( 'STDERR', fopen( 'php://stderr', 'wb' ) );

require '/tmp/wp-cli.phar';
PHP

# --------------------------------------------------------------- arguments --
{
  printf '["plugin","check","%s","--format=%s"' "${PLUGIN_SLUG}" "${FORMAT}"
  if [ "${INCLUDE_DEV}" -eq 0 ]; then
    printf ',"--exclude-directories=%s"' "${DEV_DIRS}"
  fi
  for extra in ${PASSTHRU+"${PASSTHRU[@]}"}; do
    printf ',"%s"' "${extra}"
  done
  printf ']\n'
} > "${WORKDIR}/args.json"

echo "plugin-check: booting a Playground sandbox (php ${PHP_VERSION}, wp ${WP_VERSION})…" >&2
if [ "${INCLUDE_DEV}" -eq 0 ]; then
  echo "plugin-check: scanning the distribution surface; excluding ${DEV_DIRS} (pass --include-dev to scan everything)." >&2
fi

REPORT="${WORKDIR}/report.txt"
STDERR_LOG="${WORKDIR}/stderr.txt"

"${PLAYGROUND[@]}" php \
  --blueprint="${WORKDIR}/blueprint.json" \
  --mount="${PLUGIN_DIR}:/wordpress/wp-content/plugins/${PLUGIN_SLUG}" \
  --mount="${WORKDIR}:/wordpress/x-plugin-check" \
  --verbosity=quiet \
  -- /wordpress/x-plugin-check/run-cli.php > "${REPORT}" 2> "${STDERR_LOG}"
BOOT_STATUS=$?

# PHP 8.3 deprecation notices from Plugin Check's bundled PHPCS are noise, not
# findings; anything else on stderr is worth seeing.
grep -v -e 'Deprecated:' -e '^$' "${STDERR_LOG}" >&2 || true

if [ "${BOOT_STATUS}" -ne 0 ] && [ ! -s "${REPORT}" ]; then
  echo "plugin-check: the Playground sandbox failed to boot or wp-cli did not run (exit ${BOOT_STATUS})." >&2
  echo "plugin-check: full stderr follows." >&2
  cat "${STDERR_LOG}" >&2
  exit 2
fi

cat "${REPORT}"

ERRORS=$( grep -c ',ERROR,'   "${REPORT}" 2>/dev/null || true )
WARNINGS=$( grep -c ',WARNING,' "${REPORT}" 2>/dev/null || true )
ERRORS=${ERRORS:-0}
WARNINGS=${WARNINGS:-0}

if [ "${FORMAT}" != "csv" ]; then
  echo "plugin-check: finished (counts are only tallied for --format=csv)." >&2
  exit 0
fi

echo >&2
echo "plugin-check: ${ERRORS} error(s), ${WARNINGS} warning(s) for '${PLUGIN_SLUG}'." >&2

[ "${ERRORS}" -eq 0 ] || exit 1
exit 0
