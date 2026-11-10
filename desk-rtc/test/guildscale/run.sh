#!/bin/bash
# Runs guildscale against a fresh desk-rtc on loopback, and stops both. From desk-rtc/:
#   test/guildscale/run.sh [out.jsonl]
# DESK_CPUS and CLIENT_CPUS pin each side (taskset lists); desk-rtc gets 4 by default, as a c7g.xlarge has.
# GOMEMLIMIT, LEVELS, SETTLE and PORT pass through. Needs Go; builds into a temporary directory.
set -eu
out=${1:-/dev/stdout}
DESK_CPUS=${DESK_CPUS:-0-3}
CLIENT_CPUS=${CLIENT_CPUS:-4-11}
PORT=${PORT:-$((20000 + RANDOM % 10000))}
dir=$(mktemp -d /tmp/guildscale.XXXXXX)
cleanup() { [ -n "${rtc:-}" ] && kill "$rtc" 2>/dev/null; wait 2>/dev/null; rm -rf "$dir"; }
trap cleanup EXIT
CGO_ENABLED=0 go build -o "$dir/desk-rtc" ./cmd/desk-rtc
CGO_ENABLED=0 go build -o "$dir/guildscale" ./test/guildscale
env ${GOMEMLIMIT:+GOMEMLIMIT=$GOMEMLIMIT} GODEBUG=gctrace=1 taskset -c "$DESK_CPUS" "$dir/desk-rtc" \
  --socket "$dir/rtc.sock" --data-dir "$dir/rtc" --bind 127.0.0.1 --port "$PORT" 2>"$dir/rtc.log" &
rtc=$!
for _ in $(seq 100); do [ -S "$dir/rtc.sock" ] && break; kill -0 "$rtc" 2>/dev/null || break; sleep 0.1; done
[ -S "$dir/rtc.sock" ] || { echo "desk-rtc didn't start:" >&2; cat "$dir/rtc.log" >&2; exit 1; }
taskset -c "$CLIENT_CPUS" "$dir/guildscale" --socket "$dir/rtc.sock" --pid "$rtc" \
  --levels "${LEVELS:-200,600}" --settle "${SETTLE:-30s}" --gctrace "$dir/rtc.log" >"$out"
grep -c 'session closed' "$dir/rtc.log" >&2 || true
