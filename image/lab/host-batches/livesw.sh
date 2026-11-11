#!/bin/bash
# livesw.sh <k> <seq>: ADR 0078 2.2 measured (LAB ONLY, test data): a cookie set 8 s before, the slot's processes before and after, the
# live switch the link starts at the slot's idle (liveSwitches on), the report's batch state and update.holdUntil sampled every 2 s
# meanwhile, then what the profile kept (Chromium never restarted: its tabs read back without a start).
set -u
k=$1 seq=$2; cd /var/tmp/lab
rec() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); b=r.get("batch") or {}; print(b.get("seq"), b.get("state"))' /var/lib/desk-host/slots/$k.json; }
bash steps.sh mark "$k" live8; sleep 8
echo "before: $(bash bsteps.sh procs $k | tr '\n' ' ')"
t0=$(date +%s)
( while :; do python3 -I /usr/local/lib/desk-host/report.py 2>/dev/null | python3 -I -c 'import json,sys,time; r=json.load(sys.stdin); s=[x for x in r["slots"] if x["k"]==int(sys.argv[1])][0]; print(time.strftime("%T"), s["state"], s.get("batch"), (s.get("update") or {}).get("holdUntil"))' "$k"; sleep 2; done ) > /tmp/live-$k.samples 2>&1 & smp=$!
for i in $(seq 1 3600); do r=$(rec); case "$r" in "$seq current"|*rolled-back*) break ;; esac; sleep 2; done
kill $smp; echo "record: $r after $(( $(date +%s) - t0 )) s"
grep -hE "slot $k: (batch|.*smoke test|not now|copied|.*switch)" /var/log/desk-host/link-host.log | tail -12
echo "report samples: $(wc -l < /tmp/live-$k.samples); during the switch:"; grep -E "copying|switching" /tmp/live-$k.samples | sed -n '1p;$p'; grep -c "switching" /tmp/live-$k.samples
echo "after:  $(bash bsteps.sh procs $k | tr '\n' ' ')"
python3 -I sess_slot.py read "$k"
