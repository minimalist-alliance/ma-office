#!/bin/bash
# box.sh <bin-dir> <label> [member|guild]: the box proof of desk-rtc's ICE-TCP gate (README, "The ICE-TCP gate").
# Runs as root on a throwaway arm64 box. <bin-dir> holds arm64 desk-rtc, deskctl, gateway-shim, fake-deskd and
# gateflood. desk-rtc listens on 127.0.0.1:443 in a scope with the unit's MemoryMax and GOMEMLIMIT, pinned to CPUs 0-1
# (a c7g.large's two); the floods and clients get the rest. Flooding networks are 127.0.N.0/24 (all of 127/8 is local),
# and the real ICE-TCP client, deskctl --transport tcp, comes from 127.0.0.1, its own /24. One JSON line per attempt
# and per phase on stdout; the floods' own lines in $WORK.
set -uo pipefail
BIN=$(cd "$1" && pwd); LABEL=$2; KIND=${3:-member}
WORK=${WORK:-/var/tmp/gateflood-$LABEL-$KIND}; rm -rf "$WORK"; mkdir -p "$WORK"
TRIES=${TRIES:-30}
GW=ws://127.0.0.1:8787/v1
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; systemctl stop "gate-rtc-$LABEL.scope" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT

if [ "$KIND" = guild ]; then MEM=512M; GOMEM=384MiB; KARGS=(--desk-kind guild); else MEM=128M; GOMEM=96MiB; KARGS=(); fi
"$BIN/gateway-shim" --addr 127.0.0.1:8787 "${KARGS[@]}" > "$WORK/shim.log" 2>&1 & pids+=($!)
systemd-run --scope --unit "gate-rtc-$LABEL" -p MemoryMax=$MEM -p MemorySwapMax=0 --setenv GOMEMLIMIT=$GOMEM \
  taskset -c 0-1 "$BIN/desk-rtc" --socket "$WORK/rtc.sock" --data-dir "$WORK/rtc-data" --bind 127.0.0.1 --port 443 \
  > "$WORK/desk-rtc.log" 2>&1 & pids+=($!)
for _ in $(seq 50); do [ -S "$WORK/rtc.sock" ] && break; sleep 0.2; done
RTC=$(pgrep -f "$BIN/desk-rtc --socket $WORK/rtc.sock" | head -1)
"$BIN/fake-deskd" --rtc-sock "$WORK/rtc.sock" --api http://127.0.0.1:8787 --public-ip 127.0.0.1 "${KARGS[@]}" \
  > "$WORK/fake-deskd.log" 2>&1 & pids+=($!)
sleep 2
VERSION=$("$BIN/desk-rtc" --version 2>&1 | head -1)

