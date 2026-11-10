#!/usr/bin/env bash
# Task 32's rehearsal: builds deskd, gateway-shim, desk-rtc, ma-move and the Desk app's release bundle, then
# runs rig.py, which starts them all with the real desk-data helper and a real Chromium, and runs the move and the
# download end to end. README.md says what it proves. As the current user, loopback only, nothing as root.
#
#   tools/desk-move/rehearsal/rehearse.sh [--no-build] [--only move|export] [--keep]
#
# Scratch: MA_REHEARSE_DIR, default /tmp/claude-$UID/ma-rehearse. Builds take ~/work/.build.lock when it exists.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
scratch=${MA_REHEARSE_DIR:-/tmp/claude-$(id -u)/ma-rehearse}
[ "$(id -u)" != 0 ] || { echo "rehearse.sh: never as root" >&2; exit 2; }

build=1
args=()
for a in "$@"; do
  if [ "$a" = --no-build ]; then build=0; else args+=("$a"); fi
done

mkdir -p "$scratch/bin"
chmod 700 "$scratch"
touch "$scratch/.ma-rehearse"

lock() {
  if [ -e "$HOME/work/.build.lock" ]; then flock "$HOME/work/.build.lock" nice -n 10 "$@"; else nice -n 10 "$@"; fi
}

if [ "$build" = 1 ]; then
  export JAVA_HOME=${JAVA_HOME:-$HOME/.local/share/ma-desk-toolchain/jdk-21}
  export PATH="$HOME/.local/go/bin:$HOME/.local/node-v24/bin:$PATH" CGO_ENABLED=0 GOFLAGS=-mod=readonly
  echo "== deskd"
  (cd "$repo/services" && lock ./mvnw -q -DskipTests package)
  echo "== gateway-shim, desk-rtc"
  for tool in gateway-shim desk-rtc; do
    (cd "$repo/desk-rtc" && lock go build -p 1 -o "$scratch/bin/$tool" "./cmd/$tool")
  done
  echo "== ma-move"
  (cd "$repo/tools/desk-move" && lock go build -p 1 -o "$scratch/bin/ma-move" ./cmd/ma-move)
  echo "== the Desk app's release bundle"
  [ -d "$repo/web/node_modules" ] || (cd "$repo/web" && lock npm ci --no-audit --no-fund)
  (cd "$repo/web" && lock npm run -s build:release)
fi

exec nice -n 10 python3 -I "$here/rig.py" "${args[@]}"
