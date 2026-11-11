#!/bin/bash
# image/host/verify-wave.sh real|mutation: Platform's reclaim wave on a shared host (2026-11-11: six slots prepared again at once filled
# two 0.1.9 hosts' 36 GB stores, and desks placed after it failed with ENOSPC). verify.sh and verify-port.sh run it on the host as root,
# last, each mode once (R "sudo bash -s -- <mode>" < verify-wave.sh):
# - the link stopped (started again at the end), every running desk stopped, and every slot given a root first, one at a time;
# - the store filled (a fallocated file) until it holds one root, the prepare's spare (PREP_SPARE_MB) and 256 MiB more: room for one
#   copy in flight beside the slots, the most the store is sized for;
# - six `desk-host prepare` at once (SlotsPerHost of them), the store's use sampled every 0.2 s.
# real: "WAVE PASS" when each prepare succeeded, or refused for room (75, "refused for room") and then, the filler gone, succeeded
#   alone; no output says ENOSPC; no .<k>.new or .<k>.old tree is left; every slot ends with a fresh root and record; the store never
#   filled; and no two prepares copied at once (their tar and cp processes counted every 0.2 s).
# mutation: the same wave with the prepare 0.1.11 had, in a copy of desk-host (prep_old_root, prep_turn and prep_drop taken out: the old
#   root deleted after the rename, no copy turn, no room check, a failed copy's tree left) must fail it ("MUTATED WAVE FAIL"); then the
#   filler goes and the real desk-host prepares every slot again one at a time, which removes what the mutation left ("RESTORE PASS").
# Exit 2 when the step itself couldn't run; else 0, and the lines say.
set -u
MODE=${1:?usage: verify-wave.sh real|mutation}
DH=/srv/desk-host; S=$DH/slots; REC=/var/lib/desk-host/slots; DHC=/usr/local/lib/desk-host/desk-host; W=/root/wave-$MODE; FILL=$DH/.verify-wave-fill
gb() { awk -v b="$1" 'BEGIN {printf "%.2f", b / 1e9}'; }
conf() { sed -n "s/^$1=//p" /etc/desk-host/desk-host.conf 2>/dev/null | tail -1 | tr -d '"'; }
SPARE=$(conf PREP_SPARE_MB); SPARE=${SPARE:-512}
N=$(python3 -I -c 'import json; h = json.load(open("/var/lib/desk-host/hosting.json")); print(h.get("slotsPerHost") or h["desksPerHost"])')
rm -rf "$W"; mkdir -p "$W"
LINK=$(systemctl is-active desk-host-link)   # started again at the end only if it ran (a lab host keeps it stopped)
trap 'rm -f "$FILL"; [ "$LINK" = active ] && systemctl start desk-host-link' EXIT
systemctl stop desk-host-link
# the link stops alone (KillMode=process): a start, stop or class change it had begun runs on, and finishes after this line. They're waited
# for before any desk is stopped, so no desk starts during the step (verify-port.sh's first run on 0.1.11.1: the fake wanted slots 1 and 2
# running, the link restarted after the real wave began their starts, and those desks came up during the mutation's wave)
for _ in $(seq 1 600); do pgrep -f 'desk-host (up|stop|class|restart|prepare) [0-9]' >/dev/null || break; sleep 1; done
pgrep -af 'desk-host (up|stop|class|restart|prepare) [0-9]' && { echo "the link's own desk-host runs didn't end in 600 s"; exit 2; }
for k in $(seq 1 "$N"); do runc state dh-desk-$k >/dev/null 2>&1 && { desk-host stop $k >/dev/null 2>&1 || echo "slot $k: its stop failed"; }; done
for k in $(seq 1 "$N"); do
  [ -d $S/$k/rootfs ] && continue
  desk-host prepare $k > $W/first.$k 2>&1 || { echo "slot $k: its first prepare failed:"; cat $W/first.$k; exit 2; }
done

DHX=$DHC
if [ "$MODE" = mutation ]; then   # 0.1.11's prepare: the three fixes taken out of a copy, just before the command dispatch
  DHX=$W/desk-host-0.1.11-prepare
  python3 -I - "$DHC" "$DHX" <<'P' || exit 2
import sys
s = open(sys.argv[1]).read()
anchor = "\ncmd=${1:-}; shift || true\n"
assert s.count(anchor) == 1 and all(f"\n{f}() {{" in s for f in ("prep_old_root", "prep_turn", "prep_drop")), "desk-host isn't as this mutation expects"
s = s.replace(anchor, "\nprep_old_root() { :; }; prep_turn() { :; }; prep_drop() { exec 7>&-; PREP_NEW=\"\"; }   # verify-wave.sh: 0.1.11's prepare" + anchor)
open(sys.argv[2], "w").write(s)
P
  chmod 700 "$DHX"
fi

R=$(for k in $(seq 1 "$N"); do du -s -B1 $S/$k | cut -f1; done | sort -n | head -1)   # a root and its rel/ (the smallest: a fresh one)
size=$(df -B1 --output=size $DH | tail -1); avail=$(df -B1 --output=avail $DH | tail -1)
fill=$((avail - R - SPARE * 1048576 - 268435456))
if [ "${WAVE_FILL:-1}" = 1 ]; then   # WAVE_FILL=0: the store as it is (the host lab's wave on a store of Platform's size)
  [ "$fill" -gt 0 ] || { echo "the store ($(gb "$avail") GB free) has no room to fill"; exit 2; }
  fallocate -l "$fill" "$FILL" || exit 2
else
  fill=0
