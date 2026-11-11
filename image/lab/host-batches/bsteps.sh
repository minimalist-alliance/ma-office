#!/bin/bash
# bsteps.sh <step> [args]: the host-batches lab's steps on the box, as root (LAB ONLY, test data only). Each prints what it saw.
#   order <order.json>                 the fake Platform sends this batch_target with every report (replacing the last batch order)
#   promote <seq> | halt <seq>         the fake Platform's batch_promote or batch_halt
#   live on|off                        the reply's updates.liveSwitches (batches stays on)
#   fetchwait <seq>                    waits for the fetch to end; desk-host-upd's memory.peak (reset first), anon at most, CPU and time
#   state                              the host's batches, the store's links, each slot's record (batch, releases, switching, verify)
#   procs <k>                          slot k's desk and sandbox PIDs and Chromium's browser process (before and after a switch)
#   wait <k> <state> [<s>]             the report says slot k's batch is <state>
set -u
LAB=/var/tmp/lab; U=/sys/fs/cgroup/desk-host-upd; L=/usr/local/lib/desk-host
fake() { python3 -I - "$@" <<'P'
import fcntl, json, os, sys
P_ = "/root/fake/state.json"
lk = open(P_ + ".lock", "w"); fcntl.flock(lk, fcntl.LOCK_EX)
s = json.load(open(P_))
what = sys.argv[1]
orders = [o for o in s.get("extraOrders", [])]
if what == "order":
    o = json.load(open(sys.argv[2]))
    orders = [x for x in orders if x.get("op") != "batch_target"] + [o]
elif what in ("promote", "halt"):
    seq = int(sys.argv[2])
    orders = [x for x in orders if x.get("op") not in ("batch_promote", "batch_halt")] + [{"op": f"batch_{what}", "id": f"batch_{what}:{seq}", "seq": seq}]
elif what == "live":
    s["updates"] = {"batches": True, "liveSwitches": sys.argv[2] == "on"}
s["extraOrders"] = orders
json.dump(s, open(P_ + ".tmp", "w")); os.replace(P_ + ".tmp", P_)
print(f"fake Platform: {what} {' '.join(sys.argv[2:])}; orders {[o.get('id') for o in orders]}; updates {s.get('updates')}")
P
}
case "$1" in
order) fake order "$2" ;;
promote|halt) fake "$1" "$2" ;;
live) fake live "$2" ;;
fetchwait)
  seq=$2; echo reset > $U/memory.peak 2>/dev/null || echo "(memory.peak can't be reset here: the peak is since the cgroup's start)"
  c0=$(sed -n 's/^usage_usec //p' $U/cpu.stat); t0=$(date +%s.%N)
  ( m=0; while :; do a=$(sed -n 's/^anon //p' $U/memory.stat); [ "${a:-0}" -gt "$m" ] && m=$a && echo $m > /tmp/f.anon; sleep 0.25; done ) & smp=$!
  for i in $(seq 1 3600); do
    st=$(python3 -I -c 'import json; print(json.load(open("/var/lib/desk-host/batch/fetch.json")).get("state",""))' 2>/dev/null)
    s2=$(python3 -I -c 'import json,sys; print(json.load(open("/var/lib/desk-host/batch/fetch.json")).get("seq"))' 2>/dev/null)
    [ "$s2" = "$seq" ] && case "$st" in installed|refused|failed) break ;; esac
    sleep 1
  done
  kill $smp; c1=$(sed -n 's/^usage_usec //p' $U/cpu.stat)
  echo "fetch of $seq: $st after $(awk -v a="$t0" -v b="$(date +%s.%N)" 'BEGIN{printf "%.1f", b-a}') s from the wait's start; desk-host-upd CPU $(( (c1 - c0) / 1000000 )) s;" \
       "memory.peak $(( $(cat $U/memory.peak) >> 20 )) MiB of memory.max $(( $(cat $U/memory.max) >> 20 )) MiB; anon at most $(( $(cat /tmp/f.anon 2>/dev/null || echo 0) >> 20 )) MiB; oom_kill $(sed -n 's/^oom_kill //p' $U/memory.events)"
  python3 -I -c 'import json; print(json.dumps(json.load(open("/var/lib/desk-host/batch/fetch.json"))))'
  grep -h "desk-host-release:" /var/log/desk-host/batch.log | tail -4 ;;
state)
  python3 -I $L/desk-host-batch state | python3 -I -c 'import json,sys; s=json.load(sys.stdin)
for k in ("current","previous","candidate"):
    e = s.get(k); print(k, None if not e else {x: e.get(x) for x in ("seq","id","trialSlot","trialPassedAt","promoteOrdered")}, None if not e else {c: v["version"] for c, v in e["components"].items()})
print("halted", [(h["seq"], h.get("reason")) for h in s.get("halted") or []], "floor", s.get("floor"))'
  python3 -I $L/desk-host-release list
  for k in 1 2; do python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("slot", sys.argv[2], r.get("state"), {x: r.get(x) for x in ("batch","releases","rolledBack","switching","verify")})' /var/lib/desk-host/slots/$k.json $k; done ;;
procs)
  k=$2
  for c in dh-desk-$k dh-svc-$k-desk-rtc dh-svc-$k-deskd dh-svc-$k-desk-agent dh-svc-$k-desk-notebook dh-svc-$k-desk-stream dh-svc-$k-desk-data; do
    printf '%s=%s ' "$c" "$(runc state $c 2>/dev/null | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])' 2>/dev/null || echo -)"
  done
  echo; echo "chromium browser pid: $(pgrep -o -u $((100000 + k * 65536 + 1102)) -f 'chromium.*--remote-debugging' 2>/dev/null || pgrep -o -f "chromium" || echo -)" ;;
wait)
  k=$2 want=$3 end=$(( $(date +%s) + ${4:-1800} ))
  while [ "$(date +%s)" -lt $end ]; do
    s=$(python3 -I $L/report.py 2>/dev/null | python3 -I -c 'import json,sys; r=json.load(sys.stdin); print([x for x in r["slots"] if x["k"]==int(sys.argv[1])][0].get("batch",{}).get("state"))' "$k")
    [ "$s" = "$want" ] && { echo "slot $k: batch $s at $(date -u +%T)"; exit 0; }
    sleep 5
  done; echo "slot $k: batch $s, not $want, at the timeout"; exit 1 ;;
*) sed -n 2,10p "$0"; exit 2 ;;
esac
