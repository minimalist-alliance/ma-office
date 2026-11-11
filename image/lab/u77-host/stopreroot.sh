#!/bin/bash
# stopreroot.sh <k>: a re-root at a stop, measured (LAB ONLY, test data): a cookie set 8 s before the stop, the stop (the fake
# Platform's stop_slot), the host's background re-root onto the current generation in desk-host-upd (its time, CPU, memory, I/O),
# then the start and Chromium, and what the profile kept: cookies (the late one too), tabs, localStorage, the saved password.
set -u
k=$1; cd /var/tmp/lab; U=/sys/fs/cgroup/desk-host-upd
fmt0=$(python3 -I fixtures.py fmt "$k" | cut -c1-16)
bash steps.sh mark "$k" late8; sleep 8
( m=0; while :; do a=$(sed -n 's/^anon //p' $U/memory.stat); [ "${a:-0}" -gt "$m" ] && m=$a && echo $m > /tmp/rr.anon; sleep 0.5; done ) & smp=$!
c0=$(sed -n 's/^usage_usec //p' $U/cpu.stat); io0=$(tr '\n' ' ' < $U/io.stat); t0=$(date +%s)
bash steps.sh stop "$k"
ts=$(date +%s)
for i in $(seq 1 1800); do
  pgrep -f "^/bin/bash /usr/local/lib/desk-host/desk-host reroot $k" >/dev/null || { [ "$i" -gt 4 ] && break; }
  sleep 1
done
t1=$(date +%s); c1=$(sed -n 's/^usage_usec //p' $U/cpu.stat); kill $smp
echo "stop $((ts - t0)) s; the re-root after it $((t1 - ts)) s; desk-host-upd CPU $(( (c1 - c0) / 1000000 )) s; anon at most $(( $(cat /tmp/rr.anon 2>/dev/null || echo 0) >> 20 )) MiB; oom_kill $(sed -n 's/^oom_kill //p' $U/memory.events)"
echo "io.stat before: $io0"; echo "io.stat after:  $(tr '\n' ' ' < $U/io.stat)"
tail -3 /var/log/desk-host/reroot-$k.log
echo "trees left: [$(ls -d /srv/desk-host/slots/.$k.* 2>/dev/null | tr '\n' ' ')]"
bash steps.sh slot "$k"
bash steps.sh start "$k"; bash steps.sh browser "$k"; sleep 10
bash steps.sh read "$k"
echo "format record: before $fmt0, after $(python3 -I fixtures.py fmt "$k" | cut -c1-16)"
/usr/local/lib/desk-host/desk-host-check --allow-verify-access --only templates,svc-dns