fi
echo "store $(gb "$size") GB; a root with its rel/ $(gb "$R") GB; filled with $(gb "$fill") GB, so $(gb "$(df -B1 --output=avail $DH | tail -1)") GB free before the wave"
# every 0.2 s: the store's use and free space, and how many prepares are copying (a tar or cp into a .<k>.new tree)
( while :; do echo "$(df -B1 --output=used,avail $DH | tail -1) $(pgrep -fc "^(tar|cp) .*$S/\.[0-9]+\.new\.[0-9]+/(rootfs|rel/)")"; sleep 0.2; done ) > $W/df.log 2>/dev/null & mon=$!
declare -A pid rc
t0=$(date +%s)
for k in $(seq 1 "$N"); do "$DHX" prepare $k > $W/out.$k 2>&1 & pid[$k]=$!; done
for k in $(seq 1 "$N"); do wait "${pid[$k]}"; rc[$k]=$?; done
kill $mon 2>/dev/null; wait $mon 2>/dev/null
peak=$(sort -n -k1 $W/df.log | tail -1 | awk '{print $1}'); low=$(sort -n -k2 $W/df.log | head -1 | awk '{print $2}'); most=$(sort -n -k3 $W/df.log | tail -1 | awk '{print $3}')
echo "the wave: $N prepares at once, done in $(( $(date +%s) - t0 )) s; the store's peak use $(gb "$peak") of $(gb "$size") GB, its least free $(gb "$low") GB; at most $most copying at once ($(wc -l < $W/df.log) samples)"
for k in $(seq 1 "$N"); do
  echo "  slot $k: exit ${rc[$k]}: $(grep -hoE 'room for a root.*|refused for room.*|prepared fresh .* in [0-9]+ s|No space left.*|failed.*' $W/out.$k | tr '\n' ' ' | cut -c1-260)"
done
enospc=$(grep -l 'No space left' $W/out.* 2>/dev/null | xargs -r -n1 basename | tr '\n' ' ')
partials=$(ls -A $S | grep -E '^\.[0-9]+\.(new|old)\.' | tr '\n' ' ')
echo "ENOSPC in: [${enospc}]; partial trees after the wave: [${partials}]"
bad=0
for k in $(seq 1 "$N"); do
  case "${rc[$k]}" in 0) ;; 75) grep -q "slot $k: refused for room" $W/out.$k || bad=1 ;; *) bad=1 ;; esac
done
[ -z "$enospc" ] && [ -z "$partials" ] && [ "$low" -gt 0 ] || bad=1
[ "$MODE" = mutation ] || [ "${most:-9}" -le 1 ] || bad=1   # the copy turn (the mutation has none, and may copy six at once)
rm -f "$FILL"

if [ "$MODE" = mutation ]; then
  [ "$bad" = 1 ] && echo "MUTATED WAVE FAIL (as it must)" || echo "MUTATED WAVE PASS (it must fail)"
  ok=1
  for k in $(seq 1 "$N"); do desk-host prepare $k > $W/restore.$k 2>&1 || { echo "  restore: slot $k exit $?: $(tail -2 $W/restore.$k | tr '\n' ' ')"; ok=0; }; done
  left=$(ls -A $S | grep -E '^\.[0-9]+\.(new|old)\.' | tr '\n' ' ')
  echo "restored: every slot prepared again one at a time by the real desk-host; partial trees left: [$left]"
  [ -z "$left" ] || ok=0
  [ "$ok" = 1 ] && echo "RESTORE PASS" || echo "RESTORE FAIL"
  exit 0
fi

for k in $(seq 1 "$N"); do   # the refused, alone, with the filler gone
  [ "${rc[$k]}" = 75 ] || continue
  desk-host prepare $k > $W/retry.$k 2>&1; r=$?
  echo "  slot $k retried alone: exit $r: $(grep -hoE 'prepared fresh .* in [0-9]+ s|refused.*' $W/retry.$k | head -1)"
  [ "$r" = 0 ] || bad=1
done
# each prepare's turn, from its room line to its "prepared fresh" line (log times, to the second: evidence; the sampled count above decides)
python3 -I - "$W" "$N" <<'P' 
import re, sys
w, n = sys.argv[1], int(sys.argv[2])
sec = lambda t: int(t[:2]) * 3600 + int(t[3:5]) * 60 + int(t[6:8])
spans = []
for k in range(1, n + 1):
    txt = open(f"{w}/out.{k}").read()
    a = re.search(r"\[desk-host (\d\d:\d\d:\d\d)\] slot \d+: room for a root", txt)
    b = re.search(r"\[desk-host (\d\d:\d\d:\d\d)\] slot \d+: prepared fresh", txt)
    if a and b:
        spans.append((sec(a.group(1)), sec(b.group(1)), k))
spans.sort()
over = [(x[2], y[2]) for x, y in zip(spans, spans[1:]) if y[0] < x[1]]
print("turns by the log: " + ", ".join(f"slot {k} {a % 86400 // 3600:02d}:{a % 3600 // 60:02d}:{a % 60:02d}-{b % 3600 // 60:02d}:{b % 60:02d}" for a, b, k in spans)
      + (f"; overlapping to the second: {over}" if over else ""))
P
python3 -I - "$REC" "$S" "$N" <<'P' || bad=1
import json, os, sys
rec, s, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
bad = [k for k in range(1, n + 1) if not os.path.isdir(f"{s}/{k}/rootfs") or json.load(open(f"{rec}/{k}.json")).get("state") != "fresh"]
print(f"every slot fresh with a root: {'yes' if not bad else f'NO, slots {bad}'}")
sys.exit(1 if bad else 0)
P
left=$(ls -A $S | grep -E '^\.[0-9]+\.(new|old)\.' | tr '\n' ' ')
[ -z "$left" ] || { echo "partial trees at the end: [$left]"; bad=1; }
[ "$bad" = 0 ] && echo "WAVE PASS" || echo "WAVE FAIL"
exit 0
