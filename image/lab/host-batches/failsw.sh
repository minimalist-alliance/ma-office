#!/bin/bash
# failsw.sh: ADR 0078 3.1 and 3.3 (LAB ONLY): batch 7803 (TEST key: deskd 86465c6 from the store, then a desk-rtc that exits at once),
# live at the first idle slot: deskd switches and passes, desk-rtc fails its smoke test, desk-rtc then deskd go back, the slot is
# rolled-back, the batch halted on the host, and the other slot never starts it.
set -u
cd /var/tmp/lab
rec() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); b=r.get("batch") or {}; print(b.get("seq"), b.get("state"), r.get("rolledBack"))' /var/lib/desk-host/slots/$1.json; }
for k in 1 2; do echo "slot $k before: $(rec $k); $(bash bsteps.sh procs $k | tr '\n' ' ')"; done
bash bsteps.sh order /root/orders/order-7803.json; bash bsteps.sh fetchwait 7803 | head -2
t0=$(date +%s)
for i in $(seq 1 1800); do
  for k in 1 2; do case "$(rec $k)" in "7803 rolled-back"*|"7803 current"*) K=$k; break 2 ;; esac; done; sleep 2
done
echo "slot $K: $(rec $K) after $(( $(date +%s) - t0 )) s"
grep -hE "slot $K: (batch 7803|.*smoke test|.*FAILED|rolling back|.*ROLLED)" /var/log/desk-host/link-host.log | tail -12
bash bsteps.sh state
for k in 1 2; do echo "slot $k after: $(rec $k); $(bash bsteps.sh procs $k | tr '\n' ' ')"; done
sleep 60; echo "a minute later: slot $((3 - K)) $(rec $((3 - K))); batch states in the report: $(python3 -I /usr/local/lib/desk-host/report.py | python3 -I -c 'import json,sys; r=json.load(sys.stdin); print([(s["k"], s.get("batch")) for s in r["slots"][:2]], r["batches"]["halted"])')"
python3 -I sess_slot.py read "$K"
/usr/local/lib/desk-host/desk-host-check --allow-verify-access --only releases,svc-spec
