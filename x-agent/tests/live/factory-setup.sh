#!/usr/bin/env bash
#
# tests/live/factory-setup.sh — obtain the TWO instances the M5 factory live
# tests need, and describe them in a JSON state file.
#
#   ./factory-setup.sh              boot/adopt; prints the state file path
#   ./factory-setup.sh --print      print the state file path only
#   ./factory-setup.sh --stop       stop ONLY the instances this script booted
#   eval "$(./factory-setup.sh --export)"   set X_AGENT_FACTORY_LIVE=1 + state path
#
# WHY TWO INSTANCES
#   toolchain   — wp_block_install must succeed and move the epoch.
#   production  — wp_block_install must be refused with posture_forbidden, and
#                 nothing may be sent that could mutate it.
# The same plugin under both postures at once is exactly what the port split in
# tools/README.md is for.
#
# PORTS. This script only ever uses 9440-9449. Other agents own 9410-9419 and
# 9430-9439, so `stop.mjs --all` is NEVER used here — it would kill theirs.
#
# ADOPTION. boot.mjs keys one instance per (profile, posture) and refuses to
# trample a running one. When both toolchain slots are already held by another
# agent there is no slot left to boot into, so this script ADOPTS a running
# toolchain instance instead and records `booted_by_us: false`. The live test
# then cleans up after itself — it deletes the block it installed and asserts the
# fingerprint returns to its pre-install value — so an adopted instance is handed
# back byte-identical to how it was found.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
RUNTIME_DIR="$REPO_ROOT/tools/.runtime"
STATE="$HERE/.factory-instances.json"
PORT_LO=9440
PORT_HI=9449
PROFILES=("core-only" "core-plus-suite")

log() { printf '[factory-setup] %s\n' "$*" >&2; }

runtime_file() { printf '%s/%s-%s.json' "$RUNTIME_DIR" "$1" "$2"; }
pid_file() { printf '%s/%s-%s.pid' "$RUNTIME_DIR" "$1" "$2"; }

pid_alive() {
  local f; f="$(pid_file "$1" "$2")"
  [ -f "$f" ] || return 1
  local p; p="$(cat "$f" 2>/dev/null || echo)"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null
}

instance_url() { node -e "process.stdout.write(require('$1').url)" 2>/dev/null || true; }

rest_ready() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    "$1/?rest_route=/x-companion/v1/fingerprint" 2>/dev/null | grep -qE '^(200|401)$'
}

free_port() {
  local p
  for ((p = PORT_LO; p <= PORT_HI; p++)); do
    if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "$p"; return 0; fi
  done
  log "no free port in $PORT_LO-$PORT_HI"
  return 1
}

# Read one field of one posture entry out of the state file, or print nothing.
state_field() {
  [ -f "$STATE" ] || return 0
  node -e '
    try {
      const s = require(process.argv[1]);
      const v = (s[process.argv[2]] || {})[process.argv[3]];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    } catch {}
  ' "$STATE" "$1" "$2" 2>/dev/null || true
}

