#!/usr/bin/env bash
#
# tests/live/setup.sh — boot (or re-attach to) a live WordPress instance with the
# x-companion plugin mounted, for the M3/M4 live tests.
#
#   ./setup.sh              boot or reuse; prints the runtime descriptor path
#   ./setup.sh --stop       stop the instance this script started
#   ./setup.sh --print      print the runtime path only, do not boot
#   eval "$(./setup.sh --export)"   set X_AGENT_LIVE_RUNTIME / X_WP_* in your shell
#
# Idempotent: re-running against a live instance re-attaches instead of booting a
# second one, and never touches an instance it did not start.
#
# PORTS. This script only ever uses 9430-9439. Other agents/suites own 9410-9419
# and 9440-9449, so `stop.mjs --all` is NEVER used here — it would kill theirs.
#
# PROFILE. boot.mjs keys one instance per (profile, posture) and refuses to
# trample a running one. If core-only/toolchain is already held by somebody else,
# this script falls back to core-plus-suite/toolchain, which is still a toolchain
# instance with every core block plus Kadence. Both satisfy the live tests.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
RUNTIME_DIR="$REPO_ROOT/tools/.runtime"
STATE="$HERE/.live-instance"          # profile:posture:port we started
PORT_LO=9430
PORT_HI=9439
POSTURE=toolchain
PROFILE_PREF=("core-only" "core-plus-suite")

log() { printf '[live-setup] %s\n' "$*" >&2; }

runtime_file() { printf '%s/%s-%s.json' "$RUNTIME_DIR" "$1" "$2"; }
pid_file()     { printf '%s/%s-%s.pid'  "$RUNTIME_DIR" "$1" "$2"; }

pid_alive() {
  local f; f="$(pid_file "$1" "$2")"
  [ -f "$f" ] || return 1
  local p; p="$(cat "$f" 2>/dev/null || echo)"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null
}

instance_url() { node -e "process.stdout.write(require('$1').url)" 2>/dev/null || true; }

rest_ready() {
  local url="$1"
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url/?rest_route=/x-companion/v1/fingerprint" 2>/dev/null | grep -qE '^(200|401)$'
}

free_port() {
  local p
  for ((p=PORT_LO; p<=PORT_HI; p++)); do
    if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "$p"; return 0; fi
  done
  log "no free port in $PORT_LO-$PORT_HI"; return 1
}

do_stop() {
  [ -f "$STATE" ] || { log "nothing started by this script"; exit 0; }
  IFS=: read -r profile posture _port < "$STATE"
  log "stopping $profile/$posture"
  node "$REPO_ROOT/tools/playground/stop.mjs" --profile "$profile" --posture "$posture" >&2 || true
  rm -f "$STATE"
  exit 0
}

do_print() {
  [ -f "$STATE" ] || { log "no live instance recorded; run $0 first"; exit 1; }
  IFS=: read -r profile posture _port < "$STATE"
  runtime_file "$profile" "$posture"
  exit 0
}

MODE=boot
for arg in "$@"; do
  case "$arg" in
    --stop) MODE=stop ;;
    --print) MODE=print ;;
    --export) MODE=export ;;
    *) log "unknown argument: $arg"; exit 2 ;;
  esac
done
[ "$MODE" = stop ] && do_stop
[ "$MODE" = print ] && do_print

# ---------------------------------------------------------------- re-attach
if [ -f "$STATE" ]; then
  IFS=: read -r profile posture port < "$STATE"
  rf="$(runtime_file "$profile" "$posture")"
  if pid_alive "$profile" "$posture" && [ -f "$rf" ]; then
    url="$(instance_url "$rf")"
    if [ -n "$url" ] && rest_ready "$url"; then
      log "re-attached to $profile/$posture at $url"
      CHOSEN_PROFILE="$profile"; CHOSEN_POSTURE="$posture"; CHOSEN_RUNTIME="$rf"; CHOSEN_URL="$url"
    fi
  fi
  [ -n "${CHOSEN_RUNTIME:-}" ] || { log "recorded instance is gone; re-booting"; rm -f "$STATE"; }
fi

# --------------------------------------------------------------------- boot
if [ -z "${CHOSEN_RUNTIME:-}" ]; then
  PORT="$(free_port)"
  for profile in "${PROFILE_PREF[@]}"; do
    if pid_alive "$profile" "$POSTURE"; then
      rf="$(runtime_file "$profile" "$POSTURE")"
      url="$(instance_url "$rf")"
      case "$url" in
        *:94[3][0-9]) log "$profile/$POSTURE already runs in our port range at $url; adopting it"
                      CHOSEN_PROFILE="$profile"; CHOSEN_POSTURE="$POSTURE"; CHOSEN_RUNTIME="$rf"; CHOSEN_URL="$url"
                      printf '%s:%s:%s\n' "$profile" "$POSTURE" "${url##*:}" > "$STATE"; break ;;
        *) log "$profile/$POSTURE is held by another agent at ${url:-unknown}; trying the next profile" ; continue ;;
      esac
    fi
    log "booting $profile/$POSTURE on port $PORT with ./x-companion mounted"
    if node "$REPO_ROOT/tools/playground/boot.mjs" \
         --profile "$profile" --posture "$POSTURE" --port "$PORT" \
         --plugin "$REPO_ROOT/x-companion" --json >/dev/null 2>"$RUNTIME_DIR/live-setup.err"; then
      CHOSEN_PROFILE="$profile"; CHOSEN_POSTURE="$POSTURE"
      CHOSEN_RUNTIME="$(runtime_file "$profile" "$POSTURE")"
      CHOSEN_URL="$(instance_url "$CHOSEN_RUNTIME")"
      printf '%s:%s:%s\n' "$profile" "$POSTURE" "$PORT" > "$STATE"
      break
    fi
    log "boot of $profile/$POSTURE failed; see $RUNTIME_DIR/$profile-$POSTURE.log"
  done
fi

[ -n "${CHOSEN_RUNTIME:-}" ] || { log "could not obtain a live instance"; exit 1; }

# ------------------------------------------------------------- wait for REST
for _ in $(seq 1 60); do
  rest_ready "$CHOSEN_URL" && break
  sleep 1
done
rest_ready "$CHOSEN_URL" || { log "REST never came up at $CHOSEN_URL"; exit 1; }

FP="$(node "$REPO_ROOT/tools/wpcall.mjs" --runtime "$CHOSEN_RUNTIME" GET /x-companion/v1/fingerprint 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).fingerprint)}catch{}})')"
log "ready: $CHOSEN_PROFILE/$CHOSEN_POSTURE at $CHOSEN_URL (epoch ${FP:0:12}…)"

if [ "$MODE" = export ]; then
  echo "export X_AGENT_LIVE_RUNTIME='$CHOSEN_RUNTIME'"
  echo "export X_WP_URL='$CHOSEN_URL'"
  echo "export X_WP_USER='$(node -e "process.stdout.write(require('$CHOSEN_RUNTIME').admin.user)")'"
  echo "export X_WP_APP_PASSWORD='$(node -e "process.stdout.write(require('$CHOSEN_RUNTIME').admin.app_password)")'"
else
  echo "$CHOSEN_RUNTIME"
fi