ticks() { awk '{print $14+$15}' "/proc/$RTC/stat"; }
rss() { awk '/^VmRSS/{print $2}' "/proc/$RTC/status"; }
n=0
# attempt <phase> <n>: one deskctl status over ICE-TCP, as member n of the guild on a Guild Desk.
attempt() {
  local phase=$1 n=$2 extra=() out rc t0
  [ "$KIND" = guild ] && extra=(--guild g-dev000000000 --member "gm-box$n")
  t0=$(date +%s%N)
  out=$(taskset -c 2-3 "$BIN/deskctl" status --gateway $GW --transport tcp --timeout "${TIMEOUT:-15s}" --json "${extra[@]}" 2>"$WORK/deskctl-$n.err")
  rc=$?
  jq -cn --arg phase "$phase" --arg v "$VERSION" --argjson rc $rc --argjson ms $(( ($(date +%s%N) - t0) / 1000000 )) \
    --arg out "$out" --arg err "$(tail -c 300 "$WORK/deskctl-$n.err")" \
    '{phase:$phase, version:$v, ok:($rc==0), wallMs:$ms, transport:(try ($out|fromjson|.transport) catch null),
      setupMs:(try ($out|fromjson|.setupMs) catch null), err:(if $rc==0 then null else $err end)}'
}
# phase <name> <concurrent> <gateflood args...>: start the flood, let it settle, run $TRIES attempts ($concurrent at a time).
phase() {
  local name=$1 conc=$2; shift 2
  local fp=; if [ $# -gt 0 ]; then
    taskset -c 2-3 "$BIN/gateflood" --target 127.0.0.1:443 --duration 30m "$@" > "$WORK/flood-$name.jsonl" 2>&1 & fp=$!; pids+=($fp)
    sleep "${SETTLE:-6}"
  fi
  local c0 r0 t0 ok=0 tot=0 res; c0=$(ticks); t0=$(date +%s%N); r0=$(rss)
  for ((i = 0; i < TRIES; i += conc)); do
    local apids=()
    for ((j = 0; j < conc && i + j < TRIES; j++)); do n=$((n+1)); attempt "$name" $n > "$WORK/a-$name-$i-$j.json" & apids+=($!); done
    wait "${apids[@]}"
    for f in "$WORK"/a-$name-$i-*.json; do cat "$f"; tot=$((tot+1)); jq -e .ok "$f" >/dev/null && ok=$((ok+1)); done
    sleep 0.3   # sessions close before the next round, under a member's desk's 4
  done
  local secs cpu held; secs=$(( ($(date +%s%N) - t0) / 1000000 ))
  cpu=$(awk -v d=$(( $(ticks) - c0 )) -v s=$secs 'BEGIN{printf "%.2f", d / 100 / (s / 1000)}')
  held=$(tail -1 "$WORK/flood-$name.jsonl" 2>/dev/null | jq -c '[.sources[]? | {addr, open, opened, closedWithin50ms, closedLater}], .synsSent' 2>/dev/null | paste -sd' ')
  [ -n "$fp" ] && { kill "$fp" 2>/dev/null; wait "$fp" 2>/dev/null; }
  jq -cn --arg phase "$name" --arg v "$VERSION" --argjson ok $ok --argjson tot $tot --argjson cpu "$cpu" \
    --argjson rss0 "${r0:-0}" --argjson rss1 "$(rss)" --arg flood "$*" --arg held "$held" \
    '{summary:$phase, version:$v, passed:$ok, of:$tot, deskRtcCores:$cpu, rssKiB:[$rss0,$rss1], flood:$flood, floodAtEnd:$held}'
  sleep 4   # the flood's places run out
}

if [ "$KIND" = guild ]; then
  phase baseline 1
  # An office behind 127.0.0.1: 300 silent places and 10 members at a time connecting, while three networks hold their cap.
  phase flood3-office 10 --sources 127.0.1.1,127.0.2.1,127.0.3.1 --workers 430 --hold-from 127.0.0.1 --hold 300
  phase flood6 1 --sources 127.0.11.1,127.0.12.1,127.0.13.1,127.0.14.1,127.0.15.1,127.0.16.1 --workers 300
else
  phase baseline 1
  phase flood3 1 --sources 127.0.1.1,127.0.2.1,127.0.3.1 --workers 40
  # A household: 9 of its own connections held silent and 3 sessions at a time, 12 places at once, while 3 networks flood.
  phase flood3-household 3 --sources 127.0.1.1,127.0.2.1,127.0.3.1 --workers 40 --hold-from 127.0.0.1 --hold 9
  phase flood8 1 --sources 127.0.11.1,127.0.12.1,127.0.13.1,127.0.14.1,127.0.15.1,127.0.16.1,127.0.17.1,127.0.18.1 --workers 30
  phase flood8-begun 1 --sources 127.0.21.1,127.0.22.1,127.0.23.1,127.0.24.1,127.0.25.1,127.0.26.1,127.0.27.1,127.0.28.1 --workers 30 --send begun
  # Forged SYNs claiming the client's own /24, the attack on the image's nftables limits (Security's NET031-3).
  phase syn-own-net 1 --syn-net 127.0.0.0/24 --syn-rate 20000
fi
grep -h -i -E 'gate|configured' "$WORK/desk-rtc.log" | tail -5 | jq -Rc '{deskRtcLog: .}'