# Fill BOOTED_PROFILE / RUNTIME / URL / OWNED for one posture.
acquire() {
  local posture="$1"
  RUNTIME=""; URL=""; BOOTED_PROFILE=""; OWNED=false

  # 0. Re-attach to whatever a previous run of THIS script recorded, so running
  #    the script twice does not leak a second instance.
  local prev_profile prev_url prev_owned prev_runtime
  prev_profile="$(state_field "$posture" profile)"
  if [ -n "$prev_profile" ]; then
    prev_runtime="$(runtime_file "$prev_profile" "$posture")"
    prev_url="$(state_field "$posture" url)"
    prev_owned="$(state_field "$posture" booted_by_us)"
    if pid_alive "$prev_profile" "$posture" && [ -f "$prev_runtime" ] && [ -n "$prev_url" ] && rest_ready "$prev_url"; then
      log "re-attaching to the recorded $prev_profile/$posture at $prev_url"
      RUNTIME="$prev_runtime"; URL="$prev_url"; BOOTED_PROFILE="$prev_profile"
      [ "$prev_owned" = "true" ] && OWNED=true || OWNED=false
      return 0
    fi
  fi

  # 1. Boot into the first free (profile, posture) slot.
  for profile in "${PROFILES[@]}"; do
    if pid_alive "$profile" "$posture"; then continue; fi
    local port; port="$(free_port)"
    log "booting $profile/$posture on port $port with ./x-companion mounted"
    if node "$REPO_ROOT/tools/playground/boot.mjs" \
        --profile "$profile" --posture "$posture" --port "$port" \
        --plugin "$REPO_ROOT/x-companion" --json >/dev/null 2>"$RUNTIME_DIR/factory-setup-$posture.err"; then
      RUNTIME="$(runtime_file "$profile" "$posture")"
      URL="$(instance_url "$RUNTIME")"
      BOOTED_PROFILE="$profile"
      OWNED=true
      return 0
    fi
    log "boot of $profile/$posture failed; see $RUNTIME_DIR/$profile-$posture.log"
  done

  # 2. Every slot is held. Adopt a live one rather than trampling it.
  for profile in "${PROFILES[@]}"; do
    if pid_alive "$profile" "$posture"; then
      local rf url
      rf="$(runtime_file "$profile" "$posture")"
      [ -f "$rf" ] || continue
      url="$(instance_url "$rf")"
      if [ -n "$url" ] && rest_ready "$url"; then
        log "adopting the running $profile/$posture instance at $url (no free slot to boot into)"
        RUNTIME="$rf"; URL="$url"; BOOTED_PROFILE="$profile"; OWNED=false
        return 0
      fi
    fi
  done

  log "could not obtain a $posture instance"
  return 1
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

if [ "$MODE" = print ]; then
  [ -f "$STATE" ] || { log "no state file; run $0 first"; exit 1; }
  echo "$STATE"
  exit 0
fi

if [ "$MODE" = stop ]; then
  [ -f "$STATE" ] || { log "nothing recorded"; exit 0; }
  node -e '
    const s = require(process.argv[1]);
    for (const k of ["toolchain", "production"]) {
      const e = s[k];
      if (e && e.booted_by_us) process.stdout.write(e.profile + " " + e.posture + "\n");
    }
  ' "$STATE" | while read -r profile posture; do
    log "stopping $profile/$posture"
    node "$REPO_ROOT/tools/playground/stop.mjs" --profile "$profile" --posture "$posture" >&2 || true
  done
  rm -f "$STATE"
  exit 0
fi

mkdir -p "$RUNTIME_DIR"

acquire toolchain
T_RUNTIME="$RUNTIME"; T_URL="$URL"; T_PROFILE="$BOOTED_PROFILE"; T_OWNED="$OWNED"

acquire production
P_RUNTIME="$RUNTIME"; P_URL="$URL"; P_PROFILE="$BOOTED_PROFILE"; P_OWNED="$OWNED"

for u in "$T_URL" "$P_URL"; do
  for _ in $(seq 1 60); do rest_ready "$u" && break; sleep 1; done
  rest_ready "$u" || { log "REST never came up at $u"; exit 1; }
done

node -e '
  const fs = require("fs");
  const [state, tRuntime, tUrl, tProfile, tOwned, pRuntime, pUrl, pProfile, pOwned] = process.argv.slice(1);
  fs.writeFileSync(state, JSON.stringify({
    toolchain:  { profile: tProfile, posture: "toolchain",  runtime: tRuntime, url: tUrl, booted_by_us: tOwned === "true" },
    production: { profile: pProfile, posture: "production", runtime: pRuntime, url: pUrl, booted_by_us: pOwned === "true" },
  }, null, 2) + "\n");
' "$STATE" "$T_RUNTIME" "$T_URL" "$T_PROFILE" "$T_OWNED" "$P_RUNTIME" "$P_URL" "$P_PROFILE" "$P_OWNED"

log "toolchain  $T_PROFILE at $T_URL (booted_by_us=$T_OWNED)"
log "production $P_PROFILE at $P_URL (booted_by_us=$P_OWNED)"

if [ "$MODE" = export ]; then
  echo "export X_AGENT_FACTORY_LIVE=1"
  echo "export X_AGENT_FACTORY_INSTANCES='$STATE'"
else
  echo "$STATE"
fi
