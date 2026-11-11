#!/bin/bash
# stoppath.sh <k>: ADR 0078 2.3 measured (LAB ONLY, test data): a cookie set 8 s before the stop, the stop (the fake Platform's stop_slot),
# the host's background swap of rel/ (desk-host after-stop -> relroot, in desk-host-upd), the start, the smoke tests beside it, Chromium,
# and what the profile kept.
set -u
k=$1; cd /var/tmp/lab; U=/sys/fs/cgroup/desk-host-upd
rstate() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print((r.get("batch") or {}).get("state"), (r.get("verify") or {}).get("phase"))' /var/lib/desk-host/slots/$k.json; }
bash steps.sh mark "$k" late8; sleep 8
( m=0; while :; do a=$(sed -n 's/^anon //p' $U/memory.stat); [ "${a:-0}" -gt "$m" ] && m=$a && echo $m > /tmp/sp.anon; sleep 0.5; done ) & smp=$!
c0=$(sed -n 's/^usage_usec //p' $U/cpu.stat); t0=$(date +%s.%N)
bash steps.sh stop "$k"; ts=$(date +%s.%N)
for i in $(seq 1 1800); do [ "$(rstate | cut -d' ' -f1)" = verify ] && break; grep -q "no batch due\|dropped\|failed" /var/log/desk-host/reroot-$k.log 2>/dev/null && [ "$i" -gt 30 ] && break; sleep 1; done
t1=$(date +%s.%N); c1=$(sed -n 's/^usage_usec //p' $U/cpu.stat); kill $smp
echo "stop $(awk -v a=$t0 -v b=$ts 'BEGIN{printf "%.1f", b-a}') s; from the stop's end to the swap $(awk -v a=$ts -v b=$t1 'BEGIN{printf "%.1f", b-a}') s; desk-host-upd CPU $(( (c1 - c0) / 1000000 )) s; anon at most $(( $(cat /tmp/sp.anon 2>/dev/null || echo 0) >> 20 )) MiB; record: $(rstate)"
grep -h "swapped in at a stop\|copied into rel\|dropped\|failed" /var/log/desk-host/reroot-$k.log | tail -6
ls -A /srv/desk-host/slots/$k/rel/ | tr '\n' ' '; echo
tw=$(date +%s.%N); bash steps.sh start "$k"; tu=$(date +%s.%N)
echo "start (stop path's first run): $(awk -v a=$tw -v b=$tu 'BEGIN{printf "%.1f", b-a}') s to running"
for i in $(seq 1 600); do grep -qE "passed at the wake|ROLLED BACK" /var/log/desk-host/switch-$k.log 2>/dev/null && break; sleep 1; done
echo "the wake's smoke tests done $(awk -v a=$tu -v b=$(date +%s.%N) 'BEGIN{printf "%.1f", b-a}') s after running:"
grep -hE "smoke test|passed at the wake|ROLLED BACK|first time" /var/log/desk-host/switch-$k.log | tail -8
bash steps.sh browser "$k" | tail -1; sleep 10; bash steps.sh read "$k"
ls -A /srv/desk-host/slots/$k/rel/ | tr '\n' ' '; echo
