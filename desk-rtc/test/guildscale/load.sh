#!/bin/bash
# The burst profile (loadtest.go) under a Guild Desk's unit limits: desk-rtc in a scope with MemoryMax and GOMEMLIMIT,
# pinned to DESK_CPUS (a c7g.xlarge has 4), guildscale on CLIENT_CPUS. Prebuilt binaries, so it runs on a box with no
# Go:
#   test/guildscale/load.sh <desk-rtc> <guildscale> <out.jsonl> [guildscale flags...]
# As root with systemd, desk-rtc runs in a transient scope (MemoryMax, MemorySwapMax=0), and the scope's memory.peak
# and oom_kill count are added to the output. Otherwise it runs with GOMEMLIMIT only, and says so.
set -u
RTC=$1 GS=$2 OUT=$3; shift 3
DESK_CPUS=${DESK_CPUS:-0-3}
CLIENT_CPUS=${CLIENT_CPUS:-4-15}
PORT=${PORT:-$((20000 + RANDOM % 10000))}
MEM=${MEMORY_MAX:-512M}
GOMEM=${GOMEMLIMIT:-384MiB}
LEVELS=${LEVELS:-600}
SETTLE=${SETTLE:-30s}
dir=$(mktemp -d /tmp/guildload.XXXXXX)
unit=grtc-load-$$
scope=()
if [ "$(id -u)" = 0 ] && command -v systemd-run >/dev/null; then
  scope=(systemd-run --quiet --scope --unit="$unit" -p MemoryMax="$MEM" -p MemorySwapMax=0 --)
fi
cleanup() { [ -n "${rtc:-}" ] && kill "$rtc" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT
"${scope[@]}" env GOMEMLIMIT="$GOMEM" GODEBUG=gctrace=1 taskset -c "$DESK_CPUS" "$RTC" \
  --socket "$dir/rtc.sock" --data-dir "$dir/rtc" --bind 127.0.0.1 --port "$PORT" 2>"$dir/rtc.log" &
rtc=$!
for _ in $(seq 100); do [ -S "$dir/rtc.sock" ] && break; kill -0 "$rtc" 2>/dev/null || break; sleep 0.1; done
[ -S "$dir/rtc.sock" ] || { echo "desk-rtc didn't start:" >&2; cat "$dir/rtc.log" >&2; exit 1; }
taskset -c "$CLIENT_CPUS" "$GS" --socket "$dir/rtc.sock" --pid "$rtc" --levels "$LEVELS" --settle "$SETTLE" \
  --gctrace "$dir/rtc.log" "$@" >"$OUT"
status=$?
alive=yes; kill -0 "$rtc" 2>/dev/null || alive=no
cg=""
if [ ${#scope[@]} -gt 0 ]; then
  cg=/sys/fs/cgroup$(systemctl show "$unit.scope" -p ControlGroup --value 2>/dev/null)
fi
peak=$(cat "$cg/memory.peak" 2>/dev/null || echo null)
ooms=$(awk '$1=="oom_kill"{print $2}' "$cg/memory.events" 2>/dev/null || echo null)
kills=$(dmesg 2>/dev/null | grep -ci 'out of memory\|oom-kill' || true)
echo "{\"unit\":\"${scope:+$MEM scope}\",\"memoryMax\":\"$MEM\",\"gomemlimit\":\"$GOMEM\",\"cgroupPeakBytes\":${peak:-null},\"cgroupOomKills\":${ooms:-null},\"dmesgOomLines\":${kills:-0},\"deskRtcAlive\":\"$alive\",\"guildscaleExit\":$status}" >>"$OUT"
cp "$dir/rtc.log" "$OUT.rtc.log"
