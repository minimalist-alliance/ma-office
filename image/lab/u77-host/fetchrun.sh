#!/bin/bash
# fetchrun.sh <gen> <targetId> [<header dir>]: one template_target through the link and the fake Platform, measured (LAB ONLY):
# wall time, desk-host-upd's CPU, memory.peak and bytes read and written, the fetch's own step timings.
set -u
U=/sys/fs/cgroup/desk-host-upd
( m=0; while :; do c=$(cat $U/memory.current); [ "$c" -gt "$m" ] && m=$c && echo $m > /tmp/upd.peak; sleep 0.5; done ) & sampler=$!
c0=$(sed -n 's/^usage_usec //p' $U/cpu.stat); io0=$(cat $U/io.stat); t0=$(date +%s.%N)
cd /var/tmp/lab; python3 -I fake.py orders "[$(python3 -I order.py "$1" "$2" ${3:-})]"
st() { python3 -I -c 'import json,sys; f=json.load(open("/var/lib/desk-host/templates/fetch.json")); print(f.get("state") if f.get("target") == sys.argv[1] else "-")' "$2" 2>/dev/null; }
for i in $(seq 1 600); do case "$(st "$1" "$2")" in sealed|refused|failed|urlsWanted) break ;; esac; sleep 2; done
t1=$(date +%s.%N); c1=$(sed -n 's/^usage_usec //p' $U/cpu.stat); kill $sampler
echo "wall $(awk -v a=$t0 -v b=$t1 'BEGIN{printf "%.0f", b-a}') s; desk-host-upd cpu $(awk -v a=$c0 -v b=$c1 'BEGIN{printf "%.1f", (b-a)/1e6}') s; memory.current at most $(( $(cat /tmp/upd.peak 2>/dev/null || echo 0) >> 20 )) MiB (sampled every 0.5 s); oom_kill $(sed -n 's/^oom_kill //p' $U/memory.events)"
echo "io.stat before: $io0"; echo "io.stat after:  $(cat $U/io.stat | tr '\n' ' ')"
cat /var/lib/desk-host/templates/fetch.json; echo
cat /var/lib/desk-host/templates/state.json; echo
ls -A /srv/desk-host/templates /var/lib/desk-host/dl; df -h / /srv/desk-host | tail -2
